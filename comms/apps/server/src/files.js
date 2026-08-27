import { open, mkdir, stat, unlink } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { join } from "node:path";
import { CHUNK_SIZE, MAX_FILE_BYTES, chunkCountFor } from "@comms/protocol";
import { newId } from "./auth.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** File ids are server-generated UUIDs; validating the shape keeps any
 *  caller-supplied value from reaching the filesystem as a path segment. */
function blobPath(dataDir, fileId) {
  if (!UUID_RE.test(fileId)) throw new Error("invalid file id");
  return join(dataDir, "blobs", fileId);
}

export async function initUpload(db, dataDir, ownerId, { name, size, mime, to }) {
  if (typeof name !== "string" || !name.trim()) throw new HttpError(400, "bad_request", "A file name is required.");
  if (!Number.isInteger(size) || size < 0) throw new HttpError(400, "bad_request", "Invalid file size.");
  if (size > MAX_FILE_BYTES) throw new HttpError(413, "too_large", "That file is larger than the 2 GB limit.");

  const recipient = db.prepare("SELECT id FROM users WHERE id = ?").get(to);
  if (!recipient) throw new HttpError(404, "no_such_user", "That recipient no longer exists.");

  const fileId = newId();
  // Strip any directory component a client might send; the stored name is
  // display-only, the bytes live under the UUID.
  const safeName = name.replace(/[/\\]/g, "_").slice(0, 255);

  db.prepare(
    `INSERT INTO files (id, owner_id, to_id, name, size, mime, chunk_count, complete, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`
  ).run(fileId, ownerId, to, safeName, size, String(mime || "application/octet-stream").slice(0, 128), chunkCountFor(size), Date.now());

  await mkdir(join(dataDir, "blobs"), { recursive: true });
  // Create the blob up front so out-of-order chunks can be written by offset.
  const handle = await open(blobPath(dataDir, fileId), "w");
  await handle.close();

  return { fileId, chunkSize: CHUNK_SIZE, received: [] };
}

export function getFile(db, fileId) {
  return db.prepare("SELECT * FROM files WHERE id = ?").get(fileId) ?? null;
}

export function receivedChunks(db, fileId) {
  return db
    .prepare("SELECT idx FROM file_chunks WHERE file_id = ? ORDER BY idx")
    .all(fileId)
    .map((r) => r.idx);
}

/** Writes one chunk at its absolute offset, so uploads may arrive in any order
 *  and a broken connection resumes without re-sending what landed. */
export async function writeChunk(db, dataDir, file, index, buffer) {
  if (!Number.isInteger(index) || index < 0 || index >= file.chunk_count) {
    throw new HttpError(400, "bad_chunk", "Chunk index out of range.");
  }
  const expected = index === file.chunk_count - 1 ? file.size - index * CHUNK_SIZE : CHUNK_SIZE;
  if (buffer.length !== expected) {
    throw new HttpError(400, "bad_chunk", `Chunk ${index} should be ${expected} bytes, got ${buffer.length}.`);
  }

  const handle = await open(blobPath(dataDir, file.id), "r+");
  try {
    await handle.write(buffer, 0, buffer.length, index * CHUNK_SIZE);
  } finally {
    await handle.close();
  }

  db.prepare("INSERT OR IGNORE INTO file_chunks (file_id, idx) VALUES (?, ?)").run(file.id, index);
  const done = receivedChunks(db, file.id).length === file.chunk_count;
  if (done) db.prepare("UPDATE files SET complete = 1 WHERE id = ?").run(file.id);
  return { complete: done, received: receivedChunks(db, file.id) };
}

export async function openDownload(dataDir, file) {
  const path = blobPath(dataDir, file.id);
  const info = await stat(path);
  return { stream: createReadStream(path), size: info.size };
}

export async function deleteBlob(dataDir, fileId) {
  try {
    await unlink(blobPath(dataDir, fileId));
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
}

export class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
