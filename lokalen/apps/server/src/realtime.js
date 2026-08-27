import { WebSocketServer } from "ws";
import { PROTOCOL_VERSION } from "@lokalen/protocol";
import { resolveSession, newId } from "./auth.js";
import {
  toUser, listUsers, findUserById, touchUser,
  insertMessage, getMessage, recentHistory, markRead,
  officeInfo, insertTask, getTask, tasksFor, updateTask, deleteTask,
} from "./store.js";

const HEARTBEAT_MS = 30_000;
const MAX_BODY_LENGTH = 8000;

/**
 * Presence and message fan-out over WebSocket.
 *
 * A user may be signed in from several machines at once (desk PC, laptop,
 * phone), so sockets are tracked as a set per user id and every delivery goes
 * to all of them - including the sender's other devices, which keeps a
 * conversation in sync across the office and the phone in someone's pocket.
 */
export class Hub {
  constructor(db, { path = "/ws" } = {}) {
    this.db = db;
    this.path = path;
    this.sockets = new Map(); // userId -> Set<WebSocket>
    this.wss = new WebSocketServer({ noServer: true });
  }

  /** Presence is derived from live sockets, never from a stale database column. */
  presenceOf(userId) {
    const set = this.sockets.get(userId);
    if (!set || set.size === 0) return "offline";
    for (const ws of set) if (ws.appPresence === "online") return "online";
    return "away";
  }

  roster() {
    return listUsers(this.db).map((row) => toUser(row, this.presenceOf(row.id)));
  }

