import { useEffect, useRef, useState } from "react";
import type { Message } from "@lokalen/protocol";
import { formatBytes, canDelete } from "@lokalen/protocol";
import { htmlToPlain, sanitizeHtml } from "../lib/richtext";
import { downloadUrl, type Session } from "../lib/client";
import { saveAttachment } from "../lib/native";
import { BellIcon, BookmarkIcon, DownloadIcon, FileIcon, PencilIcon, TrashIcon } from "./icons";

const time = new Intl.DateTimeFormat("sv-SE", { hour: "2-digit", minute: "2-digit" });

/** Where this bubble sits in a run of consecutive messages from one person. */
export type RunPosition = "only" | "first" | "mid" | "last";

interface MessageBubbleProps {
  message: Message;
  mine: boolean;
  run: RunPosition;
  session: Session;
  /** Saves this message into the reader's own task list. */
  onSaveToTasks: (message: Message) => void;
  saved: boolean;
  onEdit: (id: string, body: string) => void;
  onDelete: (id: string) => void;
  /** Id of the room reading this, for deciding what may be changed. */
  selfId: string;
}

export function MessageBubble({
  message, mine, run, session, onSaveToTasks, saved, onEdit, onDelete, selfId,
}: MessageBubbleProps) {
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const pending = message.id.startsWith("pending:");
  const failed = message.id.startsWith("failed:");
  const deleted = Boolean(message.deletedAt);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.body);
  const [showOriginal, setShowOriginal] = useState(false);
  const editBox = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editing) {
      setDraft(message.body);
      editBox.current?.focus();
    }
  }, [editing, message.body]);

  // The deletion window closes on a timer, so the button has to disappear on
  // its own rather than only when something else re-renders.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (deleted || !mine) return;
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, [deleted, mine]);

  const deletable = !pending && canDelete(message, selfId, now);

  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  /**
   * Copying, with and without what the text is wearing.
   *
   * Pasting a message onward into a journal system usually wants the words
   * and not the styling, so plain text is offered as its own action rather
   * than hidden behind a modifier key nobody discovers.
   */
  async function copy(withFormatting: boolean) {
    setMenu(null);
    const plain = htmlToPlain(message.body);
    try {
      if (withFormatting && typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
        await navigator.clipboard.write([
          new ClipboardItem({
            "text/html": new Blob([sanitizeHtml(message.body)], { type: "text/html" }),
            "text/plain": new Blob([plain], { type: "text/plain" }),
          }),
        ]);
        return;
      }
      await navigator.clipboard.writeText(plain);
    } catch {
      // A denied clipboard is not worth an error dialog over.
    }
  }

  function commitEdit() {
    const next = draft.trim();
    setEditing(false);
    if (next && next !== message.body) onEdit(message.id, next);
  }

  /** Writes the attachment to disk - distinct from saving to the task list. */
  async function downloadAttachment() {
    if (!message.attachment) return;
    setSaving(true);
    setSaveError(null);
    try {
      await saveAttachment(downloadUrl(session, message.attachment.fileId), message.attachment.name);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Nedladdningen misslyckades.");
    } finally {
      setSaving(false);
    }
  }

  const classes = [
    "bubble",
    mine ? "bubble--mine" : "bubble--theirs",
    message.alert ? "bubble--alert" : "",
    pending ? "bubble--pending" : "",
    failed ? "bubble--failed" : "",
  ]
    .filter(Boolean)
    .join(" ");

  if (deleted) {
    return (
      <div className="bubble-row" data-mine={mine}>
        <div className="bubble bubble--tombstone" data-run={run}>
          {mine ? "Du tog bort ett meddelande" : "Ett meddelande togs bort"}
        </div>
      </div>
    );
  }

  return (
    <div className="bubble-row" data-mine={mine}>
      <div
        className={classes}
        data-run={run}
        onContextMenu={(event) => {
          event.preventDefault();
          setMenu({ x: event.clientX, y: event.clientY });
        }}
      >
        <div className="bubble__actions">
          {mine && !pending ? (
            <>
              <button
                className="bubble__action"
                onClick={() => setEditing(true)}
                title="Ändra meddelandet"
                aria-label="Ändra"
              >
                <PencilIcon size={13} />
              </button>
              {deletable ? (
                <button
                  className="bubble__action"
                  onClick={() => onDelete(message.id)}
                  title="Ta bort (går i fem minuter)"
                  aria-label="Ta bort"
                >
                  <TrashIcon size={13} />
                </button>
              ) : null}
            </>
          ) : null}
          <button
            className="bubble__action bubble__save"
            data-saved={saved}
            onClick={() => onSaveToTasks(message)}
            title={saved ? "Redan sparad som uppgift" : "Spara som uppgift"}
            aria-label={saved ? "Redan sparad som uppgift" : "Spara som uppgift"}
          >
            <BookmarkIcon size={13} />
          </button>
        </div>

        {message.alert ? (
          <div className="bubble__alert-tag">
            <BellIcon size={11} /> Signal
          </div>
        ) : null}

        {message.attachment ? (
          <div className="attachment">
            <span className="attachment__icon">
              <FileIcon size={16} />
            </span>
            <span className="attachment__body">
              <span className="attachment__name">{message.attachment.name}</span>
              <span className="attachment__size">
                {saveError ?? formatBytes(message.attachment.size)}
              </span>
            </span>
            <button
              className="btn btn--icon"
              onClick={downloadAttachment}
              disabled={saving || pending}
              aria-label={`Spara ${message.attachment.name}`}
              title="Spara på den här datorn"
            >
              <DownloadIcon size={16} />
            </button>
          </div>
        ) : null}

        {editing ? (
          <div className="bubble__edit">
            <textarea
              ref={editBox}
              className="composer__input"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  commitEdit();
                }
                if (e.key === "Escape") setEditing(false);
              }}
              rows={2}
              aria-label="Ändra meddelandet"
            />
            <div className="bubble__edit-row">
              <button className="btn" onClick={() => setEditing(false)}>Avbryt</button>
              <button className="btn btn--primary" onClick={commitEdit} disabled={!draft.trim()}>
                Spara
              </button>
            </div>
          </div>
        ) : message.body ? (
          // Sanitised again at render: the body arrived over the network, and
          // trusting the sender's client would be the whole vulnerability.
          <div
            className="bubble__body"
            dangerouslySetInnerHTML={{ __html: sanitizeHtml(message.body) }}
          />
        ) : null}

        {/* An edit is never silent: both sides can read what it used to say. */}
        {message.revisions.length > 0 && !editing ? (
          <div className="bubble__history">
            <button className="bubble__edited" onClick={() => setShowOriginal((v) => !v)}>
              {showOriginal ? "Dölj original" : "Ändrad · visa original"}
            </button>
            {showOriginal
              ? message.revisions.map((revision) => (
                  <div key={revision.replacedAt} className="bubble__revision">
                    {revision.body}
                  </div>
                ))
              : null}
          </div>
        ) : null}

        {menu ? (
          <>
            <div className="menu-scrim" onClick={() => setMenu(null)} onContextMenu={(e) => { e.preventDefault(); setMenu(null); }} />
            <div className="menu" style={{ left: menu.x, top: menu.y }} role="menu">
              <button role="menuitem" onClick={() => copy(true)}>Kopiera</button>
              <button role="menuitem" onClick={() => copy(false)}>Kopiera utan formatering</button>
            </div>
          </>
        ) : null}

        <div className="bubble__foot">
          {failed ? (
            <span>Ej levererat</span>
          ) : (
            <>
              <span>{time.format(new Date(message.sentAt))}</span>
              {mine && !pending ? <span>{message.readAt ? "Läst" : "Skickat"}</span> : null}
              {pending ? <span>Skickar…</span> : null}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
