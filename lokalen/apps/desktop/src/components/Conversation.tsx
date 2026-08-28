import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Attachment, Message, User } from "@lokalen/protocol";
import type { Session } from "../lib/client";
import { Avatar } from "./Avatar";
import { Composer } from "./Composer";
import { MessageBubble, type RunPosition } from "./MessageBubble";
import { ArrowRightIcon, BackIcon, BellIcon } from "./icons";

const dayLabel = new Intl.DateTimeFormat("sv-SE", { weekday: "long", day: "numeric", month: "long" });

function sameDay(a: number, b: number) {
  const x = new Date(a);
  const y = new Date(b);
  return x.toDateString() === y.toDateString();
}

/** Groups consecutive messages from one person so bubbles can tuck together. */
function runPosition(messages: Message[], index: number): RunPosition {
  const current = messages[index];
  const previous = messages[index - 1];
  const next = messages[index + 1];

  // A gap of more than five minutes breaks a run even from the same person.
  const joinsPrevious =
    previous?.from === current.from && current.sentAt - previous.sentAt < 5 * 60_000;
  const joinsNext = next?.from === current.from && next.sentAt - current.sentAt < 5 * 60_000;

  if (joinsPrevious && joinsNext) return "mid";
  if (joinsPrevious) return "last";
  if (joinsNext) return "first";
  return "only";
}

interface ConversationProps {
  session: Session;
  self: User;
  peer: User;
  messages: Message[];
  typing: boolean;
  onSend: (body: string, options: { alert?: boolean; attachment?: Attachment }) => void;
  onTyping: () => void;
  onNudge: () => void;
  /** Sends "please come to this room", naming this room, in one tap. */
  onComeHere: () => void;
  onBack: () => void;
  onSaveMessage: (message: Message) => void;
  /** Ids of messages already saved into the task list. */
  savedMessageIds: Set<string>;
  onEditMessage: (id: string, body: string) => void;
  onDeleteMessage: (id: string) => void;
  /** Asks for the page of messages before the oldest one shown. */
  onLoadOlder: () => void;
  exhausted: boolean;
}

export function Conversation({
  session, self, peer, messages, typing, onSend, onTyping, onNudge, onBack,
  onSaveMessage, savedMessageIds, onEditMessage, onDeleteMessage, onLoadOlder, exhausted, onComeHere,
}: ConversationProps) {
  const log = useRef<HTMLDivElement>(null);
  const [dropping, setDropping] = useState(false);
  const [droppedFile, setDroppedFile] = useState<File | null>(null);
  const [nudgeSent, setNudgeSent] = useState(false);
  const [called, setCalled] = useState(false);

  // Stick to the bottom, but only when the reader is already there - jumping
  // someone away from older messages they are reading is maddening.
  const pinned = useRef(true);
  const loadingOlder = useRef(false);
  const anchor = useRef<number | null>(null);
  useLayoutEffect(() => {
    const node = log.current;
    if (!node) return;
    if (anchor.current !== null) {
      // Older messages were prepended: restore the reader's position relative
      // to the bottom, so the view does not lurch.
      node.scrollTop = node.scrollHeight - anchor.current;
      anchor.current = null;
      loadingOlder.current = false;
      return;
    }
    if (pinned.current) node.scrollTop = node.scrollHeight;
  }, [messages, typing]);

  useEffect(() => {
    pinned.current = true;
    const node = log.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [peer.id]);

  function onScroll() {
    const node = log.current;
    if (!node) return;
    pinned.current = node.scrollHeight - node.scrollTop - node.clientHeight < 60;

    // Near the top: pull in the page behind what is shown. Anchoring keeps the
    // reader where they were instead of jumping them to the new top.
    if (node.scrollTop < 120 && !exhausted && !loadingOlder.current) {
      loadingOlder.current = true;
      anchor.current = node.scrollHeight - node.scrollTop;
      onLoadOlder();
    }
  }

  function nudge() {
    onNudge();
    setNudgeSent(true);
    setTimeout(() => setNudgeSent(false), 2000);
  }

  return (
    <section
      className="surface chat"
      data-dropping={dropping}
      onDragOver={(e) => {
        // Only react to an actual file drag, not text selections.
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        setDropping(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node)) return;
        setDropping(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDropping(false);
        const file = e.dataTransfer.files?.[0];
        if (file) setDroppedFile(file);
      }}
    >
      <header className="chat__head">
        <button className="btn btn--icon back-button" onClick={onBack} aria-label="Tillbaka till personer">
          <BackIcon />
        </button>
        <Avatar user={peer} presence={peer.presence} large />
        <div className="chat__head-body">
          <div className="chat__head-name">
            {peer.displayName}
            {peer.operator ? <span className="person__operator"> · {peer.operator}</span> : null}
          </div>
          <div className="chat__head-meta">
            {typing
              ? "Skriver…"
              : peer.kind === "broadcast"
                ? "Alla rum"
                : peer.presence === "offline"
                  ? "Offline"
                  : peer.availability === "busy"
                    ? "Med patient"
                    : "Online"}
          </div>
        </div>
        {peer.kind === "broadcast" ? null : (
        <button
          className="btn"
          onClick={() => { onComeHere(); setCalled(true); setTimeout(() => setCalled(false), 2500); }}
          disabled={called}
          title={`Ber ${peer.displayName} komma till ${self.displayName}`}
        >
          <ArrowRightIcon size={15} />
          {called ? "Bad dem" : "Kom hit"}
        </button>
        )}

        {peer.kind === "broadcast" ? null : (
        <button
          className="btn"
          onClick={nudge}
          disabled={nudgeSent}
          title={`Få ${peer.displayName}s dator att pipa`}
        >
          <BellIcon size={15} />
          {nudgeSent ? "Puffad" : "Puffa"}
        </button>
        )}
      </header>

      <div className="chat__log" ref={log} onScroll={onScroll}>
        {messages.length > 0 && !exhausted ? (
          <button className="chat__older" onClick={onLoadOlder}>Visa äldre meddelanden</button>
        ) : null}
        {messages.length === 0 ? (
          <p className="chat__empty">
            {peer.kind === "broadcast"
              ? "Allt som skrivs här syns i alla rum."
              : `Här börjar din konversation med ${peer.displayName}.`}
            <br />
            Släpp en fil var som helst här för att skicka den.
          </p>
        ) : (
          messages.map((message, index) => {
            const previous = messages[index - 1];
            const showDay = !previous || !sameDay(previous.sentAt, message.sentAt);
            return (
              <div key={message.id} style={{ display: "contents" }}>
                {showDay ? <div className="day">{dayLabel.format(new Date(message.sentAt))}</div> : null}
                <MessageBubble
                  message={message}
                  mine={message.from === self.id}
                  run={runPosition(messages, index)}
                  session={session}
                  onSaveToTasks={onSaveMessage}
                  saved={savedMessageIds.has(message.id)}
                  onEdit={onEditMessage}
                  onDelete={onDeleteMessage}
                  selfId={self.id}
                />
              </div>
            );
          })
        )}
      </div>

      <Composer
        session={session}
        peer={peer.id}
        peerName={peer.displayName}
        onSend={onSend}
        onTyping={onTyping}
        droppedFile={droppedFile}
        onDroppedFileHandled={() => setDroppedFile(null)}
      />
    </section>
  );
}
