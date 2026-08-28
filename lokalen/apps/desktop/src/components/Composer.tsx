import { useEffect, useRef, useState } from "react";
import type { Attachment, UserId } from "@lokalen/protocol";
import { formatBytes, MAX_FILE_BYTES } from "@lokalen/protocol";
import { uploadFile, type Session } from "../lib/client";
import { loadDraft, saveDraft } from "../lib/settings";
import { sanitizeHtml } from "../lib/richtext";
import { BellIcon, ImageIcon, PaperclipIcon, SendIcon } from "./icons";
import { PhotoComposer } from "./PhotoComposer";

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
  // The editor's DOM is the source of truth while typing; writing state back
      // into it on every keystroke would move the caret to the end.
  const [text, setText] = useState(() => loadDraft(peer));
  const [alert, setAlert] = useState(false);
  const [upload, setUpload] = useState<{ name: string; sent: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const photoInput = useRef<HTMLInputElement>(null);
  const [photos, setPhotos] = useState<File[] | null>(null);
  const editor = useRef<HTMLDivElement>(null);
  const lastTyping = useRef(0);

  // Switching conversation swaps in that conversation's own draft rather than
  // discarding what was typed.
  useEffect(() => {
    const draft = loadDraft(peer);
    setText(draft);
    if (editor.current) editor.current.innerHTML = draft;
    setAlert(false);
    setError(null);
  }, [peer]);

  useEffect(() => {
    saveDraft(peer, text);
  }, [peer, text]);

  function clearEditor() {
    setText("");
    saveDraft(peer, "");
    if (editor.current) editor.current.innerHTML = "";
  }

  /**
   * Keeps what was pasted rather than flattening it.
   *
   * The clipboard's HTML goes through the sanitiser first, so formatting
   * survives but anything that came along with it does not.
   */
  function onPaste(event: React.ClipboardEvent<HTMLDivElement>) {
    event.preventDefault();
    const html = event.clipboardData.getData("text/html");
    const plain = event.clipboardData.getData("text/plain");
    const fragment = html ? sanitizeHtml(html) : escapePlain(plain);
    if (!fragment) return;

    // execCommand is deprecated but is still the only thing that inserts at
    // the caret and leaves the browser's own undo stack intact.
    document.execCommand("insertHTML", false, fragment);
    if (editor.current) setText(editor.current.innerHTML);
  }

  function escapePlain(value: string) {
    return value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\n/g, "<br>");
  }

  /**
   * Sends the edited photos one after another.
   *
   * Sequential rather than parallel: several phone photos at once would have
   * every chunked upload competing for the same office Wi-Fi.
   */
  async function sendPhotos(edited: { blob: Blob; name: string }[]) {
    setPhotos(null);
    for (const item of edited) {
      await transfer(new File([item.blob], item.name, { type: item.blob.type }));
    }
  }

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
      onSend(sanitizeHtml(text), { alert, attachment });
      clearEditor();
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
    const body = sanitizeHtml(text);
    if (!plainLength(body) || upload) return;
    onSend(body, { alert });
    clearEditor();
    setAlert(false);
  }

  /** Length of the visible text, so markup alone never counts as a message. */
  function plainLength(html: string) {
    return html.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").trim().length;
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    // Enter sends; Shift+Enter is a newline. Familiar from every chat app.
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  }

  function onInput() {
    setText(editor.current?.innerHTML ?? "");
    // Throttle: one typing ping per two seconds is plenty.
    const now = Date.now();
    if (now - lastTyping.current > 2000) {
      lastTyping.current = now;
      onTyping();
    }
  }

  return (
    <div className="composer">
      {photos ? (
        <PhotoComposer
          files={photos}
          peerName={peerName}
          onCancel={() => setPhotos(null)}
          onSend={sendPhotos}
        />
      ) : null}

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
        {/* accept="image/*" is what makes iOS offer its own photo sheet -
            Fotobibliotek, Ta foto, Bläddra - with real multi-select. */}
        <button
          className="btn btn--icon"
          onClick={() => photoInput.current?.click()}
          disabled={Boolean(upload)}
          aria-label="Skicka bilder"
          title="Skicka bilder"
        >
          <ImageIcon />
        </button>

        <input
          ref={photoInput}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => {
            const picked = Array.from(e.target.files ?? []);
            if (picked.length) setPhotos(picked);
            e.target.value = "";
          }}
        />

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

        <div
          ref={editor}
          className="composer__input"
          contentEditable
          suppressContentEditableWarning
          role="textbox"
          aria-multiline="true"
          data-placeholder={`Meddelande till ${peerName}`}
          onInput={onInput}
          onPaste={onPaste}
          onKeyDown={onKeyDown}
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
          disabled={!plainLength(text) || Boolean(upload)}
          aria-label="Skicka"
        >
          <SendIcon />
        </button>
      </div>

      {/* Shown while composing rather than permanently: it is a reminder,
          not a label, and an always-on instruction is just noise. */}
      {plainLength(text) > 0 || alert ? (
        <div className="composer__hint">
          {plainLength(text) > 0 ? <span>Enter skickar · Skift+Enter ger ny rad</span> : null}
          {alert ? <span style={{ color: "var(--alert)" }}>Deras dator kommer att pipa</span> : null}
        </div>
      ) : null}
    </div>
  );
}
