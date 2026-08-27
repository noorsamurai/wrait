import { createHash } from "node:crypto";
import {
  validateCredentials, hashPassword, verifyPassword,
  createSession, resolveSession, destroySession, newId,
} from "./auth.js";
import { toUser, findUserByUsername, findUserById, officeInfo, listUsers } from "./store.js";
import { initUpload, getFile, receivedChunks, writeChunk, openDownload, HttpError } from "./files.js";
import { initialsOf, MAX_FILE_BYTES } from "@lokalen/protocol";

const JSON_LIMIT = 64 * 1024;
const CHUNK_LIMIT = 1024 * 1024; // one 512 KiB chunk plus headroom

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function fail(res, err) {
  if (err instanceof HttpError) return json(res, err.status, { error: err.code, message: err.message });
  console.error("[http]", err);
  return json(res, 500, { error: "internal", message: "Något gick fel på servern." });
}

async function readBody(req, limit) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limit) throw new HttpError(413, "too_large", "Förfrågan är för stor.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(req) {
  const raw = await readBody(req, JSON_LIMIT);
  if (raw.length === 0) return {};
  try {
    return JSON.parse(raw.toString("utf8"));
  } catch {
    throw new HttpError(400, "bad_json", "Ogiltigt JSON-innehåll.");
  }
}

function bearer(req) {
  const header = req.headers.authorization || "";
  return header.startsWith("Bearer ") ? header.slice(7) : null;
}

function requireUser(db, req) {
  const user = resolveSession(db, bearer(req));
  if (!user) throw new HttpError(401, "unauthorized", "Logga in för att fortsätta.");
  return user;
}

/**
 * Builds the request handler.
 *
 * `hub` is injected so an upload completing can push the roster/message events
 * that the WebSocket layer owns.
 */
