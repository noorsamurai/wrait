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
