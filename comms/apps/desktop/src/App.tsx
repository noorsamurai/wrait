import { useCallback, useEffect, useState } from "react";
import { logout, type Session } from "./lib/client";
import { loadSession, storeSession, useSettings } from "./lib/settings";
import { unlockAudio } from "./lib/sound";
import { useComms } from "./lib/useComms";
import { Ambient } from "./components/Ambient";
import { Conversation } from "./components/Conversation";
import { Roster } from "./components/Roster";
import { SettingsSheet } from "./components/SettingsSheet";
import { SignIn } from "./components/SignIn";

export function App() {
  const [session, setSession] = useState<Session | null>(loadSession);
  const [settings, updateSettings] = useSettings();
  const [showSettings, setShowSettings] = useState(false);

  const comms = useComms(session, settings);

  // Audio cannot start until the user has interacted, so arm it on the first
  // gesture anywhere in the window.
  useEffect(() => {
    const arm = () => unlockAudio();
    window.addEventListener("pointerdown", arm, { once: true });
    window.addEventListener("keydown", arm, { once: true });
    return () => {
      window.removeEventListener("pointerdown", arm);
      window.removeEventListener("keydown", arm);
    };
  }, []);

  // Reflect unread count in the window title, so a background window still
  // says something useful in the taskbar or dock.
  useEffect(() => {
    document.title = comms.totalUnread > 0 ? `(${comms.totalUnread}) Wrait Comms` : "Wrait Comms";
  }, [comms.totalUnread]);

  const signIn = useCallback((next: Session) => {
    storeSession(next);
    setSession(next);
  }, []);

  const signOut = useCallback(async () => {
    setShowSettings(false);
    if (session) await logout(session);
    storeSession(null);
    setSession(null);
  }, [session]);

  // A token can be revoked or expire while the app is closed; the socket then
  // refuses to open. Rather than loop forever, drop back to sign-in.
  useEffect(() => {
    if (!session || comms.ready) return;
    const timer = setTimeout(() => {
      if (!comms.ready) setShowSettings(false);
    }, 10_000);
    return () => clearTimeout(timer);
  }, [session, comms.ready]);

  if (!session) return (<><Ambient /><SignIn onSignedIn={signIn} /></>);

  const self = comms.self ?? session.user;
  const onPhoneWithChatOpen = comms.activePeer !== null;

  return (
    <>
      <Ambient />
      {comms.nudgedBy ? <div className="nudge-flash" /> : null}

      <div className="app">
        <Roster
          self={self}
          users={comms.users}
          threads={comms.threads}
          unread={comms.unread}
          typing={comms.typing}
          activePeer={comms.activePeer}
          connected={comms.connected}
          hidden={onPhoneWithChatOpen}
          onSelect={comms.openConversation}
          onOpenSettings={() => setShowSettings(true)}
        />

        {comms.active ? (
          <Conversation
            session={session}
            self={self}
            peer={comms.active}
            messages={comms.messages}
            typing={(comms.typing[comms.active.id] ?? 0) > Date.now()}
            onSend={(body, options) => comms.send(comms.active!.id, body, options)}
            onTyping={() => comms.setTyping(comms.active!.id)}
            onNudge={() => comms.nudge(comms.active!.id)}
            onBack={() => comms.openConversation(null)}
          />
        ) : (
          <section className="glass chat chat--placeholder">
            <p className="chat__empty">
              {comms.connected
                ? "Pick someone on the left to start a conversation."
                : "Connecting to the office server…"}
            </p>
          </section>
        )}
      </div>

      {showSettings ? (
        <SettingsSheet
          settings={settings}
          onChange={updateSettings}
          onSignOut={signOut}
          onClose={() => setShowSettings(false)}
          serverUrl={session.serverUrl}
        />
      ) : null}
    </>
  );
}
