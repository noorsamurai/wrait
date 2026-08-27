import type { Settings } from "../lib/settings";

interface SettingsSheetProps {
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
  onSignOut: () => void;
  onClose: () => void;
  serverUrl: string;
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

export function SettingsSheet({ settings, onChange, onSignOut, onClose, serverUrl }: SettingsSheetProps) {
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

        <p className="row__hint" style={{ margin: "16px 0 0" }}>Ansluten till {serverUrl}</p>

        <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
          <button className="btn" style={{ flex: 1 }} onClick={onSignOut}>Logga ut</button>
          <button className="btn btn--primary" style={{ flex: 1 }} onClick={onClose}>Klar</button>
        </div>
      </div>
    </div>
  );
}
