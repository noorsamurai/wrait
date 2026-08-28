import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Opens (creating if needed) the message store and applies the schema.
 *
 * Uses Node's built-in SQLite so deploying the relay onto an office machine
 * needs nothing but a Node runtime - no native module compilation.
 */
export function openDatabase(file) {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);

  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id           TEXT PRIMARY KEY,
      username     TEXT NOT NULL UNIQUE COLLATE NOCASE,
      display_name TEXT NOT NULL,
      pw_hash      TEXT NOT NULL,
      pw_salt      TEXT NOT NULL,
      created_at   INTEGER NOT NULL,
      last_seen    INTEGER,
      -- A row is a room, not a person. "broadcast" is the Alla channel.
      kind         TEXT NOT NULL DEFAULT 'room',
      -- Who is working in this room right now, if anyone said so.
      operator     TEXT,
      availability TEXT NOT NULL DEFAULT 'available'
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);

    CREATE TABLE IF NOT EXISTS files (
      id          TEXT PRIMARY KEY,
      owner_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      to_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name        TEXT NOT NULL,
      size        INTEGER NOT NULL,
      mime        TEXT NOT NULL,
      chunk_count INTEGER NOT NULL,
      complete    INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS file_chunks (
      file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      idx     INTEGER NOT NULL,
      PRIMARY KEY (file_id, idx)
    );

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id                TEXT PRIMARY KEY,
      owner_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_by        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title             TEXT NOT NULL,
      notes             TEXT NOT NULL DEFAULT '',
      due_at            INTEGER,
      cleared_at        INTEGER,
      created_at        INTEGER NOT NULL,
      source_message_id TEXT
    );
    CREATE INDEX IF NOT EXISTS tasks_owner ON tasks(owner_id, cleared_at, due_at);

    CREATE TABLE IF NOT EXISTS messages (
      id        TEXT PRIMARY KEY,
      client_id TEXT,
      from_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      to_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      body      TEXT NOT NULL,
      alert     INTEGER NOT NULL DEFAULT 0,
      file_id   TEXT REFERENCES files(id) ON DELETE SET NULL,
      sent_at   INTEGER NOT NULL,
      read_at   INTEGER,
      edited_at INTEGER,
      deleted_at INTEGER
    );

    -- Every earlier wording of an edited message, so the original stays
    -- recallable by both the sender and the recipient.
    CREATE TABLE IF NOT EXISTS message_revisions (
      message_id  TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      body        TEXT NOT NULL,
      replaced_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS revisions_message ON message_revisions(message_id, replaced_at);
    CREATE INDEX IF NOT EXISTS messages_pair ON messages(from_id, to_id, sent_at);
    CREATE INDEX IF NOT EXISTS messages_to   ON messages(to_id, sent_at);
  `);

  return db;
}
