import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type {
  Attachment, Availability, Message, OfficeInfo, ServerEvent, Task, User, UserId,
} from "@lokalen/protocol";
import { Realtime, byConversation, conversationOf, type Session } from "./client";
import { notify, requestAttention, requestNotificationAccess } from "./native";
import { playAlertTone, playMessageTone, playNudgeTone } from "./sound";
import type { Settings } from "./settings";

interface State {
  self: User | null;
  users: User[];
  /** Peer id -> that conversation's messages, oldest first. */
  threads: Record<UserId, Message[]>;
  unread: Record<UserId, number>;
  /** Peer id -> epoch ms the typing indicator should expire. */
  typing: Record<UserId, number>;
  /** Every task in this person's list, plus ones they sent to others. */
  tasks: Task[];
  office: OfficeInfo | null;
  /** Conversations known to have no more history behind them. */
  exhausted: Record<UserId, boolean>;
  ready: boolean;
}

const EMPTY: State = { self: null, users: [], threads: {}, unread: {}, typing: {}, tasks: [], office: null, exhausted: {}, ready: false };

type Action =
  | { type: "event"; event: ServerEvent; selfId: UserId | null; activePeer: UserId | null }
  | { type: "optimistic"; message: Message }
  | { type: "failed"; clientId: string; peer: UserId }
  | { type: "clearUnread"; peer: UserId }
  | { type: "expireTyping"; peer: UserId }
  | { type: "reset" };

function peerOf(message: Message, selfId: UserId | null, broadcastId: UserId | null) {
  return conversationOf(message, selfId ?? "", broadcastId);
}

/** The Alla channel's id, or null before the roster has arrived. */
function broadcastIdOf(users: User[]): UserId | null {
  return users.find((u) => u.kind === "broadcast")?.id ?? null;
}

/** Appends, replacing an optimistic copy when the server's version arrives. */
function merge(existing: Message[] | undefined, message: Message): Message[] {
  const list = existing ?? [];
  if (message.clientId) {
    const index = list.findIndex((m) => m.clientId === message.clientId);
    if (index >= 0) {
      const next = list.slice();
      next[index] = message;
      return next;
    }
  }
  if (list.some((m) => m.id === message.id)) return list;
  return [...list, message];
}

function reduce(state: State, action: Action): State {
  switch (action.type) {
    case "reset":
      return EMPTY;

    case "optimistic": {
      const peer = peerOf(action.message, state.self?.id ?? null, broadcastIdOf(state.users));
      return { ...state, threads: { ...state.threads, [peer]: merge(state.threads[peer], action.message) } };
    }

    case "failed": {
      const list = state.threads[action.peer] ?? [];
      return {
        ...state,
        threads: {
          ...state.threads,
          [action.peer]: list.map((m) =>
            m.clientId === action.clientId ? { ...m, id: `failed:${m.clientId}` } : m,
          ),
        },
      };
    }

    case "clearUnread": {
      if (!state.unread[action.peer]) return state;
      const unread = { ...state.unread };
      delete unread[action.peer];
      return { ...state, unread };
    }

    case "expireTyping": {
      if (!state.typing[action.peer]) return state;
      const typing = { ...state.typing };
      delete typing[action.peer];
      return { ...state, typing };
    }

    case "event":
      return applyEvent(state, action);

    default:
      return state;
  }
}

