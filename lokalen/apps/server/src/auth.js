import { randomBytes, scrypt, timingSafeEqual, createHash, randomUUID } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt);

/** Cost parameters. N=16384 keeps a login around 50-80ms on office hardware. */
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,31}$/i;

export function validateCredentials({ username, password }) {
  if (typeof username !== "string" || !USERNAME_RE.test(username)) {
    return "Username must be 3-32 characters: letters, numbers, dot, dash or underscore.";
  }
  if (typeof password !== "string" || password.length < 8) {
    return "Password must be at least 8 characters.";
  }
  if (password.length > 256) return "Password is too long.";
  return null;
}

async function derive(password, salt) {
  const key = await scryptAsync(password, salt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    // scrypt needs memory proportional to N*r*128; raise the default cap to fit.
    maxmem: 64 * 1024 * 1024,
  });
  return key.toString("hex");
}

export async function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  return { hash: await derive(password, salt), salt };
}

export async function verifyPassword(password, hash, salt) {
  const candidate = await derive(password, salt);
  const a = Buffer.from(candidate, "hex");
  const b = Buffer.from(hash, "hex");
  // Length check first: timingSafeEqual throws on a mismatch.
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Sessions are stored hashed, so a leaked database cannot be replayed. */
export function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

export function createSession(db, userId) {
  const token = randomBytes(32).toString("base64url");
  const now = Date.now();
  db.prepare(
    "INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)"
  ).run(hashToken(token), userId, now, now + SESSION_TTL_MS);
  return token;
}

export function resolveSession(db, token) {
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT u.* FROM sessions s
         JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ? AND s.expires_at > ?`
    )
    .get(hashToken(token), Date.now());
  return row ?? null;
}

export function destroySession(db, token) {
  if (!token) return;
  db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hashToken(token));
}

export function newId() {
  return randomUUID();
}
