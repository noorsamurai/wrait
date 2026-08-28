import { useEffect, useRef, useState } from "react";
import type { Message, User, UserId } from "@lokalen/protocol";
import { htmlToPlain } from "../lib/richtext";
import { CloseIcon, SearchIcon } from "./icons";

const when = new Intl.DateTimeFormat("sv-SE", {
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});

interface SearchPanelProps {
  self: User;
  users: User[];
  results: { query: string; messages: Message[] } | null;
  onSearch: (query: string) => void;
  onOpen: (peer: UserId, message: Message) => void;
  onClose: () => void;
}

export function SearchPanel({ self, users, results, onSearch, onOpen, onClose }: SearchPanelProps) {
  const [query, setQuery] = useState("");
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => input.current?.focus(), []);

  // Searching on every keystroke would ask the relay a question per letter.
  useEffect(() => {
    const text = query.trim();
    if (text.length < 2) return;
    const timer = setTimeout(() => onSearch(text), 250);
    return () => clearTimeout(timer);
  }, [query, onSearch]);

  const channel = users.find((u) => u.kind === "broadcast") ?? null;

  /** Which conversation a hit belongs to, the same rule the threads use. */
  function conversationOf(message: Message): UserId {
    if (channel && message.to === channel.id) return channel.id;
    return message.from === self.id ? message.to : message.from;
  }

  function nameOf(id: UserId) {
    return users.find((u) => u.id === id)?.displayName ?? "Okänt rum";
  }

  const messages = results?.messages ?? [];
  const searched = query.trim().length >= 2 && results !== null;

  return (
    <aside className="surface tasks search-panel">
      <div className="tasks__head">
        <h2 className="tasks__title">Sök</h2>
        <button className="btn btn--icon" onClick={onClose} aria-label="Stäng sökning">
          <CloseIcon />
        </button>
      </div>

      <div className="tasks__new">
        <div style={{ position: "relative" }}>
          <span style={{ position: "absolute", left: 12, top: 11, color: "var(--ink-faint)" }}>
            <SearchIcon />
          </span>
          <input
            ref={input}
            className="field"
            style={{ paddingLeft: 36 }}
            placeholder="Sök i meddelanden"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Sök i meddelanden"
          />
        </div>
      </div>

      <div className="tasks__list">
        {!searched ? (
          <p className="tasks__empty">Skriv minst två tecken.</p>
        ) : messages.length === 0 ? (
          <p className="tasks__empty">Inget hittades.</p>
        ) : (
          messages.map((message) => {
            const peer = conversationOf(message);
            return (
              <button
                key={message.id}
                className="search-hit"
                onClick={() => onOpen(peer, message)}
              >
                <span className="search-hit__head">
                  <span className="search-hit__room">{nameOf(peer)}</span>
                  <span className="search-hit__when">{when.format(new Date(message.sentAt))}</span>
                </span>
                <span className="search-hit__body">
                  {message.from === self.id ? "Du: " : ""}
                  {htmlToPlain(message.body) || message.attachment?.name || "Bilaga"}
                </span>
              </button>
            );
          })
        )}
      </div>
    </aside>
  );
}
