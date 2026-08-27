import { useEffect, useState } from "react";
import { ApiError, login, normaliseServerUrl, register, type Session } from "../lib/client";
import { lastServerUrl, rememberServerUrl } from "../lib/settings";
import {
  discoverOffices, isNative, relayStatus, startRelay,
  type DiscoveredOffice, type RelayInfo,
} from "../lib/native";
import { LogoMark } from "./icons";

type Mode = "signin" | "register";

export function SignIn({ onSignedIn }: { onSignedIn: (session: Session) => void }) {
  const [mode, setMode] = useState<Mode>("signin");
  const [server, setServer] = useState(lastServerUrl() || "http://localhost:8787");
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hosting, setHosting] = useState<RelayInfo | null>(null);
  const [hostBusy, setHostBusy] = useState(false);
  const [nearby, setNearby] = useState<DiscoveredOffice[]>([]);
  const [scanning, setScanning] = useState(isNative());

  /** Probes the network and offers whatever answers. */
  async function scan() {
    setScanning(true);
    try {
      setNearby(await discoverOffices());
    } finally {
      setScanning(false);
    }
  }

  // Look as soon as the window opens: by the time someone has read the form,
  // the office next to them is usually already listed.
  useEffect(() => {
    if (isNative()) void scan();
  }, []);

  // If this machine is already hosting - the app was reopened, say - adopt
  // that relay rather than offering to start a second one.
  useEffect(() => {
    void relayStatus().then((info) => {
      if (!info) return;
      setHosting(info);
      setServer(info.addresses[0] ?? `http://localhost:${info.port}`);
    });
  }, []);

  async function host() {
    setHostBusy(true);
    setError(null);
    try {
      const info = await startRelay();
      if (!info) return;
      setHosting(info);
      setServer(info.addresses[0] ?? `http://localhost:${info.port}`);
      setMode("register");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start hosting on this computer.");
    } finally {
      setHostBusy(false);
    }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const serverUrl = normaliseServerUrl(server);
      const result =
        mode === "register"
          ? await register(serverUrl, { username, displayName: displayName || username, password })
          : await login(serverUrl, { username, password });

      rememberServerUrl(serverUrl);
      onSignedIn({ serverUrl, token: result.token, user: result.user });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="signin">
      <form className="surface surface--raised signin__card" onSubmit={submit}>
        <div className="signin__brand">
          <LogoMark />
          <div>
            <h1 className="signin__title">Wrait Comms</h1>
            <p className="signin__sub">Messaging for the room you work in</p>
          </div>
        </div>

        <div className="segmented" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={mode === "signin"}
            onClick={() => { setMode("signin"); setError(null); }}
          >
            Sign in
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "register"}
            onClick={() => { setMode("register"); setError(null); }}
          >
            Create account
          </button>
        </div>

        <div className="stack">
          <div>
            <label className="label" htmlFor="server">Office server</label>
            <input
              id="server"
              className="field"
              value={server}
              onChange={(e) => setServer(e.target.value)}
              placeholder="192.168.1.20:8787"
              autoComplete="url"
              spellCheck={false}
              required
            />

            {isNative() && !hosting ? (
              <div className="nearby">
                {scanning ? (
                  <span className="nearby__status">Looking for offices on this network…</span>
                ) : nearby.length > 0 ? (
                  <>
                    <span className="nearby__status">On this network:</span>
                    {nearby.map((office) => (
                      <button
                        key={office.id || office.url}
                        type="button"
                        className="chip"
                        aria-pressed={server === office.url}
                        onClick={() => setServer(office.url)}
                        title={office.url}
                      >
                        {office.name}
                      </button>
                    ))}
                  </>
                ) : (
                  <span className="nearby__status">No offices found on this network.</span>
                )}
                {scanning ? null : (
                  <button type="button" className="nearby__again" onClick={scan}>
                    Search again
                  </button>
                )}
              </div>
            ) : null}
          </div>

          <div>
            <label className="label" htmlFor="username">Username</label>
            <input
              id="username"
              className="field"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              required
            />
          </div>

          {mode === "register" ? (
            <div>
              <label className="label" htmlFor="displayName">Display name</label>
              <input
                id="displayName"
                className="field"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="How your name appears to colleagues"
                autoComplete="name"
              />
            </div>
          ) : null}

          <div>
            <label className="label" htmlFor="password">Password</label>
            <input
              id="password"
              className="field"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={mode === "register" ? "new-password" : "current-password"}
              required
            />
            {mode === "register" ? (
              <p className="row__hint" style={{ marginTop: 6 }}>At least 8 characters.</p>
            ) : null}
          </div>

          {error ? <div className="notice">{error}</div> : null}

          <button className="btn btn--primary" type="submit" disabled={busy} style={{ marginTop: 4 }}>
            {busy ? "Working…" : mode === "register" ? "Create account" : "Sign in"}
          </button>

          {/* Hosting only exists in the native app - a browser tab cannot
              listen on a port for the rest of the office. */}
          {isNative() ? (
            hosting ? (
              <p className="row__hint" style={{ margin: 0 }}>
                Hosting this office on port {hosting.port}. Others should enter{" "}
                <strong>{hosting.addresses[0]}</strong>
              </p>
            ) : (
              <>
                <div className="signin__divider">
                  <span>or</span>
                </div>
                <button className="btn" type="button" onClick={host} disabled={hostBusy}>
                  {hostBusy ? "Starting…" : "Host an office on this computer"}
                </button>
                <p className="row__hint" style={{ margin: 0 }}>
                  Runs the server inside this app, so nobody has to install anything.
                </p>
              </>
            )
          ) : null}
        </div>
      </form>
    </div>
  );
}
