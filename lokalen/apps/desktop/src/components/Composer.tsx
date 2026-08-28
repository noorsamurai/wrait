import { useEffect, useRef, useState } from "react";
import type { Attachment, UserId } from "@lokalen/protocol";
import { formatBytes, MAX_FILE_BYTES } from "@lokalen/protocol";
import { uploadFile, type Session } from "../lib/client";
import { loadDraft, saveDraft } from "../lib/settings";
import { BellIcon, PaperclipIcon, SendIcon } from "./icons";

interface ComposerProps {
  session: Session;
  peer: UserId;
  peerName: string;
  onSend: (body: string, options: { alert?: boolean; attachment?: Attachment }) => void;
  onTyping: () => void;
  /** Set by the parent when a file is dropped onto the conversation. */
  droppedFile: File | null;
  onDroppedFileHandled: () => void;
}

export function Composer({
  session, peer, peerName, onSend, onTyping, droppedFile, onDroppedFileHandled,
}: ComposerProps) {
  const [text, setText] = useState(() => loadDraft(peer));
  const [alert, setAlert] = useState(false);
  const [upload, setUpload] = useState<{ name: string; sent: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const lastTyping = useRef(0);

  // Switching conversation swaps in that conversation's own draft rather than
  // discarding what was typed.
  useEffect(() => {
    setText(loadDraft(peer));
    setAlert(false);
    setError(null);
  }, [peer]);

  useEffect(() => {
    saveDraft(peer, text);
  }, [peer, text]);

  // Grow the textarea with its content, up to the CSS max-height.
  useEffect(() => {
    const node = textarea.current;
    if (!node) return;
    node.style.height = "auto";
    node.style.height = `${Math.min(node.scrollHeight, 140)}px`;
  }, [text]);

  async function transfer(file: File) {
    if (file.size > MAX_FILE_BYTES) {
      setError(`${file.name} är större än gränsen på 2 GB.`);
      return;
    }
    setError(null);
    setUpload({ name: file.name, sent: 0, total: file.size });
    try {
      const attachment = await uploadFile(session, file, peer, (sent, total) =>
        setUpload({ name: file.name, sent, total }),
      );
      // Send the caption typed while the upload was running, if any.
      onSend(text.trim(), { alert, attachment });
      setText("");
      saveDraft(peer, "");
      setAlert(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Överföringen misslyckades.");
    } finally {
      setUpload(null);
    }
  }

  useEffect(() => {
    if (droppedFile) {
      void transfer(droppedFile);
      onDroppedFileHandled();
    }
    // `transfer` closes over the current text/alert on purpose: a drop should
    // carry whatever caption is in the box at that moment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [droppedFile]);

  function submit() {
    const body = text.trim();
    if (!body || upload) return;
    onSend(body, { alert });
    setText("");
    saveDraft(peer, "");
    setAlert(false);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Enter sends; Shift+Enter is a newline. Familiar from every chat app.
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  }

  function onChange(event: React.ChangeEvent<HTMLTextAreaElement>) {
    setText(event.target.value);
    // Throttle: one typing ping per two seconds is plenty.
    const now = Date.now();
    if (now - lastTyping.current > 2000) {
      lastTyping.current = now;
      onTyping();
    }
  }

  return (
    <div className="composer">
      {upload ? (
        <div className="transfer">
          <span style={{ maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {upload.name}
          </span>
          <span className="transfer__bar">
            <span
              className="transfer__fill"
              style={{ width: `${upload.total ? (upload.sent / upload.total) * 100 : 0}%` }}
            />
          </span>
          <span>{formatBytes(upload.sent)} / {formatBytes(upload.total)}</span>
        </div>
      ) : null}

      {error ? <div className="notice" style={{ marginBottom: 9 }}>{error}</div> : null}

      <div className="composer__row">
        <button
          className="btn btn--icon"
          onClick={() => fileInput.current?.click()}
          disabled={Boolean(upload)}
          aria-label="Bifoga en fil"
          title="Bifoga en fil"
        >
          <PaperclipIcon />
        </button>

        <input
          ref={fileInput}
          type="file"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void transfer(file);
            // Clear, so picking the same file twice still fires a change.
            e.target.value = "";
          }}
        />

        <textarea
          ref={textarea}
          className="composer__input"
          placeholder={`Meddelande till ${peerName}`}
          value={text}
          onChange={onChange}
          onKeyDown={onKeyDown}
          rows={1}
          aria-label={`Meddelande till ${peerName}`}
        />

        <button
          className="btn btn--icon toggle-alert"
          aria-pressed={alert}
          onClick={() => setAlert((on) => !on)}
          title="Spela upp en signal på deras dator"
          aria-label="Skicka med ljudsignal"
        >
          <BellIcon />
        </button>

        <button
          className="btn btn--primary btn--icon"
          onClick={submit}
          disabled={!text.trim() || Boolean(upload)}
          aria-label="Skicka"
        >
          <SendIcon />
        </button>
      </div>

      <div className="composer__hint">
        <span>Enter skickar · Skift+Enter ger ny rad</span>
        {alert ? <span style={{ color: "var(--alert)" }}>Deras dator kommer att pipa</span> : null}
      </div>
    </div>
  );
}
