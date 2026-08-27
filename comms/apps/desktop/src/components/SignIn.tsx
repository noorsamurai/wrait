import { useState } from "react";
import { ApiError, login, normaliseServerUrl, register, type Session } from "../lib/client";
import { lastServerUrl, rememberServerUrl } from "../lib/settings";
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
        </div>
      </form>
    </div>
  );
}
