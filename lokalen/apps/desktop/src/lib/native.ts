/**
 * Bridge to the native shell.
 *
 * Every call degrades gracefully: the same bundle runs inside Tauri on
 * Windows, macOS and iOS, and in a plain browser during development, so
 * nothing here may assume the native side exists.
 */

function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** Dynamic imports keep the Tauri plugins out of a browser-only bundle path. */
async function notificationPlugin() {
  if (!inTauri()) return null;
  try {
    return await import("@tauri-apps/plugin-notification");
  } catch {
    return null;
  }
}

export async function requestNotificationAccess(): Promise<boolean> {
  const plugin = await notificationPlugin();
  if (plugin) {
    return (await plugin.isPermissionGranted()) || (await plugin.requestPermission()) === "granted";
  }
  if (typeof Notification === "undefined") return false;
  if (Notification.permission === "granted") return true;
  if (Notification.permission === "denied") return false;
  return (await Notification.requestPermission()) === "granted";
}

/**
 * Raises an OS notification, so a message lands even when the window is
 * behind a spreadsheet - which is the entire point of the app.
 */
export async function notify(title: string, body: string) {
  const plugin = await notificationPlugin();
  if (plugin) {
    if (await plugin.isPermissionGranted()) plugin.sendNotification({ title, body });
    return;
  }
  if (typeof Notification !== "undefined" && Notification.permission === "granted") {
    new Notification(title, { body });
  }
}

/**
 * Saves a downloaded attachment.
 *
 * Native builds open a real save dialog and stream to disk; in the browser we
 * fall back to an anchor download.
 */
export async function saveAttachment(url: string, suggestedName: string): Promise<"saved" | "cancelled" | "browser"> {
  if (!inTauri()) {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = suggestedName;
    anchor.rel = "noopener";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    return "browser";
  }

  const { save } = await import("@tauri-apps/plugin-dialog");

  // A real save dialog: anywhere the person can write, not a fixed folder.
  const target = await save({ defaultPath: suggestedName });
  if (!target) return "cancelled";

  // The shell streams it to disk. Reading the whole file into the webview
  // first would put a 2 GB transfer in memory on a machine that may not have
  // 2 GB to spare.
  await command<number>("save_attachment", { url, path: target });
  return "saved";
}

/**
 * Asks the shell to bounce the dock icon (macOS) or flash the taskbar button
 * (Windows). Complements the tone: the sound catches someone at their desk,
 * this catches them when the window is buried behind other work.
 */
export async function requestAttention() {
  if (!inTauri()) return;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("alert_window");
  } catch {
    /* The shell may be older than this command; the tone still played. */
  }
}

/** Brings the window forward, e.g. after the user acts on a notification. */
export async function focusWindow() {
  if (!inTauri()) return;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("focus_window");
  } catch {
    /* ignore */
  }
}

export interface RelayInfo {
  port: number;
  /** Addresses other machines on the LAN can reach. */
  addresses: string[];
}

async function command<T>(name: string, args?: Record<string, unknown>): Promise<T | null> {
  if (!inTauri()) return null;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return (await invoke(name, args)) as T;
  } catch (err) {
    throw new Error(err instanceof Error ? err.message : String(err));
  }
}

/**
 * Starts hosting an office on this computer.
 *
 * The relay is compiled into the app, so this needs nothing installed - it is
 * what lets one portable exe be both the client and the server.
 */
export function startRelay(port?: number) {
  return command<RelayInfo>("start_relay", { port });
}

export function stopRelay() {
  return command<null>("stop_relay");
}

/** The relay this machine is already hosting, or null. */
export function relayStatus() {
  return command<RelayInfo | null>("relay_status").catch(() => null);
}

/** This machine's part in the office, and where the office currently is. */
export interface ClusterStatus {
  /** "idle" | "host" | "standby" | "seeking" */
  role: string;
  /** Where the office is being served right now. */
  host: string;
  /** True when that is this very machine. */
  hosting: boolean;
  office: string;
  term: number;
  /** How much of the office's history this machine holds. */
  watermark: number;
}