  send(ws, event) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(event));
  }

  /** Delivers to every socket a user currently has open. */
  sendTo(userId, event) {
    const set = this.sockets.get(userId);
    if (!set) return 0;
    let delivered = 0;
    for (const ws of set) {
      this.send(ws, event);
      delivered++;
    }
    return delivered;
  }

  broadcast(event) {
    for (const userId of this.sockets.keys()) this.sendTo(userId, event);
  }

  handleUpgrade(req, socket, head) {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname !== this.path) {
      socket.destroy();
      return;
    }
    const user = resolveSession(this.db, url.searchParams.get("token"));
    if (!user) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => this.#attach(ws, user));
  }

  #attach(ws, user) {
    ws.userId = user.id;
    ws.appPresence = "online";
    ws.isAlive = true;
    ws.on("pong", () => { ws.isAlive = true; });

    const wasOffline = this.presenceOf(user.id) === "offline";
    if (!this.sockets.has(user.id)) this.sockets.set(user.id, new Set());
    this.sockets.get(user.id).add(ws);
    touchUser(this.db, user.id);

    this.send(ws, {
      t: "ready",
      version: PROTOCOL_VERSION,
      self: toUser(findUserById(this.db, user.id), "online"),
      users: this.roster(),
      history: recentHistory(this.db, user.id),
      tasks: tasksFor(this.db, user.id),
      office: officeInfo(this.db),
    });

    if (wasOffline) {
      this.broadcast({ t: "presence", userId: user.id, presence: "online", lastSeen: Date.now() });
    }

    ws.on("message", (raw) => this.#onMessage(ws, raw));
    ws.on("close", () => this.#detach(ws));
    ws.on("error", () => this.#detach(ws));
  }

  #detach(ws) {
    const set = this.sockets.get(ws.userId);
    if (!set) return;
    set.delete(ws);
    const at = Date.now();
    touchUser(this.db, ws.userId, at);
    if (set.size === 0) {
      this.sockets.delete(ws.userId);
      this.broadcast({ t: "presence", userId: ws.userId, presence: "offline", lastSeen: at });
    }
  }

  #onMessage(ws, raw) {
    let event;
    try {
      event = JSON.parse(raw.toString());
    } catch {
      return this.send(ws, { t: "error", code: "bad_json", message: "Ogiltigt meddelande." });
    }

    switch (event?.t) {
      case "send":   return this.#onSend(ws, event);
      case "typing": return void this.sendTo(event.to, { t: "typing", from: ws.userId });
      case "nudge":  return this.#onNudge(ws, event);
      case "read":   return this.#onRead(ws, event);
      case "presence": {
        ws.appPresence = event.status === "away" ? "away" : "online";
        return void this.broadcast({
          t: "presence", userId: ws.userId, presence: this.presenceOf(ws.userId), lastSeen: Date.now(),
        });
      }
      case "taskAdd":    return this.#onTaskAdd(ws, event);
      case "taskEdit":   return this.#onTaskEdit(ws, event);
      case "taskClear":  return this.#onTaskClear(ws, event);
      case "taskDelete": return this.#onTaskDelete(ws, event);
      case "ping":   return this.send(ws, { t: "pong" });
      default:
        return this.send(ws, { t: "error", code: "unknown_event", message: "Okänd händelse." });
    }
  }

  #onSend(ws, event) {
    const body = typeof event.body === "string" ? event.body.slice(0, MAX_BODY_LENGTH) : "";
    const hasAttachment = Boolean(event.attachment?.fileId);
    if (!body.trim() && !hasAttachment) {
      return this.send(ws, { t: "error", code: "empty", message: "Inget att skicka." });
    }
    if (!findUserById(this.db, event.to)) {
      return this.send(ws, { t: "error", code: "no_such_user", message: "Personen finns inte längre i katalogen." });
    }

    // An attachment is only accepted if it was uploaded by this sender, is
    // fully received, and was addressed to this recipient.
    if (hasAttachment) {
      const file = this.db.prepare("SELECT * FROM files WHERE id = ?").get(event.attachment.fileId);
      if (!file || file.owner_id !== ws.userId || file.to_id !== event.to || file.complete !== 1) {
        return this.send(ws, { t: "error", code: "bad_attachment", message: "Filen är inte klar att skickas." });
      }
    }

    const record = {
      id: newId(),
      clientId: typeof event.clientId === "string" ? event.clientId.slice(0, 64) : null,
      from: ws.userId,
      to: event.to,
      body,
      alert: Boolean(event.alert),
      attachment: hasAttachment ? { fileId: event.attachment.fileId } : null,
      sentAt: Date.now(),
    };
    insertMessage(this.db, record);
    const message = getMessage(this.db, record.id);

    this.sendTo(event.to, { t: "message", message });
    // Echo to the sender's other devices, and acknowledge on this one.
    for (const socket of this.sockets.get(ws.userId) ?? []) {
      if (socket === ws) this.send(socket, { t: "ack", clientId: record.clientId, message });
      else this.send(socket, { t: "message", message });
    }
  }

  /** Both sides of a task see it: the person who owns it and whoever sent it. */
  #fanOutTask(task, extra = null) {
    const audience = new Set([task.owner, task.createdBy]);
    if (extra) audience.add(extra);
    for (const userId of audience) this.sendTo(userId, { t: "task", task });
  }

  #onTaskAdd(ws, event) {
    const title = typeof event.title === "string" ? event.title.trim().slice(0, 300) : "";
    if (!title) {
      return this.send(ws, { t: "error", code: "empty", message: "Uppgiften behöver en rubrik." });
    }

    const owner = event.owner ?? ws.userId;
    if (!findUserById(this.db, owner)) {
      return this.send(ws, { t: "error", code: "no_such_user", message: "Personen finns inte längre." });
    }

    const task = {
      id: newId(),
      owner,
      createdBy: ws.userId,
      title,
      notes: typeof event.notes === "string" ? event.notes.slice(0, 2000) : "",
      dueAt: Number.isFinite(event.dueAt) ? event.dueAt : null,
      createdAt: Date.now(),
      sourceMessageId: typeof event.sourceMessageId === "string" ? event.sourceMessageId : null,
    };
    insertTask(this.db, task);
    this.#fanOutTask(getTask(this.db, task.id));
  }

  /** Only the owner or the sender may change a task. */
  #mayTouch(task, userId) {
    return task && (task.owner === userId || task.createdBy === userId);
  }

  #onTaskEdit(ws, event) {
    const task = getTask(this.db, event.id);
    if (!this.#mayTouch(task, ws.userId)) {
      return this.send(ws, { t: "error", code: "forbidden", message: "Den uppgiften är inte din." });
    }
    const patch = {};
    if (typeof event.title === "string" && event.title.trim()) patch.title = event.title.trim().slice(0, 300);
    if (typeof event.notes === "string") patch.notes = event.notes.slice(0, 2000);
    if ("dueAt" in event) patch.due_at = Number.isFinite(event.dueAt) ? event.dueAt : null;
    updateTask(this.db, event.id, patch);
    this.#fanOutTask(getTask(this.db, event.id));
  }

  #onTaskClear(ws, event) {
    const task = getTask(this.db, event.id);
    if (!this.#mayTouch(task, ws.userId)) {
      return this.send(ws, { t: "error", code: "forbidden", message: "Den uppgiften är inte din." });
    }
    updateTask(this.db, event.id, { cleared_at: event.cleared ? Date.now() : null });
    this.#fanOutTask(getTask(this.db, event.id));
  }

  #onTaskDelete(ws, event) {
    const task = getTask(this.db, event.id);
    if (!this.#mayTouch(task, ws.userId)) {
      return this.send(ws, { t: "error", code: "forbidden", message: "Den uppgiften är inte din." });
    }
    deleteTask(this.db, event.id);
    for (const userId of new Set([task.owner, task.createdBy])) {
      this.sendTo(userId, { t: "taskRemoved", id: task.id });
    }
  }

  #onNudge(ws, event) {
    if (!findUserById(this.db, event.to)) return;
    this.sendTo(event.to, { t: "nudge", from: ws.userId });
  }

  #onRead(ws, event) {
    const upTo = Number.isFinite(event.upTo) ? event.upTo : Date.now();
    markRead(this.db, ws.userId, event.withUser, upTo);
    this.sendTo(event.withUser, { t: "read", from: ws.userId, upTo });
  }

  /** Drops sockets that stopped answering pings, so presence stays truthful. */
  startHeartbeat() {
    this.heartbeat = setInterval(() => {
      for (const set of this.sockets.values()) {
        for (const ws of [...set]) {
          if (!ws.isAlive) { ws.terminate(); continue; }
          ws.isAlive = false;
          ws.ping();
        }
      }
    }, HEARTBEAT_MS);
    this.heartbeat.unref?.();
  }

  close() {
    clearInterval(this.heartbeat);
    this.wss.close();
  }
}
