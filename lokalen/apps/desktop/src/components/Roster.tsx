import { useMemo, useState } from "react";
import type { Availability, Message, User, UserId } from "@lokalen/protocol";
import { htmlToPlain } from "../lib/richtext";
import { Avatar } from "./Avatar";
import { BellIcon, BellOffIcon, GearIcon, ListIcon, SearchIcon, UsersIcon } from "./icons";

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
  if (last.body) return mine + htmlToPlain(last.body);
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
  /** This room's own state, shown and changed in the footer. */
  availability: Availability;
  onAvailability: (availability: Availability) => void;
  muted: boolean;
  onToggleMute: () => void;
}

export function Roster({
  self, users, threads, unread, typing, activePeer, connected, hidden, onSelect, onOpenSettings, onOpenTasks, openTaskCount,
  availability, onAvailability, muted, onToggleMute,
}: RosterProps) {
  const [query, setQuery] = useState("");

  const channel = useMemo(() => users.find((u) => u.kind === "broadcast") ?? null, [users]);

  const people = useMemo(() => {
    const term = query.trim().toLowerCase();
    return users
      .filter((u) => u.id !== self.id && u.kind !== "broadcast")
      .filter((u) =>
        !term ||
        u.displayName.toLowerCase().includes(term) ||
        (u.operator ?? "").toLowerCase().includes(term),
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

      {/* A search box above four rooms is chrome, not help. It appears once
          there is actually something to search through. */}
      {users.length > 8 ? (
      <div className="roster__search">
        <div style={{ position: "relative" }}>
          <span style={{ position: "absolute", left: 12, top: 12, color: "var(--ink-faint)" }}>
            <SearchIcon />
          </span>
          <input
            className="field"
            style={{ paddingLeft: 36 }}
            placeholder="Sök rum"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Sök rum"
          />
        </div>
      </div>
      ) : null}

      <div className="roster__list" role="listbox" aria-label="Rum">
        {channel && !query ? (
          <button
            className="person"
            role="option"
            aria-selected={channel.id === activePeer}
            onClick={() => onSelect(channel.id)}
          >
            <span className="channel-mark" aria-hidden><UsersIcon size={16} /></span>
            <span className="person__body">
              <span className="person__name">{channel.displayName}</span>
              <span className="person__meta">
                {previewOf(threads[channel.id], self.id) ?? "Alla rum"}
              </span>
            </span>
            {(unread[channel.id] ?? 0) > 0 ? (
              <span className="badge">{unread[channel.id]}</span>
            ) : null}
          </button>
        ) : null}

        {people.length === 0 ? (
          <p className="roster__empty">
            {query ? "Inget rum matchar det." : "Inga andra rum än."}
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
                <Avatar user={user} presence={user.presence} availability={user.availability} />
                <span className="person__body">
                  <span className="person__name">
                    {user.displayName}
                    {user.operator ? <span className="person__operator"> · {user.operator}</span> : null}
                  </span>
                  <span className="person__meta">
                    {isTyping
                      ? "Skriver…"
                      : user.availability === "busy" && user.presence !== "offline"
                        ? "Med patient"
                        : preview ?? lastSeenText(user)}
                  </span>
                </span>
                {count > 0 ? <span className="badge">{count > 99 ? "99+" : count}</span> : null}
              </button>
            );
          })
        )}
      </div>

      <div className="roster__foot">
        <div className="roster__self">
          <Avatar user={self} presence="online" availability={availability} />
          <span className="person__body">
            <span className="person__name">
              {self.displayName}
              {self.operator ? <span className="person__operator"> · {self.operator}</span> : null}
            </span>
            {/* Two states need a switch, not a segmented control on its own
                row: the label says where you are and clicking changes it. */}
            <button
              className="status-toggle"
              data-busy={availability === "busy"}
              onClick={() => onAvailability(availability === "busy" ? "available" : "busy")}
              title={
                availability === "busy"
                  ? "Du är markerad som med patient, ljudet är tyst"
                  : "Markera som med patient (tystar ljudet)"
              }
            >
              {availability === "busy" ? "Med patient" : "Tillgänglig"}
            </button>
          </span>
          {/* Muting lives here rather than in settings: it has to be one
              click from anywhere, which is the whole point of it. */}
          <button
            className="btn btn--icon"
            onClick={onToggleMute}
            aria-pressed={muted}
            aria-label={muted ? "Slå på ljudet" : "Stäng av ljudet"}
            title={muted ? "Ljudet är avstängt" : "Stäng av ljudet"}
          >
            {muted ? <BellOffIcon /> : <BellIcon />}
          </button>
          <button className="btn btn--icon" onClick={onOpenSettings} aria-label="Inställningar">
            <GearIcon />
          </button>
        </div>


      </div>
    </aside>
  );
}