export function createRequestHandler({ db, dataDir, hub, allowOrigin = "*" }) {
  return async function handle(req, res) {
    // The desktop and iOS shells load the UI from a custom scheme, so the API
    // is always cross-origin from the webview's point of view.
    res.setHeader("access-control-allow-origin", allowOrigin);
    res.setHeader("access-control-allow-headers", "authorization, content-type");
    res.setHeader("access-control-allow-methods", "GET, POST, PUT, OPTIONS");
    res.setHeader("vary", "origin");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      return res.end();
    }

    const url = new URL(req.url, "http://localhost");
    const path = url.pathname;

    try {
      if (path === "/api/health") return json(res, 200, { ok: true, users: hub.roster().length });

      // Public: a client needs to know which sign-in screen to show before it
      // has any credentials.
      if (path === "/api/office" && req.method === "GET") return json(res, 200, officeInfo(db));

      if (path === "/api/join" && req.method === "POST") return await join(req, res);

      if (path === "/api/register" && req.method === "POST") return await register(req, res);
      if (path === "/api/login" && req.method === "POST") return await login(req, res);
      if (path === "/api/logout" && req.method === "POST") {
        destroySession(db, bearer(req));
        return json(res, 200, { ok: true });
      }
      if (path === "/api/me" && req.method === "GET") {
        const user = requireUser(db, req);
        return json(res, 200, toUser(user, hub.presenceOf(user.id)));
      }
      if (path === "/api/directory" && req.method === "GET") {
        requireUser(db, req);
        return json(res, 200, { users: hub.roster() });
      }

      if (path === "/api/files/init" && req.method === "POST") return await fileInit(req, res);

      const chunkMatch = path.match(/^\/api\/files\/([^/]+)\/chunk$/);
      if (chunkMatch && req.method === "PUT") return await fileChunk(req, res, chunkMatch[1], url);

      const downloadMatch = path.match(/^\/api\/files\/([^/]+)$/);
      if (downloadMatch && req.method === "GET") return await fileDownload(req, res, downloadMatch[1], url);

      return json(res, 404, { error: "not_found", message: "Okänd adress." });
    } catch (err) {
      return fail(res, err);
    }
  };

  /**
   * Name-only entry, for an office running in open mode.
   *
   * A name already in the directory is reclaimed rather than duplicated - the
   * same person on a new machine keeps their history - but only while nobody
   * is signed in under it, so two people cannot hold one identity at once.
   */
  async function join(req, res) {
    if (officeInfo(db).mode !== "open") {
      throw new HttpError(403, "closed", "Det här kontoret kräver ett konto.");
    }

    const displayName = String((await readJson(req)).displayName ?? "").trim().slice(0, 64);
    if (!displayName) throw new HttpError(400, "invalid", "Skriv ett namn.");

    const existing = listUsers(db).find(
      (row) => row.display_name.toLowerCase() === displayName.toLowerCase()
    );

    if (existing) {
      if (hub.presenceOf(existing.id) !== "offline") {
        throw new HttpError(409, "name_taken", "Någon använder det namnet just nu. Välj ett annat.");
      }
      const token = createSession(db, existing.id);
      return json(res, 200, { token, user: toUser(existing, "offline") });
    }

    // A synthetic username keeps the UNIQUE constraint meaningful without
    // asking anyone to invent one.
    const id = newId();
    db.prepare(
      `INSERT INTO users (id, username, display_name, pw_hash, pw_salt, created_at, last_seen)
       VALUES (?, ?, ?, '', '', ?, NULL)`
    ).run(id, `gast-${id.slice(0, 8)}`, displayName, Date.now());

    const token = createSession(db, id);
    hub.broadcast({ t: "roster", users: hub.roster() });
    return json(res, 201, { token, user: toUser(findUserById(db, id), "offline") });
  }

  async function register(req, res) {
    if (officeInfo(db).mode !== "password") {
      throw new HttpError(403, "open_office", "Det här kontoret använder bara namn - inga konton.");
    }
    const body = await readJson(req);
    const invalid = validateCredentials(body);
    if (invalid) throw new HttpError(400, "invalid", invalid);

    const displayName = String(body.displayName || body.username).trim().slice(0, 64);
    if (!displayName) throw new HttpError(400, "invalid", "Ett visningsnamn krävs.");

    if (findUserByUsername(db, body.username)) {
      throw new HttpError(409, "taken", "Användarnamnet är upptaget.");
    }

    const { hash, salt } = await hashPassword(body.password);
    const id = newId();
    try {
      db.prepare(
        `INSERT INTO users (id, username, display_name, pw_hash, pw_salt, created_at, last_seen)
         VALUES (?, ?, ?, ?, ?, ?, NULL)`
      ).run(id, body.username, displayName, hash, salt, Date.now());
    } catch (err) {
      // UNIQUE violation from a concurrent signup with the same name.
      if (String(err.message).includes("UNIQUE")) {
        throw new HttpError(409, "taken", "Användarnamnet är upptaget.");
      }
      throw err;
    }

    const user = findUserById(db, id);
    const token = createSession(db, id);
    hub.broadcast({ t: "roster", users: hub.roster() });
    return json(res, 201, { token, user: toUser(user, "offline") });
  }

  async function login(req, res) {
    const body = await readJson(req);
    if (typeof body.username !== "string" || typeof body.password !== "string") {
      throw new HttpError(400, "invalid", "Användarnamn och lösenord krävs.");
    }
    const row = findUserByUsername(db, body.username);
    // An account created by name-only join has no password and must never be
    // reachable through the password path.
    if (row && !row.pw_hash) {
      throw new HttpError(401, "bad_credentials", "Fel användarnamn eller lösenord.");
    }
    // Always run a verification so a missing account and a wrong password
    // take the same amount of time.
    const ok = row
      ? await verifyPassword(body.password, row.pw_hash, row.pw_salt)
      : await verifyPassword(body.password, createHash("sha256").digest("hex").repeat(4), "decoy");

    if (!row || !ok) throw new HttpError(401, "bad_credentials", "Fel användarnamn eller lösenord.");

    const token = createSession(db, row.id);
    return json(res, 200, { token, user: toUser(row, hub.presenceOf(row.id)) });
  }

  async function fileInit(req, res) {
    const user = requireUser(db, req);
    const body = await readJson(req);
    const result = await initUpload(db, dataDir, user.id, body);
    return json(res, 201, result);
  }

  async function fileChunk(req, res, fileId, url) {
    const user = requireUser(db, req);
    const file = getFile(db, fileId);
    if (!file) throw new HttpError(404, "not_found", "Okänd uppladdning.");
    if (file.owner_id !== user.id) throw new HttpError(403, "forbidden", "Uppladdningen tillhör någon annan.");
    if (file.complete === 1) return json(res, 200, { complete: true, received: receivedChunks(db, fileId) });

    const index = Number(url.searchParams.get("index"));
    const buffer = await readBody(req, CHUNK_LIMIT);
    const result = await writeChunk(db, dataDir, file, index, buffer);
    return json(res, 200, result);
  }

  async function fileDownload(req, res, fileId, url) {
    // Downloads are also reachable from an <a href>/native save dialog, which
    // cannot set an Authorization header, so a token query param is accepted.
    const token = bearer(req) || url.searchParams.get("token");
    const user = resolveSession(db, token);
    if (!user) throw new HttpError(401, "unauthorized", "Logga in för att fortsätta.");

    const file = getFile(db, fileId);
    if (!file) throw new HttpError(404, "not_found", "Filen finns inte längre.");
    if (file.owner_id !== user.id && file.to_id !== user.id) {
      throw new HttpError(403, "forbidden", "Filen har inte delats med dig.");
    }
    if (file.complete !== 1) throw new HttpError(409, "incomplete", "Filen laddas fortfarande upp.");

    const { stream, size } = await openDownload(dataDir, file);
    res.writeHead(200, {
      "content-type": file.mime,
      "content-length": size,
      "content-disposition": `attachment; filename="${file.name.replace(/"/g, "")}"`,
      "x-file-name": encodeURIComponent(file.name),
    });
    stream.pipe(res);
    stream.on("error", () => res.destroy());
  }
}

export { MAX_FILE_BYTES, initialsOf };