function applyEvent(state: State, { event, activePeer }: Extract<Action, { type: "event" }>): State {
  switch (event.t) {
    case "ready": {
      const channel = broadcastIdOf(event.users);
      const threads: Record<UserId, Message[]> = {};
      for (const [peer, list] of byConversation(event.history, event.self.id, channel)) {
        threads[peer] = list;
      }

      // Anything unread that arrived while this client was away.
      const unread: Record<UserId, number> = {};
      for (const message of event.history) {
        // A broadcast counts against the channel, not against whoever sent it.
        if (message.to === channel && message.from !== event.self.id) {
          unread[channel] = (unread[channel] ?? 0) + 1;
        } else if (message.to === event.self.id && !message.readAt) {
          unread[message.from] = (unread[message.from] ?? 0) + 1;
        }
      }
      if (activePeer) delete unread[activePeer];

      return {
        self: event.self,
        users: event.users,
        threads,
        unread,
        typing: {},
        tasks: event.tasks ?? [],
        office: event.office ?? null,
        exhausted: {},
        ready: true,
      };
    }

    case "roster":
      return { ...state, users: event.users };

    case "task": {
      const index = state.tasks.findIndex((t) => t.id === event.task.id);
      if (index < 0) return { ...state, tasks: [...state.tasks, event.task] };
      const tasks = state.tasks.slice();
      tasks[index] = event.task;
      return { ...state, tasks };
    }

    case "taskRemoved":
      return { ...state, tasks: state.tasks.filter((t) => t.id !== event.id) };

    case "presence":
      return {
        ...state,
        users: state.users.map((u) =>
          u.id === event.userId
            ? {
                ...u,
                presence: event.presence,
                lastSeen: event.lastSeen,
                availability: event.availability ?? u.availability,
                // `operator` is nullable, so only an absent key means "unchanged".
                operator: "operator" in event ? event.operator ?? null : u.operator,
              }
            : u,
        ),
      };

    case "history": {
      const existing = state.threads[event.withUser] ?? [];
      const known = new Set(existing.map((m) => m.id));
      const older = event.messages.filter((m) => !known.has(m.id));
      return {
        ...state,
        threads: { ...state.threads, [event.withUser]: [...older, ...existing] },
        exhausted: { ...state.exhausted, [event.withUser]: event.exhausted },
      };
    }

    case "message":
    case "ack": {
      const message = event.message;
      const selfId = state.self?.id ?? null;
      const peer = peerOf(message, selfId, broadcastIdOf(state.users));
      const incoming = message.from !== selfId;
      const unread =
        incoming && peer !== activePeer
          ? { ...state.unread, [peer]: (state.unread[peer] ?? 0) + 1 }
          : state.unread;

      // A message from someone ends their typing indicator.
      const typing = { ...state.typing };
      delete typing[peer];

      return { ...state, threads: { ...state.threads, [peer]: merge(state.threads[peer], message) }, unread, typing };
    }

    case "typing":
      return { ...state, typing: { ...state.typing, [event.from]: Date.now() + 4000 } };

    case "read": {
      const list = state.threads[event.from];
      if (!list) return state;
      const at = Date.now();
      return {
        ...state,
        threads: {
          ...state.threads,
          [event.from]: list.map((m) =>
            m.to === event.from && m.sentAt <= event.upTo && !m.readAt ? { ...m, readAt: at } : m,
          ),
        },
      };
    }

    default:
      return state;
  }
}

