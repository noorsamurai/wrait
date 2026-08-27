import { initialsOf, DEFAULT_OFFICE_NAME } from "@lokalen/protocol";

/** Maps a `users` row onto the wire `User` shape. */
export function toUser(row, presence = "offline") {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    initials: initialsOf(row.display_name),
    presence,
    lastSeen: row.last_seen ?? null,
  };
}

export function toAttachment(row) {
  if (!row || !row.file_id) return null;
  return {
    fileId: row.file_id,
    name: row.file_name,
    size: row.file_size,
    mime: row.file_mime,
  };
}

export function toMessage(row) {
  return {
    id: row.id,
    clientId: row.client_id ?? null,
    from: row.from_id,
    to: row.to_id,
    body: row.body,
    attachment: toAttachment(row),
    alert: row.alert === 1,
    sentAt: row.sent_at,
    readAt: row.read_at ?? null,
  };
}

const MESSAGE_COLUMNS = `
  m.id, m.client_id, m.from_id, m.to_id, m.body, m.alert, m.sent_at, m.read_at,
  m.file_id, f.name AS file_name, f.size AS file_size, f.mime AS file_mime
`;

export function listUsers(db) {
  return db.prepare("SELECT * FROM users ORDER BY display_name COLLATE NOCASE").all();
}

export function findUserByUsername(db, username) {
  return db.prepare("SELECT * FROM users WHERE username = ? COLLATE NOCASE").get(username) ?? null;
}

export function findUserById(db, id) {
  return db.prepare("SELECT * FROM users WHERE id = ?").get(id) ?? null;
}

export function touchUser(db, id, at = Date.now()) {
  db.prepare("UPDATE users SET last_seen = ? WHERE id = ?").run(at, id);
}

export function insertMessage(db, message) {
  db.prepare(
    `INSERT INTO messages (id, client_id, from_id, to_id, body, alert, file_id, sent_at, read_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`
  ).run(
    message.id,
    message.clientId,
    message.from,
    message.to,
    message.body,
    message.alert ? 1 : 0,
    message.attachment ? message.attachment.fileId : null,
    message.sentAt
  );
}

export function getMessage(db, id) {
  const row = db
    .prepare(`SELECT ${MESSAGE_COLUMNS} FROM messages m LEFT JOIN files f ON f.id = m.file_id WHERE m.id = ?`)
    .get(id);
  return row ? toMessage(row) : null;
}

/**
 * Recent history for every conversation `userId` takes part in.
 *
 * Capped so a client that has been offline for months still gets a small,
 * fast payload on connect rather than the entire archive.
 */
export function recentHistory(db, userId, limit = 500) {
  const rows = db
    .prepare(
      `SELECT ${MESSAGE_COLUMNS}
         FROM messages m
         LEFT JOIN files f ON f.id = m.file_id
        WHERE m.from_id = ? OR m.to_id = ?
        ORDER BY m.sent_at DESC
        LIMIT ?`
    )
    .all(userId, userId, limit);
  return rows.map(toMessage).reverse();
}

/** Marks everything `peer` sent to `userId` up to `upTo` as read. */
export function markRead(db, userId, peer, upTo) {
  const at = Date.now();
  db.prepare(
    `UPDATE messages SET read_at = ?
      WHERE to_id = ? AND from_id = ? AND sent_at <= ? AND read_at IS NULL`
  ).run(at, userId, peer, upTo);
  return at;
}

/* ------------------------------------------------------------------ */
/* Office settings                                                     */
/* ------------------------------------------------------------------ */

export function getSetting(db, key, fallback = null) {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  return row ? row.value : fallback;
}

export function setSetting(db, key, value) {
  db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(key, String(value));
}

/** The office as clients see it before they have signed in. */
export function officeInfo(db) {
  return {
    name: getSetting(db, "office_name", DEFAULT_OFFICE_NAME),
    mode: getSetting(db, "office_mode", "open") === "password" ? "password" : "open",
    version: 1,
  };
}

/* ------------------------------------------------------------------ */
/* Tasks                                                               */
/* ------------------------------------------------------------------ */

export function toTask(row) {
  return {
    id: row.id,
    owner: row.owner_id,
    createdBy: row.created_by,
    title: row.title,
    notes: row.notes ?? "",
    dueAt: row.due_at ?? null,
    clearedAt: row.cleared_at ?? null,
    createdAt: row.created_at,
    sourceMessageId: row.source_message_id ?? null,
  };
}

export function insertTask(db, task) {
  db.prepare(
    `INSERT INTO tasks (id, owner_id, created_by, title, notes, due_at, cleared_at, created_at, source_message_id)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)`
  ).run(
    task.id, task.owner, task.createdBy, task.title, task.notes,
    task.dueAt, task.createdAt, task.sourceMessageId
  );
}

export function getTask(db, id) {
  const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
  return row ? toTask(row) : null;
}

/**
 * Everything in this person's own list, plus anything they sent to someone
 * else - so a sender can see whether their request was cleared.
 */
export function tasksFor(db, userId, limit = 500) {
  return db
    .prepare(
      `SELECT * FROM tasks WHERE owner_id = ? OR created_by = ?
        ORDER BY created_at DESC LIMIT ?`
    )
    .all(userId, userId, limit)
    .map(toTask);
}

export function updateTask(db, id, patch) {
  const fields = [];
  const values = [];
  for (const [column, value] of Object.entries(patch)) {
    fields.push(`${column} = ?`);
    values.push(value);
  }
  if (fields.length === 0) return;
  values.push(id);
  db.prepare(`UPDATE tasks SET ${fields.join(", ")} WHERE id = ?`).run(...values);
}

export function deleteTask(db, id) {
  db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
}
