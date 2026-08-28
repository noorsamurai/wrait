import { randomUUID } from "node:crypto";
import { initialsOf, DEFAULT_OFFICE_NAME, DEFAULT_ROOMS, BROADCAST_ROOM } from "@lokalen/protocol";

/** Maps a `users` row onto the wire `User` shape. */
export function toUser(row, presence = "offline") {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    initials: initialsOf(row.display_name),
    presence,
    availability: row.availability === "busy" ? "busy" : "available",
    operator: row.operator ?? null,
    kind: row.kind === "broadcast" ? "broadcast" : "room",
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

export function toMessage(row, revisions = []) {
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
    editedAt: row.edited_at ?? null,
    deletedAt: row.deleted_at ?? null,
    revisions,
  };
}

export function revisionsOf(db, messageId) {
  return db
    .prepare("SELECT body, replaced_at FROM message_revisions WHERE message_id = ? ORDER BY replaced_at")
    .all(messageId)
    .map((r) => ({ body: r.body, replacedAt: r.replaced_at }));
}

const MESSAGE_COLUMNS = `
  m.id, m.client_id, m.from_id, m.to_id, m.body, m.alert, m.sent_at, m.read_at,
  m.edited_at, m.deleted_at,
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

/**
 * The words of a message, folded for searching.
 *
 * Bodies carry pasted formatting, so the markup is stripped first; folding is
 * done here rather than in SQL because SQLite's lower() only handles ASCII
 * and would leave Å, Ä and Ö unmatched.
 */
export function searchableText(body) {
  return String(body ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function insertMessage(db, message) {
  db.prepare(
    `INSERT INTO messages (id, client_id, from_id, to_id, body, body_plain, alert, file_id, sent_at, read_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`
  ).run(
    message.id,
    message.clientId,
    message.from,
    message.to,
    message.body,
    searchableText(message.body),
    message.alert ? 1 : 0,
    message.attachment ? message.attachment.fileId : null,
    message.sentAt
  );
}

export function getMessage(db, id) {
  const row = db
    .prepare(`SELECT ${MESSAGE_COLUMNS} FROM messages m LEFT JOIN files f ON f.id = m.file_id WHERE m.id = ?`)
    .get(id);
  return row ? toMessage(row, revisionsOf(db, id)) : null;
}

/**
 * Recent history for every conversation `userId` takes part in.
 *
 * Capped so a client that has been offline for months still gets a small,
 * fast payload on connect rather than the entire archive.
 */
export function recentHistory(db, userId, limit = 500) {
  const channel = broadcastRoom(db);
  const rows = db
    .prepare(
      `SELECT ${MESSAGE_COLUMNS}
         FROM messages m
         LEFT JOIN files f ON f.id = m.file_id
        WHERE m.from_id = ? OR m.to_id = ? OR m.to_id = ?
        ORDER BY m.sent_at DESC
        LIMIT ?`
    )
    .all(userId, userId, channel ? channel.id : "", limit);
  return rows.map(toMessage).reverse();
}

/**
 * One conversation's messages older than `before`, oldest first.
 *
 * Connecting sends a recent slice; this is what the reader scrolling upwards
 * pulls in behind it, so an office keeps its whole history without every
 * client loading all of it.
 */
export function historyBefore(db, userId, peerId, before, limit = 200) {
  const channel = broadcastRoom(db);
  const isChannel = channel && peerId === channel.id;

  const rows = isChannel
    ? db
        .prepare(
          `SELECT ${MESSAGE_COLUMNS} FROM messages m
             LEFT JOIN files f ON f.id = m.file_id
            WHERE m.to_id = ? AND m.sent_at < ?
            ORDER BY m.sent_at DESC LIMIT ?`
        )
        .all(peerId, before, limit)
    : db
        .prepare(
          `SELECT ${MESSAGE_COLUMNS} FROM messages m
             LEFT JOIN files f ON f.id = m.file_id
            WHERE ((m.from_id = ? AND m.to_id = ?) OR (m.from_id = ? AND m.to_id = ?))
              AND m.sent_at < ?
            ORDER BY m.sent_at DESC LIMIT ?`
        )
        .all(userId, peerId, peerId, userId, before, limit);

  return { messages: rows.map(toMessage).reverse(), exhausted: rows.length < limit };
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

/* ------------------------------------------------------------------ */
/* Rooms                                                               */
/* ------------------------------------------------------------------ */

/** Slug used for the UNIQUE constraint; nobody types or sees it. */
function slugOf(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32) || "rum";
}

export function createRoom(db, displayName, kind = "room") {
  const id = randomUUID();
  let username = slugOf(displayName);
  // A slug collision is possible ("Rum 1" and "rum-1"); make it unique rather
  // than failing the join.
  if (db.prepare("SELECT 1 FROM users WHERE username = ?").get(username)) {
    username = `${username}-${id.slice(0, 4)}`;
  }
  db.prepare(
    `INSERT INTO users (id, username, display_name, pw_hash, pw_salt, created_at, last_seen, kind)
     VALUES (?, ?, ?, '', '', ?, NULL, ?)`
  ).run(id, username, displayName, Date.now(), kind);
  return id;
}

export function findRoomByName(db, displayName) {
  return (
    db
      .prepare("SELECT * FROM users WHERE display_name = ? COLLATE NOCASE")
      .get(displayName) ?? null
  );
}

export function broadcastRoom(db) {
  return findRoomByName(db, BROADCAST_ROOM);
}

/**
 * Creates the rooms an office starts with, once.
 *
 * The Alla channel is a room row too, flagged as a broadcast, so addressing
 * it needs no special case anywhere a message is stored or read back.
 */
export function seedRooms(db, rooms = DEFAULT_ROOMS) {
  if (!broadcastRoom(db)) createRoom(db, BROADCAST_ROOM, "broadcast");
  for (const name of rooms) {
    if (!findRoomByName(db, name)) createRoom(db, name);
  }
}

export function setAvailability(db, id, availability) {
  db.prepare("UPDATE users SET availability = ? WHERE id = ?").run(
    availability === "busy" ? "busy" : "available",
    id
  );
}

export function setOperator(db, id, name) {
  const trimmed = typeof name === "string" ? name.trim().slice(0, 64) : "";
  db.prepare("UPDATE users SET operator = ? WHERE id = ?").run(trimmed || null, id);
}

/* ------------------------------------------------------------------ */
/* Editing and deleting                                                */
/* ------------------------------------------------------------------ */

/** Replaces the wording, keeping what was there before. */
export function editMessage(db, id, body) {
  const current = db.prepare("SELECT body FROM messages WHERE id = ?").get(id);
  if (!current) return;
  const at = Date.now();
  db.prepare("INSERT INTO message_revisions (message_id, body, replaced_at) VALUES (?, ?, ?)").run(
    id,
    current.body,
    at
  );
  db.prepare("UPDATE messages SET body = ?, body_plain = ?, edited_at = ? WHERE id = ?").run(
    body,
    searchableText(body),
    at,
    id
  );
}

/**
 * Leaves a tombstone rather than removing the row.
 *
 * The recipient has already seen it; silently vacating the space would be
 * more confusing than saying plainly that something was withdrawn. Earlier
 * wordings go too, or deleting would be a way to publish them.
 */
export function deleteMessage(db, id) {
  db.prepare("DELETE FROM message_revisions WHERE message_id = ?").run(id);
  db.prepare(
    "UPDATE messages SET body = '', body_plain = '', file_id = NULL, deleted_at = ? WHERE id = ?"
  ).run(Date.now(), id);
}

/**
 * Messages this room can see, matching every word of the query.
 *
 * Terms are ANDed so "remiss anna" narrows rather than widens, which is what
 * someone hunting for one message expects.
 */
export function searchMessages(db, userId, query, limit = 60) {
  const terms = searchableText(query).split(" ").filter(Boolean).slice(0, 6);
  if (terms.length === 0) return [];

  const channel = broadcastRoom(db);
  const conditions = terms.map(() => "m.body_plain LIKE ?").join(" AND ");
  const values = terms.map((term) => `%${term}%`);

  const rows = db
    .prepare(
      `SELECT ${MESSAGE_COLUMNS} FROM messages m
         LEFT JOIN files f ON f.id = m.file_id
        WHERE (m.from_id = ? OR m.to_id = ? OR m.to_id = ?)
          AND m.deleted_at IS NULL
          AND ${conditions}
        ORDER BY m.sent_at DESC LIMIT ?`
    )
    .all(userId, userId, channel ? channel.id : "", ...values, limit);

  return rows.map((row) => toMessage(row));
}
