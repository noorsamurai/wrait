import { createHash } from "node:crypto";
import {
  validateCredentials, hashPassword, verifyPassword,
  createSession, resolveSession, destroySession, newId,
} from "./auth.js";
import { toUser, findUserByUsername, findUserById } from "./store.js";
import { initUpload, getFile, receivedChunks, writeChunk, openDownload, HttpError } from "./files.js";
import { initialsOf, MAX_FILE_BYTES } from "@comms/protocol";

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
  return json(res, 500, { error: "internal", message: "Something went wrong on the server." });
}

async function readBody(req, limit) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limit) throw new HttpError(413, "too_large", "Request body is too large.");
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
    throw new HttpError(400, "bad_json", "Request body was not valid JSON.");
  }
}

function bearer(req) {
  const header = req.headers.authorization || "";
  return header.startsWith("Bearer ") ? header.slice(7) : null;
}

function requireUser(db, req) {
  const user = resolveSession(db, bearer(req));
  if (!user) throw new HttpError(401, "unauthorized", "Sign in to continue.");
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

      return json(res, 404, { error: "not_found", message: "No such endpoint." });
    } catch (err) {
      return fail(res, err);
    }
  };

  async function register(req, res) {
    const body = await readJson(req);
    const invalid = validateCredentials(body);
    if (invalid) throw new HttpError(400, "invalid", invalid);

    const displayName = String(body.displayName || body.username).trim().slice(0, 64);
    if (!displayName) throw new HttpError(400, "invalid", "A display name is required.");

    if (findUserByUsername(db, body.username)) {
      throw new HttpError(409, "taken", "That username is already taken.");
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
        throw new HttpError(409, "taken", "That username is already taken.");
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
      throw new HttpError(400, "invalid", "Username and password are required.");
    }
    const row = findUserByUsername(db, body.username);
    // Always run a verification so a missing account and a wrong password
    // take the same amount of time.
    const ok = row
      ? await verifyPassword(body.password, row.pw_hash, row.pw_salt)
      : await verifyPassword(body.password, createHash("sha256").digest("hex").repeat(4), "decoy");

    if (!row || !ok) throw new HttpError(401, "bad_credentials", "Incorrect username or password.");

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
    if (!file) throw new HttpError(404, "not_found", "Unknown upload.");
    if (file.owner_id !== user.id) throw new HttpError(403, "forbidden", "That upload belongs to someone else.");
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
    if (!user) throw new HttpError(401, "unauthorized", "Sign in to continue.");

    const file = getFile(db, fileId);
    if (!file) throw new HttpError(404, "not_found", "That file is no longer available.");
    if (file.owner_id !== user.id && file.to_id !== user.id) {
      throw new HttpError(403, "forbidden", "That file was not shared with you.");
    }
    if (file.complete !== 1) throw new HttpError(409, "incomplete", "That file is still uploading.");

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
