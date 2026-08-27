import { useEffect, useState } from "react";
import type { OfficeInfo } from "@lokalen/protocol";
import {
  ApiError, fetchOffice, joinByName, login, normaliseServerUrl, register, type Session,
} from "../lib/client";
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
  const [name, setName] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [office, setOffice] = useState<OfficeInfo | null>(null);
  const [probing, setProbing] = useState(false);

  const [hosting, setHosting] = useState<RelayInfo | null>(null);
  const [hostBusy, setHostBusy] = useState(false);
  const [nearby, setNearby] = useState<DiscoveredOffice[]>([]);
  const [scanning, setScanning] = useState(isNative());

  async function scan() {
    setScanning(true);
    try {
      setNearby(await discoverOffices());
    } finally {
      setScanning(false);
    }
  }

  useEffect(() => {
    if (isNative()) void scan();
    void relayStatus().then((info) => {
      if (!info) return;
      setHosting(info);
      setServer(info.addresses[0] ?? `http://localhost:${info.port}`);
    });
  }, []);

  /**
   * Ask the server what kind of office it is, so the form can show a name
   * field or an account form rather than making people guess.
   *
   * Debounced because this runs while the address is still being typed.
   */
  useEffect(() => {
    let cancelled = false;
    setOffice(null);
    const timer = setTimeout(async () => {
      let url: string;
      try {
        url = normaliseServerUrl(server);
      } catch {
        return;
      }
      setProbing(true);
      try {
        const info = await fetchOffice(url);
        if (!cancelled) setOffice(info);
      } catch {
        // Unreachable or not a Lokalen server: leave the form as it was and
        // let the actual sign-in attempt produce the error message.
      } finally {
        if (!cancelled) setProbing(false);
      }
    }, 400);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [server]);

  async function host() {
    setHostBusy(true);
    setError(null);
    try {
      const info = await startRelay();
      if (!info) return;
      setHosting(info);
      setServer(info.addresses[0] ?? `http://localhost:${info.port}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kunde inte starta kontoret här.");
    } finally {
      setHostBusy(false);
    }
  }

  /**
   * Assume an open office until the server says otherwise.
   *
   * Open is the default mode, and the probe is asynchronous: defaulting the
   * other way flashes a username and password field at everyone for a moment,
   * and leaves the wrong form on screen entirely if the probe never answers.
   */
  const open = office?.mode !== "password";

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const serverUrl = normaliseServerUrl(server);
      const result = open
          ? await joinByName(serverUrl, name)
          : mode === "register"
            ? await register(serverUrl, { username, displayName: name || username, password })
            : await login(serverUrl, { username, password });

      rememberServerUrl(serverUrl);
      onSignedIn({ serverUrl, token: result.token, user: result.user });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Något gick fel. Försök igen.");
    } finally {
      setBusy(false);
    }
  }

  const canSubmit = open ? name.trim().length > 0 : username.trim().length > 0 && password.length > 0;

  return (
    <div className="signin">
      <form className="surface surface--raised signin__card" onSubmit={submit}>
        <div className="signin__brand">
          <LogoMark />
          <div>
            <h1 className="signin__title">{office?.name ?? "Lokalen"}</h1>
            <p className="signin__sub">Meddelanden för rummet du arbetar i</p>
          </div>
        </div>

        {/* An open office has nothing to choose between. */}
        {!open ? (
          <div className="segmented" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={mode === "signin"}
              onClick={() => { setMode("signin"); setError(null); }}
            >
              Logga in
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === "register"}
              onClick={() => { setMode("register"); setError(null); }}
            >
              Skapa konto
            </button>
          </div>
        ) : null}

        <div className="stack">
          <div>
            <label className="label" htmlFor="server">Kontorets server</label>
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
                  <span className="nearby__status">Söker efter kontor i nätverket…</span>
                ) : nearby.length > 0 ? (
                  <>
                    <span className="nearby__status">I nätverket:</span>
                    {nearby.map((found) => (
                      <button
                        key={found.id || found.url}
                        type="button"
                        className="chip"
                        aria-pressed={server === found.url}
                        onClick={() => setServer(found.url)}
                        title={found.url}
                      >
                        {found.name}
                      </button>
                    ))}
                  </>
                ) : (
                  <span className="nearby__status">Inga kontor hittades i nätverket.</span>
                )}
                {scanning ? null : (
                  <button type="button" className="nearby__again" onClick={scan}>
                    Sök igen
                  </button>
                )}
              </div>
            ) : null}
          </div>

          {open ? (
            <div>
              <label className="label" htmlFor="name">Ditt namn</label>
              <input
                id="name"
                className="field"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Anna Lindqvist"
                autoComplete="name"
                required
              />
              <p className="row__hint" style={{ marginTop: 6 }}>
                {probing ? "Kontrollerar kontoret…" : "Inget lösenord behövs på det här kontoret."}
              </p>
            </div>
          ) : (
            <>
              <div>
                <label className="label" htmlFor="username">Användarnamn</label>
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
                  <label className="label" htmlFor="displayName">Visningsnamn</label>
                  <input
                    id="displayName"
                    className="field"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Så här ser kollegorna dig"
                    autoComplete="name"
                  />
                </div>
              ) : null}

              <div>
                <label className="label" htmlFor="password">Lösenord</label>
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
                  <p className="row__hint" style={{ marginTop: 6 }}>Minst 8 tecken.</p>
                ) : null}
              </div>
            </>
          )}

          {error ? <div className="notice">{error}</div> : null}

          <button
            className="btn btn--primary"
            type="submit"
            disabled={busy || probing || !canSubmit}
            style={{ marginTop: 4 }}
          >
            {busy ? "Arbetar…" : open ? "Gå med" : mode === "register" ? "Skapa konto" : "Logga in"}
          </button>

          {isNative() ? (
            hosting ? (
              <p className="row__hint" style={{ margin: 0 }}>
                Kontoret körs här på port {hosting.port}. Andra anger{" "}
                <strong>{hosting.addresses[0]}</strong>
              </p>
            ) : (
              <>
                <div className="signin__divider">
                  <span>eller</span>
                </div>
                <button className="btn" type="button" onClick={host} disabled={hostBusy}>
                  {hostBusy ? "Startar…" : "Starta ett kontor på den här datorn"}
                </button>
                <p className="row__hint" style={{ margin: 0 }}>
                  Servern körs inne i appen, så ingen behöver installera något.
                </p>
              </>
            )
          ) : null}
        </div>
      </form>
    </div>
  );
}
