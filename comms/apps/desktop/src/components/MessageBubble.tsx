import { useState } from "react";
import type { Message } from "@comms/protocol";
import { formatBytes } from "@comms/protocol";
import { downloadUrl, type Session } from "../lib/client";
import { saveAttachment } from "../lib/native";
import { BellIcon, DownloadIcon, FileIcon } from "./icons";

const time = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

/** Where this bubble sits in a run of consecutive messages from one person. */
export type RunPosition = "only" | "first" | "mid" | "last";

interface MessageBubbleProps {
  message: Message;
  mine: boolean;
  run: RunPosition;
  session: Session;
}

export function MessageBubble({ message, mine, run, session }: MessageBubbleProps) {
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const pending = message.id.startsWith("pending:");
  const failed = message.id.startsWith("failed:");

  async function onSave() {
    if (!message.attachment) return;
    setSaving(true);
    setSaveError(null);
    try {
      await saveAttachment(downloadUrl(session, message.attachment.fileId), message.attachment.name);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "The download failed.");
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
        {message.alert ? (
          <div className="bubble__alert-tag">
            <BellIcon size={11} /> Alert
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
              onClick={onSave}
              disabled={saving || pending}
              aria-label={`Save ${message.attachment.name}`}
              title="Save to this computer"
            >
              <DownloadIcon size={16} />
            </button>
          </div>
        ) : null}

        {message.body ? <div>{message.body}</div> : null}

        <div className="bubble__foot">
          {failed ? (
            <span>Not delivered</span>
          ) : (
            <>
              <span>{time.format(new Date(message.sentAt))}</span>
              {mine && !pending ? <span>{message.readAt ? "Read" : "Sent"}</span> : null}
              {pending ? <span>Sending…</span> : null}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
