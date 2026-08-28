import { useCallback, useEffect, useMemo, useState } from "react";
import type { Message } from "@lokalen/protocol";
import { htmlToPlain } from "./lib/richtext";
import { logout, type Session } from "./lib/client";
import { loadSession, rememberedOperator, storeSession, useSettings } from "./lib/settings";
import { unlockAudio } from "./lib/sound";
import { useComms } from "./lib/useComms";
import { Ambient } from "./components/Ambient";
import { Conversation } from "./components/Conversation";
import { Roster } from "./components/Roster";
import { TaskPanel } from "./components/TaskPanel";
import { SettingsSheet } from "./components/SettingsSheet";
import { SignIn } from "./components/SignIn";

export function App() {
  const [session, setSession] = useState<Session | null>(loadSession);
  const [settings, updateSettings] = useSettings();
  const [showSettings, setShowSettings] = useState(false);
  const [showTasks, setShowTasks] = useState(false);

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

  // Tell the office who is at this room, if the person said on sign-in.
  useEffect(() => {
    if (!comms.ready) return;
    const remembered = rememberedOperator().trim();
    if (remembered) comms.setOperator(remembered);
    // Only on becoming ready: re-sending on every render would be chatter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [comms.ready]);

  // Reflect unread count in the window title, so a background window still
  // says something useful in the taskbar or dock.
  useEffect(() => {
    document.title = comms.totalUnread > 0 ? `(${comms.totalUnread}) Lokalen` : "Lokalen";
  }, [comms.totalUnread]);

  const signIn = useCallback((next: Session) => {
    storeSession(next);
    setSession(next);
  }, []);

  /**
   * Saves a chat message into your own list.
   *
   * The title is the message text, or the file name when there is no text, so
   * a saved attachment still reads as something actionable.
   */
  const saveMessage = useCallback(
    (message: Message) => {
      const title = htmlToPlain(message.body) || message.attachment?.name || "Sparat meddelande";
      comms.addTask({ title: title.slice(0, 300), sourceMessageId: message.id });
      setShowTasks(true);
    },
    [comms],
  );

  const savedMessageIds = useMemo(
    () => new Set(comms.tasks.map((t) => t.sourceMessageId).filter((id): id is string => Boolean(id))),
    [comms.tasks],
  );

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

      <div className="app" data-tasks={showTasks ? "open" : "closed"}>
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
          onOpenTasks={() => setShowTasks((v) => !v)}
          openTaskCount={comms.openTaskCount}
          availability={self.availability ?? "available"}
          onAvailability={comms.setAvailability}
          muted={settings.muted}
          onToggleMute={() => updateSettings({ muted: !settings.muted })}
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
            onSaveMessage={saveMessage}
            savedMessageIds={savedMessageIds}
            onEditMessage={comms.editMessage}
            onDeleteMessage={comms.deleteMessage}
            onLoadOlder={() => comms.loadOlder(comms.active!.id)}
            exhausted={Boolean(comms.exhausted[comms.active!.id])}
          />
        ) : (
          <section className="surface chat chat--placeholder">
            <p className="chat__empty">
              {comms.connected
                ? "Välj någon till vänster för att börja prata."
                : "Ansluter till kontorets server…"}
            </p>
          </section>
        )}

        {showTasks ? (
          <TaskPanel
            self={self}
            users={comms.users}
            tasks={comms.tasks}
            onAdd={comms.addTask}
            onClear={comms.clearTask}
            onDelete={comms.deleteTask}
            onClose={() => setShowTasks(false)}
          />
        ) : null}
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
