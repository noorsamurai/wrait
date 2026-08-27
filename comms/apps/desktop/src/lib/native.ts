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

  const [{ save }, { writeFile }] = await Promise.all([
    import("@tauri-apps/plugin-dialog"),
    import("@tauri-apps/plugin-fs"),
  ]);

  const target = await save({ defaultPath: suggestedName });
  if (!target) return "cancelled";

  const response = await fetch(url);
  if (!response.ok) throw new Error("The file could not be downloaded.");
  await writeFile(target, new Uint8Array(await response.arrayBuffer()));
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
