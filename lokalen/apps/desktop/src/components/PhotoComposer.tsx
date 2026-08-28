import { useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_OUTPUT, FORMAT_LABELS, FULL_CROP, SIZE_OPTIONS,
  loadBitmap, outputName, outputSize, renderPhoto,
  type Crop, type PhotoEdit, type PhotoFormat, type PhotoOutput,
} from "../lib/photo";
import { formatBytes } from "@lokalen/protocol";
import { CloseIcon, RotateIcon, SendIcon } from "./icons";

interface Picked {
  file: File;
  bitmap: ImageBitmap;
  edit: PhotoEdit;
}

interface PhotoComposerProps {
  files: File[];
  peerName: string;
  onCancel: () => void;
  onSend: (photos: { blob: Blob; name: string }[]) => void;
}

const QUALITIES = [
  { label: "Hög", value: 0.92 },
  { label: "Mellan", value: 0.8 },
  { label: "Låg", value: 0.6 },
];

/** Clamps a crop rectangle inside the picture. */
function clamp(crop: Crop): Crop {
  const width = Math.min(1, Math.max(0.05, crop.width));
  const height = Math.min(1, Math.max(0.05, crop.height));
  return {
    width,
    height,
    x: Math.min(1 - width, Math.max(0, crop.x)),
    y: Math.min(1 - height, Math.max(0, crop.y)),
  };
}

