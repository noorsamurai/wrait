import { useEffect, useState } from "react";
import type { Settings } from "../lib/settings";
import { formatBytes } from "@lokalen/protocol";
import {
  autostartEnabled, exportOffice, importOffice, isNative, setAutostart,
  type ClusterStatus,
} from "../lib/native";

interface SettingsSheetProps {
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
  onSignOut: () => void;
  onClose: () => void;
  serverUrl: string;
  /** This machine's part in the office, or null in a browser. */
  cluster: ClusterStatus | null;
}

/** What this computer is doing about the office, in a sentence. */
function roleOf(cluster: ClusterStatus | null): string | null {
  if (!cluster) return null;
  switch (cluster.role) {
    case "host":
      return "Den här datorn är värd för kontoret just nu.";
    case "standby":
      return "Den här datorn håller en kopia och kan ta över om värden stängs av.";
    case "seeking":
      return "Söker efter kontoret …";
    default:
      return null;
  }
}

function Switch({ on, onToggle, label }: { on: boolean; onToggle: () => void; label: string }) {
  return (
    <button
      type="button"
      className="switch"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={onToggle}
    />
  );
}

export function SettingsSheet({
  settings, onChange, onSignOut, onClose, serverUrl, cluster,
}: SettingsSheetProps) {
  const [autostart, setAutostartState] = useState(false);
  const [busy, setBusy] = useState<"export" | "import" | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    void autostartEnabled().then((on) => setAutostartState(on ?? false));
  }, []);

  async function toggleAutostart() {
    const wanted = !autostart;
    try {
      setAutostartState((await setAutostart(wanted)) ?? wanted);
    } catch (err) {
      setNote(err instanceof Error ? err.message : "Kunde inte ändra det.");
    }
  }

  /** Backup and restore share their reporting, since both end in a count. */
  async function run(kind: "export" | "import") {
    setBusy(kind);
    setNote(null);
    try {
      const summary = kind === "export" ? await exportOffice() : await importOffice();
      if (summary) {
        const verb = kind === "export" ? "Sparade" : "Återställde";
        setNote(
          `${verb} ${summary.messages} meddelanden och ${summary.files} bilagor` +
            (summary.bytes ? ` (${formatBytes(summary.bytes)}).` : "."),
        );
      }
    } catch (err) {
      setNote(err instanceof Error ? err.message : "Det gick inte.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div
      className="sheet-scrim"
      role="dialog"
      aria-modal="true"
      aria-label="Inställningar"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="surface surface--raised sheet">
        <h2 style={{ margin: "0 0 14px", fontSize: 18, fontWeight: 640 }}>Inställningar</h2>

        <div className="row">
          <span className="row__body">
            <span className="row__label">Ljudsignaler</span>
            <span className="row__hint">Pip när ett meddelande kommer</span>
          </span>
          <Switch on={settings.sound} label="Ljudsignaler" onToggle={() => onChange({ sound: !settings.sound })} />
        </div>

        {settings.sound ? (
          <div className="row">
            <span className="row__body">
              <span className="row__label">Volym</span>
            </span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={settings.volume}
              onChange={(e) => onChange({ volume: Number(e.target.value) })}
              aria-label="Signalvolym"
              style={{ width: 130 }}
            />
          </div>
        ) : null}

        <div className="row">
          <span className="row__body">
            <span className="row__label">Skrivbordsaviseringar</span>
            <span className="row__hint">Visa en avisering när fönstret ligger bakom något</span>
          </span>
          <Switch
            on={settings.notifications}
            label="Skrivbordsaviseringar"
            onToggle={() => onChange({ notifications: !settings.notifications })}
          />
        </div>

        <div className="row">
          <span className="row__body">
            <span className="row__label">Glasutseende</span>
            <span className="row__hint">
              Lägger till en genomskinlig oskärpa bakom varje panel. Snyggare, men märkbart
              tyngre att rita - lämna av på äldre datorer med lite minne.
            </span>
          </span>
          <Switch
            on={settings.appearance === "glass"}
            label="Glasutseende"
            onToggle={() => onChange({ appearance: settings.appearance === "glass" ? "flat" : "glass" })}
          />
        </div>

        {isNative() ? (
          <>
            <h3 style={{ margin: "22px 0 2px", fontSize: 13, fontWeight: 640, opacity: 0.75 }}>
              Den här datorn
            </h3>

            <div className="row">
              <span className="row__body">
                <span className="row__label">Starta med datorn</span>
                <span className="row__hint">
                  Öppnas i aktivitetsfältet när du loggar in, så ingen behöver komma ihåg det
                </span>
              </span>
              <Switch on={autostart} label="Starta med datorn" onToggle={() => void toggleAutostart()} />
            </div>

            <div className="row">
              <span className="row__body">
                <span className="row__label">Säkerhetskopia</span>
                <span className="row__hint">
                  Hela kontoret - konton, meddelanden och bilagor - i en enda fil
                </span>
              </span>
              <span style={{ display: "flex", gap: 8 }}>
                <button className="btn" disabled={busy !== null} onClick={() => void run("export")}>
                  {busy === "export" ? "Sparar …" : "Spara"}
                </button>
                <button className="btn" disabled={busy !== null} onClick={() => void run("import")}>
                  {busy === "import" ? "Läser …" : "Återställ"}
                </button>
              </span>
            </div>

            {note ? <p className="row__hint" style={{ margin: "4px 0 0" }}>{note}</p> : null}
          </>
        ) : null}

        <p className="row__hint" style={{ margin: "16px 0 0" }}>
          Ansluten till {serverUrl}
          {roleOf(cluster) ? <><br />{roleOf(cluster)}</> : null}
        </p>

        <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
          <button className="btn" style={{ flex: 1 }} onClick={onSignOut}>Logga ut</button>
          <button className="btn btn--primary" style={{ flex: 1 }} onClick={onClose}>Klar</button>
        </div>
      </div>
    </div>
  );
}
