export declare const PROTOCOL_VERSION: 1;
export declare const CHUNK_SIZE: number;
export declare const MAX_FILE_BYTES: number;

export type UserId = string;
export type Presence = "online" | "away" | "offline";

export interface User {
  id: UserId;
  username: string;
  displayName: string;
  /** Two-letter monogram rendered when there is no avatar. */
  initials: string;
  presence: Presence;
  /** Epoch ms of the last socket activity, or null if never connected. */
  lastSeen: number | null;
}

export interface Attachment {
  fileId: string;
  name: string;
  size: number;
  mime: string;
}

export interface Message {
  id: string;
  /** Client-generated id, echoed back so the sender can reconcile its optimistic copy. */
  clientId: string | null;
  from: UserId;
  to: UserId;
  body: string;
  attachment: Attachment | null;
  /** True when the sender asked the recipient's machine to make a noise. */
  alert: boolean;
  sentAt: number;
  readAt: number | null;
}

export interface Credentials {
  username: string;
  password: string;
}

export interface RegisterRequest extends Credentials {
  displayName: string;
}

export interface AuthResponse {
  token: string;
  user: User;
}

export interface FileInitRequest {
  name: string;
  size: number;
  mime: string;
  to: UserId;
}

export interface FileInitResponse {
  fileId: string;
  chunkSize: number;
  /** Chunk indices the server already holds, so an interrupted upload resumes. */
  received: number[];
}

export interface ApiError {
  error: string;
  message: string;
}

export type ClientEvent =
  | { t: "send"; clientId: string; to: UserId; body: string; alert?: boolean; attachment?: Attachment }
  | { t: "typing"; to: UserId }
  | { t: "read"; withUser: UserId; upTo: number }
  | { t: "nudge"; to: UserId }
  | { t: "presence"; status: Exclude<Presence, "offline"> }
  | { t: "ping" };

export type ServerEvent =
  | { t: "ready"; version: number; self: User; users: User[]; history: Message[] }
  | { t: "message"; message: Message }
  | { t: "ack"; clientId: string; message: Message }
  | { t: "presence"; userId: UserId; presence: Presence; lastSeen: number | null }
  | { t: "roster"; users: User[] }
  | { t: "typing"; from: UserId }
  | { t: "read"; from: UserId; upTo: number }
  | { t: "nudge"; from: UserId }
  | { t: "error"; code: string; message: string }
  | { t: "pong" };

export declare function initialsOf(displayName: string): string;
export declare function formatBytes(bytes: number): string;
export declare function chunkCountFor(size: number): number;
