/**
 * Wire protocol shared by the relay server and every client.
 *
 * Plain ESM with a sibling .d.ts so the Node server and the TypeScript UI
 * import the exact same module - no build step, no drifting duplicate.
 */

export const PROTOCOL_VERSION = 1;

/** Size of a single upload chunk. 512 KiB keeps peak client memory low on
 *  machines with very little RAM while still saturating a LAN link. */
export const CHUNK_SIZE = 512 * 1024;

/** Hard ceiling on a single transferred file (2 GiB). */
export const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024;

/** Derive the monogram shown in the roster. */
export function initialsOf(displayName) {
  const parts = String(displayName).trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** Human-readable byte count for the transfer UI. */
export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** Number of chunks a file of `size` bytes will be split into. */
export function chunkCountFor(size) {
  return Math.max(1, Math.ceil(size / CHUNK_SIZE));
}

/** Sensible default name for an office nobody has named. */
export const DEFAULT_OFFICE_NAME = "Lokalen";

/**
 * Orders tasks for display: still-open before cleared, then by due date with
 * undated ones last, then newest first. Used by every client so a list looks
 * the same on every machine.
 */
export function sortTasks(tasks, direction = "asc") {
  const sign = direction === "desc" ? -1 : 1;
  return [...tasks].sort((a, b) => {
    if (Boolean(a.clearedAt) !== Boolean(b.clearedAt)) return a.clearedAt ? 1 : -1;
    if (a.dueAt !== b.dueAt) {
      // An undated task has no place on a date axis, so it sinks to the bottom
      // regardless of which way the sort runs.
      if (a.dueAt === null) return 1;
      if (b.dueAt === null) return -1;
      return (a.dueAt - b.dueAt) * sign;
    }
    return (b.createdAt - a.createdAt) * sign;
  });
}

/**
 * The rooms a new office starts with.
 *
 * A room is a place rather than a person: whoever is standing in
 * Behandlingsrum 1 sends as Behandlingsrum 1, which is what matters when
 * staff move between rooms from one day to the next.
 */
export const DEFAULT_ROOMS = ["Behandlingsrum 1", "Behandlingsrum 2", "Reception"];

/** The channel every room can see. */
export const BROADCAST_ROOM = "Alla";

/**
 * How long after sending a message may still be deleted.
 *
 * Long enough to catch "wrong room" or a typo you cannot live with, short
 * enough that the record of a clinic's day does not quietly change later.
 */
export const DELETE_WINDOW_MS = 5 * 60 * 1000;

/** True while `message` is still inside its deletion window. */
export function canDelete(message, selfId, now = Date.now()) {
  return (
    message.from === selfId &&
    !message.deletedAt &&
    now - message.sentAt < DELETE_WINDOW_MS
  );
}