/**
 * Tells the shell to keep a copy of the office this machine just joined.
 *
 * Without it a computer is only a client, and switching off whichever machine
 * happens to be hosting takes the whole office down with it. With it, every
 * machine follows along and one of them can take over.
 */
export function joinOffice(url: string, token: string) {
  return command<ClusterStatus>("join_office", { url, token }).catch(() => null);
}

/** Where the office is being served, or null outside the native shell. */
export function clusterStatus() {
  return command<ClusterStatus | null>("cluster_status").catch(() => null);
}

/**
 * Calls back whenever the office moves to another computer.
 *
 * Resolves to an unsubscribe function, or to a no-op in the browser, where
 * there is no shell to move anything.
 */
export async function onOfficeMoved(handler: (status: ClusterStatus) => void): Promise<() => void> {
  if (!inTauri()) return () => {};
  try {
    const { listen } = await import("@tauri-apps/api/event");
    return await listen<ClusterStatus>("office-moved", (event) => handler(event.payload));
  } catch {
    return () => {};
  }
}

export interface DiscoveredOffice {
  id: string;
  /** The hosting computer's name. */
  name: string;
  /** Ready to use as a server address. */
  url: string;
}

/**
 * Looks for offices being hosted on this network, so nobody has to read an IP
 * address out loud. Returns an empty list in the browser, where there is no
 * way to send a UDP probe.
 */
export function discoverOffices(timeoutMs?: number) {
  return command<DiscoveredOffice[]>("discover_offices", { timeoutMs })
    .then((found) => found ?? [])
    .catch(() => []);
}

/* ------------------------------------------------------------------ */
/* Living in the tray, and keeping a copy                              */
/* ------------------------------------------------------------------ */

/**
 * Puts the unread count on the tray icon.
 *
 * The window spends most of its life behind a journal system, so the tray is
 * where anyone actually looks to see whether something is waiting.
 */
export function setBadge(unread: number) {
  return command<null>("set_badge", { unread }).catch(() => null);
}

/** Whether the app opens itself when this computer starts. */
export function autostartEnabled() {
  return command<boolean>("autostart_enabled").catch(() => false);
}

export function setAutostart(enabled: boolean) {
  return command<boolean>("set_autostart", { enabled });
}

/** What a backup turned out to contain. */
export interface BackupSummary {
  messages: number;
  files: number;
  bytes: number;
  path: string;
}

/**
 * Writes the whole office to one file the person picks.
 *
 * Returns null if they cancelled the dialog, which is not an error.
 */
export async function exportOffice(): Promise<BackupSummary | null> {
  if (!inTauri()) return null;
  const { save } = await import("@tauri-apps/plugin-dialog");
  const stamp = new Date().toISOString().slice(0, 10);
  const target = await save({
    defaultPath: `lokalen-${stamp}.lokalen`,
    filters: [{ name: "Lokalen-säkerhetskopia", extensions: ["lokalen"] }],
  });
  if (!target) return null;
  return command<BackupSummary>("export_office", { path: target });
}

/** Replaces this office with one from a backup file. */
export async function importOffice(): Promise<BackupSummary | null> {
  if (!inTauri()) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const chosen = await open({
    multiple: false,
    filters: [{ name: "Lokalen-säkerhetskopia", extensions: ["lokalen"] }],
  });
  if (typeof chosen !== "string") return null;
  return command<BackupSummary>("import_office", { path: chosen });
}

/** Where the app keeps its data, and whether that is beside the exe. */
export function storageLocation() {
  return command<{ path: string; portable: boolean }>("storage_location").catch(() => null);
}

/** Coarse platform hint, used only to adapt the layout. */
export async function platformName(): Promise<string> {
  if (!inTauri()) return "web";
  try {
    const { platform } = await import("@tauri-apps/plugin-os");
    return platform();
  } catch {
    return "unknown";
  }
}

export const isNative = inTauri;
