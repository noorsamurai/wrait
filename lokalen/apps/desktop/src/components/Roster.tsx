import { useMemo, useState } from "react";
import type { Message, User, UserId } from "@lokalen/protocol";
import { Avatar } from "./Avatar";
import { GearIcon, ListIcon, SearchIcon } from "./icons";

/** Relative last-seen text, coarse on purpose - nobody needs the seconds. */
function lastSeenText(user: User): string {
  if (user.presence === "online") return "Online";
  if (user.presence === "away") return "Borta";
  if (!user.lastSeen) return "Aldrig inloggad";

  const minutes = Math.floor((Date.now() - user.lastSeen) / 60000);
  if (minutes < 1) return "Nyss";
  if (minutes < 60) return `${minutes} min sedan`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} tim sedan`;
  return `${Math.floor(hours / 24)} dgr sedan`;
}

function previewOf(messages: Message[] | undefined, selfId: UserId): string | null {
  const last = messages?.[messages.length - 1];
  if (!last) return null;
  const mine = last.from === selfId ? "Du: " : "";
  if (last.body) return mine + last.body;
  if (last.attachment) return `${mine}${last.attachment.name}`;
  return null;
}

interface RosterProps {
  self: User;
  users: User[];
  threads: Record<UserId, Message[]>;
  unread: Record<UserId, number>;
  typing: Record<UserId, number>;
  activePeer: UserId | null;
  connected: boolean;
  hidden: boolean;
  onSelect: (id: UserId) => void;
  onOpenSettings: () => void;
  onOpenTasks: () => void;
  openTaskCount: number;
}

export function Roster({
  self, users, threads, unread, typing, activePeer, connected, hidden, onSelect, onOpenSettings, onOpenTasks, openTaskCount,
}: RosterProps) {
  const [query, setQuery] = useState("");

  const people = useMemo(() => {
    const term = query.trim().toLowerCase();
    return users
      .filter((u) => u.id !== self.id)
      .filter((u) =>
        !term ||
        u.displayName.toLowerCase().includes(term) ||
        u.username.toLowerCase().includes(term),
      )
      .sort((a, b) => {
        // Unread first, then anyone online, then the most recent conversation.
        const unreadDelta = (unread[b.id] ?? 0) - (unread[a.id] ?? 0);
        if (unreadDelta) return unreadDelta;

        const onlineDelta = Number(b.presence !== "offline") - Number(a.presence !== "offline");
        if (onlineDelta) return onlineDelta;

        const aLast = threads[a.id]?.at(-1)?.sentAt ?? 0;
        const bLast = threads[b.id]?.at(-1)?.sentAt ?? 0;
        if (aLast !== bLast) return bLast - aLast;

        return a.displayName.localeCompare(b.displayName);
      });
  }, [users, self.id, query, unread, threads]);

  return (
    <aside className="surface roster" data-hidden={hidden}>
      <div className="roster__head">
        <h1 className="roster__title">Kontoret</h1>
        <span
          className="status-dot"
          data-up={connected}
          title={connected ? "Ansluten" : "Återansluter…"}
        />
        <button
          className="btn btn--icon"
          onClick={onOpenTasks}
          aria-label="Att göra"
          title="Att göra"
        >
          <ListIcon />
        </button>
        {openTaskCount > 0 ? <span className="badge">{openTaskCount}</span> : null}
      </div>

      <div className="roster__search">
        <div style={{ position: "relative" }}>
          <span style={{ position: "absolute", left: 12, top: 12, color: "var(--ink-faint)" }}>
            <SearchIcon />
          </span>
          <input
            className="field"
            style={{ paddingLeft: 36 }}
            placeholder="Sök person"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Sök person"
          />
        </div>
      </div>

      <div className="roster__list" role="listbox" aria-label="Personer">
        {people.length === 0 ? (
          <p className="roster__empty">
            {query ? "Ingen matchar det." : "Ingen annan har anslutit än."}
          </p>
        ) : (
          people.map((user) => {
            const count = unread[user.id] ?? 0;
            const isTyping = (typing[user.id] ?? 0) > Date.now();
            const preview = previewOf(threads[user.id], self.id);
            return (
              <button
                key={user.id}
                className="person"
                role="option"
                aria-selected={user.id === activePeer}
                onClick={() => onSelect(user.id)}
              >
                <Avatar user={user} presence={user.presence} />
                <span className="person__body">
                  <span className="person__name">{user.displayName}</span>
                  <span className="person__meta">
                    {isTyping ? "Skriver…" : preview ?? lastSeenText(user)}
                  </span>
                </span>
                {count > 0 ? <span className="badge">{count > 99 ? "99+" : count}</span> : null}
              </button>
            );
          })
        )}
      </div>

      <div className="roster__foot">
        <Avatar user={self} presence="online" />
        <span className="person__body">
          <span className="person__name">{self.displayName}</span>
          <span className="person__meta">@{self.username}</span>
        </span>
        <button className="btn btn--icon" onClick={onOpenSettings} aria-label="Inställningar">
          <GearIcon />
        </button>
      </div>
    </aside>
  );
}
