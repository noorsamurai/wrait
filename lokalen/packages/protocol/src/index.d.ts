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

/**
 * How an office lets people in.
 *
 * "open"     - type a name and start; nobody manages passwords.
 * "password" - each person has an account, for offices on shared or guest
 *              networks where anyone in range could otherwise claim a name.
 */
export type OfficeMode = "open" | "password";

export interface OfficeInfo {
  name: string;
  mode: OfficeMode;
  version: number;
}

export interface JoinRequest {
  displayName: string;
}

/* ------------------------------------------------------------------ */
/* Tasks                                                               */
/* ------------------------------------------------------------------ */

export interface Task {
  id: string;
  /** Whose list this sits in. */
  owner: UserId;
  /** Who put it there - the same as `owner` for a personal note. */
  createdBy: UserId;
  title: string;
  notes: string;
  /** Epoch ms the task is due, or null when it is just a reminder. */
  dueAt: number | null;
  /** Epoch ms it was cleared, or null while it is still open. */
  clearedAt: number | null;
  createdAt: number;
  /** Set when the task was saved from a chat message. */
  sourceMessageId: string | null;
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
  | {
      t: "taskAdd";
      /** Whose list to put it in. Omit for your own. */
      owner?: UserId;
      title: string;
      notes?: string;
      dueAt?: number | null;
      sourceMessageId?: string | null;
    }
  | { t: "taskEdit"; id: string; title?: string; notes?: string; dueAt?: number | null }
  | { t: "taskClear"; id: string; cleared: boolean }
  | { t: "taskDelete"; id: string }
  | { t: "typing"; to: UserId }
  | { t: "read"; withUser: UserId; upTo: number }
  | { t: "nudge"; to: UserId }
  | { t: "presence"; status: Exclude<Presence, "offline"> }
  | { t: "ping" };

export type ServerEvent =
  | {
      t: "ready";
      version: number;
      self: User;
      users: User[];
      history: Message[];
      tasks: Task[];
      office: OfficeInfo;
    }
  | { t: "task"; task: Task }
  | { t: "taskRemoved"; id: string }
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

export declare const DEFAULT_OFFICE_NAME: string;
export declare function sortTasks(tasks: Task[], direction?: "asc" | "desc"): Task[];
