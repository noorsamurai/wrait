import { initialsOf } from "@comms/protocol";

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
