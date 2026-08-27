import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Attachment, Message, User } from "@comms/protocol";
import type { Session } from "../lib/client";
import { Avatar } from "./Avatar";
import { Composer } from "./Composer";
import { MessageBubble, type RunPosition } from "./MessageBubble";
import { BackIcon, BellIcon } from "./icons";

const dayLabel = new Intl.DateTimeFormat(undefined, { weekday: "long", month: "short", day: "numeric" });

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
  onBack: () => void;
}

export function Conversation({
  session, self, peer, messages, typing, onSend, onTyping, onNudge, onBack,
}: ConversationProps) {
  const log = useRef<HTMLDivElement>(null);
  const [dropping, setDropping] = useState(false);
  const [droppedFile, setDroppedFile] = useState<File | null>(null);
  const [nudgeSent, setNudgeSent] = useState(false);

  // Stick to the bottom, but only when the reader is already there - jumping
  // someone away from older messages they are reading is maddening.
  const pinned = useRef(true);
  useLayoutEffect(() => {
    const node = log.current;
    if (!node) return;
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
        <button className="btn btn--icon back-button" onClick={onBack} aria-label="Back to people">
          <BackIcon />
        </button>
        <Avatar user={peer} presence={peer.presence} large />
        <div className="chat__head-body">
          <div className="chat__head-name">{peer.displayName}</div>
          <div className="chat__head-meta">
            {typing
              ? "Typing…"
              : peer.presence === "online"
                ? "Online"
                : peer.presence === "away"
                  ? "Away"
                  : "Offline"}
          </div>
        </div>
        <button
          className="btn"
          onClick={nudge}
          disabled={nudgeSent}
          title={`Make ${peer.displayName}'s computer chime`}
        >
          <BellIcon size={15} />
          {nudgeSent ? "Nudged" : "Nudge"}
        </button>
      </header>

      <div className="chat__log" ref={log} onScroll={onScroll}>
        {messages.length === 0 ? (
          <p className="chat__empty">
            This is the start of your conversation with {peer.displayName}.
            <br />
            Drop a file anywhere here to send it.
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
                />
              </div>
            );
          })
        )}
      </div>

      <Composer
        session={session}
        peer={peer.id}
        peerName={peer.displayName.split(" ")[0]}
        onSend={onSend}
        onTyping={onTyping}
        droppedFile={droppedFile}
        onDroppedFileHandled={() => setDroppedFile(null)}
      />
    </section>
  );
}
