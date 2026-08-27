import { useState } from "react";
import type { Message } from "@lokalen/protocol";
import { formatBytes } from "@lokalen/protocol";
import { downloadUrl, type Session } from "../lib/client";
import { saveAttachment } from "../lib/native";
import { BellIcon, BookmarkIcon, DownloadIcon, FileIcon } from "./icons";

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
}

export function MessageBubble({ message, mine, run, session, onSaveToTasks, saved }: MessageBubbleProps) {
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const pending = message.id.startsWith("pending:");
  const failed = message.id.startsWith("failed:");

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

  return (
    <div className="bubble-row" data-mine={mine}>
      <div className={classes} data-run={run}>
        <button
          className="bubble__save"
          data-saved={saved}
          onClick={() => onSaveToTasks(message)}
          title={saved ? "Redan sparad som uppgift" : "Spara som uppgift"}
          aria-label={saved ? "Redan sparad som uppgift" : "Spara som uppgift"}
        >
          <BookmarkIcon size={14} />
        </button>

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

        {message.body ? <div>{message.body}</div> : null}

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