export function useComms(session: Session | null, settings: Settings) {
  const [state, dispatch] = useReducer(reduce, EMPTY);
  const [connected, setConnected] = useState(false);
  const [activePeer, setActivePeer] = useState<UserId | null>(null);
  const [nudgedBy, setNudgedBy] = useState<UserId | null>(null);
  const realtime = useRef<Realtime | null>(null);

  // Handlers read these through refs so the socket is created once per
  // session rather than being torn down whenever a setting changes.
  const activePeerRef = useRef<UserId | null>(null);
  const settingsRef = useRef(settings);
  const mutedByStatusRef = useRef(false);
  const stateRef = useRef(state);
  activePeerRef.current = activePeer;
  settingsRef.current = settings;
  stateRef.current = state;
  mutedByStatusRef.current =
    state.users.find((u) => u.id === state.self?.id)?.availability === "busy";

  const announce = useCallback((event: ServerEvent) => {
    const current = settingsRef.current;
    const focused = typeof document !== "undefined" && document.hasFocus();
    // Busy means with a patient, which is exactly when a chime is least
    // welcome; the quick mute is the manual equivalent.
    const audible = current.sound && !current.muted && !mutedByStatusRef.current;

    if (event.t === "nudge") {
      if (audible) playNudgeTone(current.volume);
      const from = stateRef.current.users.find((u) => u.id === event.from);
      setNudgedBy(event.from);
      setTimeout(() => setNudgedBy(null), 4000);
      void requestAttention();
      if (current.notifications) void notify("Nudge", `${from?.displayName ?? "Someone"} needs you.`);
      return;
    }

    if (event.t === "task") {
      const task = event.task;
      const self = stateRef.current.self?.id;
      // Only a task somebody else put in your list is worth interrupting for.
      const incoming = task.owner === self && task.createdBy !== self && !task.clearedAt;
      const known = stateRef.current.tasks.some((t) => t.id === task.id);
      if (incoming && !known) {
        if (audible) playMessageTone(current.volume);
        const from = stateRef.current.users.find((u) => u.id === task.createdBy);
        if (current.notifications && !focused) {
          void notify(`Ny uppgift från ${from?.displayName ?? "någon"}`, task.title);
        }
      }
      return;
    }

    if (event.t !== "message") return;
    const message = event.message;
    if (message.from === stateRef.current.self?.id) return;

    if (audible) {
      if (message.alert) playAlertTone(current.volume);
      else playMessageTone(current.volume);
    }

    // Only interrupt with an OS notification when they are not already looking
    // at this conversation.
    const looking = focused && activePeerRef.current === message.from;
    if (message.alert && !focused) void requestAttention();
    if (current.notifications && !looking) {
      const from = stateRef.current.users.find((u) => u.id === message.from);
      const preview = message.body || (message.attachment ? `Sent ${message.attachment.name}` : "");
      void notify(from?.displayName ?? "New message", preview);
    }
  }, []);

  useEffect(() => {
    if (!session) {
      dispatch({ type: "reset" });
      setConnected(false);
      return;
    }

    const socket = new Realtime(
      session,
      (event) => {
        dispatch({ type: "event", event, selfId: null, activePeer: activePeerRef.current });
        announce(event);
      },
      setConnected,
    );
    realtime.current = socket;
    socket.connect();

    return () => {
      socket.close();
      realtime.current = null;
    };
  }, [session, announce]);

  useEffect(() => {
    if (session && settings.notifications) void requestNotificationAccess();
  }, [session, settings.notifications]);

  // Typing indicators are time-based, so they need a tick to expire.
  useEffect(() => {
    const peers = Object.entries(state.typing);
    if (peers.length === 0) return;
    const timer = setInterval(() => {
      const now = Date.now();
      for (const [peer, expires] of Object.entries(stateRef.current.typing)) {
        if (expires <= now) dispatch({ type: "expireTyping", peer });
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [state.typing]);

  const send = useCallback(
    (to: UserId, body: string, options: { alert?: boolean; attachment?: Attachment } = {}) => {
      const selfId = stateRef.current.self?.id;
      if (!selfId) return;
      const clientId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      // Show it immediately; the ack replaces this copy with the server's.
      dispatch({
        type: "optimistic",
        message: {
          id: `pending:${clientId}`,
          clientId,
          from: selfId,
          to,
          body,
          attachment: options.attachment ?? null,
          alert: Boolean(options.alert),
          sentAt: Date.now(),
          readAt: null,
        },
      });

      const delivered = realtime.current?.send({
        t: "send",
        clientId,
        to,
        body,
        alert: options.alert,
        attachment: options.attachment,
      });
      if (!delivered) dispatch({ type: "failed", clientId, peer: to });
    },
    [],
  );

  const nudge = useCallback((to: UserId) => realtime.current?.send({ t: "nudge", to }), []);

  const setAvailability = useCallback(
    (availability: Availability) => realtime.current?.send({ t: "availability", availability }),
    [],
  );

  /** Names, or clears, who is working in this room right now. */
  const setOperator = useCallback(
    (name: string | null) => realtime.current?.send({ t: "operator", name }),
    [],
  );

  /** Pulls in the page of messages before the oldest one already shown. */
  const loadOlder = useCallback((peer: UserId) => {
    const list = stateRef.current.threads[peer] ?? [];
    if (stateRef.current.exhausted[peer]) return;
    realtime.current?.send({ t: "history", withUser: peer, before: list[0]?.sentAt ?? Date.now() });
  }, []);

  const addTask = useCallback(
    (input: { title: string; notes?: string; dueAt?: number | null; owner?: UserId; sourceMessageId?: string }) =>
      realtime.current?.send({ t: "taskAdd", ...input }),
    [],
  );

  const editTask = useCallback(
    (id: string, patch: { title?: string; notes?: string; dueAt?: number | null }) =>
      realtime.current?.send({ t: "taskEdit", id, ...patch }),
    [],
  );

  const clearTask = useCallback(
    (id: string, cleared: boolean) => realtime.current?.send({ t: "taskClear", id, cleared }),
    [],
  );

  const deleteTask = useCallback((id: string) => realtime.current?.send({ t: "taskDelete", id }), []);
  const setTyping = useCallback((to: UserId) => realtime.current?.send({ t: "typing", to }), []);

  const openConversation = useCallback((peer: UserId | null) => {
    setActivePeer(peer);
    if (!peer) return;
    dispatch({ type: "clearUnread", peer });
    const list = stateRef.current.threads[peer];
    const newest = list?.[list.length - 1];
    if (newest) realtime.current?.send({ t: "read", withUser: peer, upTo: newest.sentAt });
  }, []);

  const active = useMemo(
    () => state.users.find((u) => u.id === activePeer) ?? null,
    [state.users, activePeer],
  );

  const totalUnread = useMemo(
    () => Object.values(state.unread).reduce((sum, n) => sum + n, 0),
    [state.unread],
  );

  /**
   * The roster is the live copy of every room, including this one, so `self`
   * is derived from it rather than from the snapshot taken at connect - which
   * never learns about a later status or operator change.
   */
  const liveSelf = useMemo(
    () => state.users.find((u) => u.id === state.self?.id) ?? state.self,
    [state.users, state.self],
  );

  return {
    ...state,
    self: liveSelf,
    connected,
    activePeer,
    active,
    nudgedBy,
    totalUnread,
    messages: activePeer ? state.threads[activePeer] ?? [] : [],
    send,
    nudge,
    setTyping,
    openConversation,
    setAvailability,
    setOperator,
    loadOlder,
    addTask,
    editTask,
    clearTask,
    deleteTask,
    /** Open tasks in your own list, for the sidebar count. */
    openTaskCount: state.tasks.filter(
      (t) => t.owner === state.self?.id && !t.clearedAt,
    ).length,
  };
}
