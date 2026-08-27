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
      aria-label="Settings"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="glass glass--raised sheet">
        <h2 style={{ margin: "0 0 14px", fontSize: 18, fontWeight: 640 }}>Settings</h2>

        <div className="row">
          <span className="row__body">
            <span className="row__label">Sound alerts</span>
            <span className="row__hint">Chime when a message arrives</span>
          </span>
          <Switch on={settings.sound} label="Sound alerts" onToggle={() => onChange({ sound: !settings.sound })} />
        </div>

        {settings.sound ? (
          <div className="row">
            <span className="row__body">
              <span className="row__label">Volume</span>
            </span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={settings.volume}
              onChange={(e) => onChange({ volume: Number(e.target.value) })}
              aria-label="Alert volume"
              style={{ width: 130 }}
            />
          </div>
        ) : null}

        <div className="row">
          <span className="row__body">
            <span className="row__label">Desktop notifications</span>
            <span className="row__hint">Show a banner when the window is behind something</span>
          </span>
          <Switch
            on={settings.notifications}
            label="Desktop notifications"
            onToggle={() => onChange({ notifications: !settings.notifications })}
          />
        </div>

        <div className="row">
          <span className="row__body">
            <span className="row__label">Reduce visual effects</span>
            <span className="row__hint">
              Turns off the blur and the moving backdrop. Use this on older or low-memory computers.
            </span>
          </span>
          <Switch
            on={settings.effects === "reduced"}
            label="Reduce visual effects"
            onToggle={() => onChange({ effects: settings.effects === "reduced" ? "full" : "reduced" })}
          />
        </div>

        <p className="row__hint" style={{ margin: "16px 0 0" }}>Connected to {serverUrl}</p>

        <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
          <button className="btn" style={{ flex: 1 }} onClick={onSignOut}>Sign out</button>
          <button className="btn btn--primary" style={{ flex: 1 }} onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}
