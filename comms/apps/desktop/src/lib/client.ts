import type {
  AuthResponse, Attachment, ClientEvent, FileInitResponse,
  Message, ServerEvent, User, UserId,
} from "@comms/protocol";
import { CHUNK_SIZE, chunkCountFor } from "@comms/protocol";

export interface Session {
  serverUrl: string;
  token: string;
  user: User;
}

export class ApiError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

/** Normalises whatever the user typed into a server base URL. */
export function normaliseServerUrl(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, "");
  if (!trimmed) throw new ApiError("no_server", "Enter the address of your office server.");
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  try {
    return new URL(withScheme).origin;
  } catch {
    throw new ApiError("bad_server", "That does not look like a valid server address.");
  }
}

async function request<T>(serverUrl: string, path: string, init: RequestInit & { token?: string } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(serverUrl + path, {
      ...init,
      headers: {
        ...(init.body && typeof init.body === "string" ? { "content-type": "application/json" } : {}),
        ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
        ...init.headers,
      },
    });
  } catch {
    throw new ApiError("offline", "Could not reach the server. Check the address and your network.");
  }

  if (!res.ok) {
    // An error body is expected, but a proxy or a crash can return anything.
    const detail = await res.json().catch(() => null);
    throw new ApiError(detail?.error ?? "http_error", detail?.message ?? `Request failed (${res.status}).`);
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

export function register(serverUrl: string, body: { username: string; displayName: string; password: string }) {
  return request<AuthResponse>(serverUrl, "/api/register", { method: "POST", body: JSON.stringify(body) });
}

export function login(serverUrl: string, body: { username: string; password: string }) {
  return request<AuthResponse>(serverUrl, "/api/login", { method: "POST", body: JSON.stringify(body) });
}

export function logout(session: Session) {
  return request<void>(session.serverUrl, "/api/logout", { method: "POST", token: session.token }).catch(() => {});
}

/* ------------------------------------------------------------------ */
/* File transfer                                                       */
/* ------------------------------------------------------------------ */

export interface UploadHandle {
  attachment: Attachment;
  cancel: () => void;
}

/**
 * Uploads a file one chunk at a time.
 *
 * Slicing a `File` gives a view rather than a copy, so only one 512 KiB chunk
 * is ever resident - a 1 GB transfer costs the same memory as a 1 MB one,
 * which is what makes this viable on the low-RAM machines in the office.
 */
export async function uploadFile(
  session: Session,
  file: File,
  to: UserId,
  onProgress?: (sent: number, total: number) => void,
  signal?: AbortSignal,
): Promise<Attachment> {
  const init = await request<FileInitResponse>(session.serverUrl, "/api/files/init", {
    method: "POST",
    token: session.token,
    body: JSON.stringify({
      name: file.name,
      size: file.size,
      mime: file.type || "application/octet-stream",
      to,
    }),
  });

  const total = chunkCountFor(file.size);
  const already = new Set(init.received);

  for (let index = 0; index < total; index++) {
    if (signal?.aborted) throw new ApiError("cancelled", "Transfer cancelled.");
    if (already.has(index)) continue;

    const slice = file.slice(index * CHUNK_SIZE, Math.min((index + 1) * CHUNK_SIZE, file.size));
    let res: Response;
    try {
      res = await fetch(`${session.serverUrl}/api/files/${init.fileId}/chunk?index=${index}`, {
        method: "PUT",
        headers: {
          authorization: `Bearer ${session.token}`,
          "content-type": "application/octet-stream",
        },
        body: slice,
        signal,
      });
    } catch {
      throw new ApiError("offline", "The connection dropped during the transfer.");
    }
    if (!res.ok) {
      const detail = await res.json().catch(() => null);
      throw new ApiError(detail?.error ?? "upload_failed", detail?.message ?? "The upload was rejected.");
    }
    onProgress?.(Math.min((index + 1) * CHUNK_SIZE, file.size), file.size);
  }

  return {
    fileId: init.fileId,
    name: file.name,
    size: file.size,
    mime: file.type || "application/octet-stream",
  };
}

/** Authenticated download URL, usable from an <a href> or a native save. */
export function downloadUrl(session: Session, fileId: string): string {
  return `${session.serverUrl}/api/files/${fileId}?token=${encodeURIComponent(session.token)}`;
}

/* ------------------------------------------------------------------ */
/* Realtime                                                            */
/* ------------------------------------------------------------------ */

type Handler = (event: ServerEvent) => void;

/**
 * A reconnecting WebSocket.
 *
 * Office Wi-Fi drops and laptops sleep, so the socket reopens on its own with
 * a backoff; the server replays recent history on every `ready`, which is how
 * anything missed while disconnected gets filled in.
 */
export class Realtime {
  private ws: WebSocket | null = null;
  private closed = false;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private session: Session, private onEvent: Handler, private onStatus: (up: boolean) => void) {}

  connect() {
    if (this.closed) return;
    const base = this.session.serverUrl.replace(/^http/i, "ws");
    const ws = new WebSocket(`${base}/ws?token=${encodeURIComponent(this.session.token)}`);
    this.ws = ws;

    ws.onopen = () => {
      this.attempt = 0;
      this.onStatus(true);
    };
    ws.onmessage = (raw) => {
      try {
        this.onEvent(JSON.parse(raw.data) as ServerEvent);
      } catch {
        /* A frame we cannot parse is not worth tearing the socket down for. */
      }
    };
    ws.onclose = () => {
      this.onStatus(false);
      this.scheduleReconnect();
    };
    ws.onerror = () => ws.close();
  }

  private scheduleReconnect() {
    if (this.closed) return;
    // Backoff to 15s, with jitter so a whole office reconnecting after a
    // switch reboot does not arrive in lockstep.
    const delay = Math.min(15_000, 500 * 2 ** this.attempt++) * (0.7 + Math.random() * 0.6);
    this.timer = setTimeout(() => this.connect(), delay);
  }

  send(event: ClientEvent) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(event));
      return true;
    }
    return false;
  }

  close() {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.ws?.close();
  }
}

/** Groups a flat history into per-peer conversations. */
export function byConversation(messages: Message[], selfId: UserId): Map<UserId, Message[]> {
  const map = new Map<UserId, Message[]>();
  for (const message of messages) {
    const peer = message.from === selfId ? message.to : message.from;
    const list = map.get(peer);
    if (list) list.push(message);
    else map.set(peer, [message]);
  }
  return map;
}