export function PhotoComposer({ files, peerName, onCancel, onSend }: PhotoComposerProps) {
  const [photos, setPhotos] = useState<Picked[] | null>(null);
  const [current, setCurrent] = useState(0);
  const [output, setOutput] = useState<PhotoOutput>(DEFAULT_OUTPUT);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const frame = useRef<HTMLDivElement>(null);

  // Decoding is the slow part, so it happens once per photo up front.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const decoded = await Promise.all(
          files.map(async (file) => ({
            file,
            bitmap: await loadBitmap(file),
            edit: { rotation: 0, crop: FULL_CROP } as PhotoEdit,
          })),
        );
        if (!cancelled) setPhotos(decoded);
      } catch {
        if (!cancelled) setError("Kunde inte läsa bilderna.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [files]);

  const photo = photos?.[current] ?? null;

  const estimate = useMemo(() => {
    if (!photos) return null;
    // A rough guide, not a promise: enough to tell 400 kB from 12 MB before
    // sending eight photos over clinic Wi-Fi.
    const bytesPerPixel = output.format === "image/png" ? 3 : output.quality * 0.6;
    return photos.reduce((total, item) => {
      const size = outputSize(item.bitmap, item.edit, output);
      return total + size.width * size.height * bytesPerPixel * 0.35;
    }, 0);
  }, [photos, output]);

  function updateEdit(patch: Partial<PhotoEdit>) {
    setPhotos((list) =>
      list ? list.map((item, i) => (i === current ? { ...item, edit: { ...item.edit, ...patch } } : item)) : list,
    );
  }

  function rotate(direction: 1 | -1) {
    if (!photo) return;
    const next = (((photo.edit.rotation + direction * 90) % 360) + 360) % 360;
    updateEdit({ rotation: next as PhotoEdit["rotation"] });
  }

  /** Drag inside to move the crop, drag a corner to resize it. */
  function startDrag(event: React.PointerEvent, corner: null | "nw" | "ne" | "sw" | "se") {
    if (!photo || !frame.current) return;
    event.preventDefault();
    event.stopPropagation();
    const box = frame.current.getBoundingClientRect();
    const start = { x: event.clientX, y: event.clientY };
    const origin = photo.edit.crop;
    const target = event.currentTarget as HTMLElement;
    target.setPointerCapture(event.pointerId);

    const move = (moveEvent: PointerEvent) => {
      const dx = (moveEvent.clientX - start.x) / box.width;
      const dy = (moveEvent.clientY - start.y) / box.height;

      if (!corner) {
        updateEdit({ crop: clamp({ ...origin, x: origin.x + dx, y: origin.y + dy }) });
        return;
      }
      const west = corner === "nw" || corner === "sw";
      const north = corner === "nw" || corner === "ne";
      const x = west ? origin.x + dx : origin.x;
      const y = north ? origin.y + dy : origin.y;
      const width = west ? origin.width - dx : origin.width + dx;
      const height = north ? origin.height - dy : origin.height + dy;
      updateEdit({ crop: clamp({ x, y, width, height }) });
    };

    const stop = () => {
      target.releasePointerCapture(event.pointerId);
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", stop);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", stop);
  }

  async function send() {
    if (!photos) return;
    setWorking(true);
    setError(null);
    try {
      const rendered = await Promise.all(
        photos.map(async (item) => ({
          blob: await renderPhoto(item.file, item.bitmap, item.edit, output),
          name: outputName(item.file.name, output.format),
        })),
      );
      onSend(rendered);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kunde inte behandla bilderna.");
      setWorking(false);
    }
  }

  const crop = photo?.edit.crop ?? FULL_CROP;

  return (
    <div className="sheet-scrim" role="dialog" aria-modal="true" aria-label="Skicka bilder">
      <div className="surface surface--raised photo-sheet">
        <header className="photo-sheet__head">
          <h2>{files.length === 1 ? "Skicka bild" : `Skicka ${files.length} bilder`}</h2>
          <span className="row__hint">till {peerName}</span>
          <button className="btn btn--icon" onClick={onCancel} aria-label="Avbryt">
            <CloseIcon />
          </button>
        </header>

        {!photos ? (
          <p className="tasks__empty">Läser bilderna…</p>
        ) : (
          <>
            {photos.length > 1 ? (
              <div className="photo-strip">
                {photos.map((item, index) => (
                  <button
                    key={index}
                    className="photo-strip__item"
                    aria-selected={index === current}
                    onClick={() => setCurrent(index)}
                  >
                    <img src={URL.createObjectURL(item.file)} alt={item.file.name} />
                  </button>
                ))}
              </div>
            ) : null}

            {photo ? (
              <div
                className="photo-frame"
                ref={frame}
                style={{ ["--rot" as string]: `${photo.edit.rotation}deg` }}
              >
                <img
                  className="photo-frame__image"
                  src={URL.createObjectURL(photo.file)}
                  alt=""
                  draggable={false}
                />
                <div
                  className="photo-crop"
                  onPointerDown={(e) => startDrag(e, null)}
                  style={{
                    left: `${crop.x * 100}%`,
                    top: `${crop.y * 100}%`,
                    width: `${crop.width * 100}%`,
                    height: `${crop.height * 100}%`,
                  }}
                >
                  {(["nw", "ne", "sw", "se"] as const).map((corner) => (
                    <span
                      key={corner}
                      className={`photo-crop__handle photo-crop__handle--${corner}`}
                      onPointerDown={(e) => startDrag(e, corner)}
                    />
                  ))}
                </div>
              </div>
            ) : null}

            <div className="photo-tools">
              <button className="btn" onClick={() => rotate(-1)} aria-label="Vrid vänster">
                <RotateIcon size={15} /> Vänster
              </button>
              <button className="btn" onClick={() => rotate(1)} aria-label="Vrid höger">
                <RotateIcon size={15} flip /> Höger
              </button>
              <button className="btn" onClick={() => updateEdit({ crop: FULL_CROP })}>
                Återställ beskärning
              </button>
            </div>

            <div className="photo-options">
              <div className="photo-option">
                <span className="label">Format</span>
                <div className="tasks__quick">
                  {(Object.keys(FORMAT_LABELS) as PhotoFormat[]).map((format) => (
                    <button
                      key={format}
                      className="chip"
                      aria-pressed={output.format === format}
                      onClick={() => setOutput((o) => ({ ...o, format }))}
                    >
                      {FORMAT_LABELS[format]}
                    </button>
                  ))}
                </div>
              </div>

              <div className="photo-option">
                <span className="label">Storlek</span>
                <div className="tasks__quick">
                  {SIZE_OPTIONS.map((option) => (
                    <button
                      key={option.label}
                      className="chip"
                      aria-pressed={output.maxEdge === option.maxEdge}
                      onClick={() => setOutput((o) => ({ ...o, maxEdge: option.maxEdge }))}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>

              {output.format === "image/png" ? null : (
                <div className="photo-option">
                  <span className="label">Kvalitet</span>
                  <div className="tasks__quick">
                    {QUALITIES.map((option) => (
                      <button
                        key={option.label}
                        className="chip"
                        aria-pressed={output.quality === option.value}
                        onClick={() => setOutput((o) => ({ ...o, quality: option.value }))}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div className="row">
                <span className="row__body">
                  <span className="row__label">Behåll datum och tid</span>
                  <span className="row__hint">
                    Allt annat tas bort. Plats och telefonmodell följer aldrig med.
                    {output.format === "image/png" ? " Gäller bara JPEG." : ""}
                  </span>
                </span>
                <button
                  type="button"
                  className="switch"
                  role="switch"
                  aria-checked={output.keepDateTaken}
                  aria-label="Behåll datum och tid"
                  onClick={() => setOutput((o) => ({ ...o, keepDateTaken: !o.keepDateTaken }))}
                />
              </div>
            </div>

            {error ? <div className="notice">{error}</div> : null}

            <footer className="photo-sheet__foot">
              <span className="row__hint">
                {estimate ? `Ungefär ${formatBytes(Math.round(estimate))}` : ""}
              </span>
              <button className="btn" onClick={onCancel}>Avbryt</button>
              <button className="btn btn--primary" onClick={send} disabled={working}>
                <SendIcon size={15} />
                {working ? "Behandlar…" : "Skicka"}
              </button>
            </footer>
          </>
        )}
      </div>
    </div>
  );
}
