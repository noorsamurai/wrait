import { useCallback, useEffect, useState } from "react";

export interface Settings {
  /** Play a tone when a message arrives. */
  sound: boolean;
  /** The quick mute, reachable from every screen. Separate from `sound` so
   *  silencing the app for ten minutes does not lose your real preference. */
  muted: boolean;
  volume: number;
  /** Raise an OS notification when the window is not focused. */
  notifications: boolean;
  /**
   * "flat" is the default and costs nothing to render. "glass" turns on the
   * backdrop blur and the coloured backdrop, for machines that can spare it.
   */
  appearance: "flat" | "glass";
}

const DEFAULTS: Settings = { sound: true, muted: false, volume: 0.7, notifications: true, appearance: "flat" };
const KEY = "lokalen.settings";

function load(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Settings>) } : DEFAULTS;
  } catch {
    // A private window or wiped site data must not stop the app booting.
    return DEFAULTS;
  }
}

export function useSettings() {
  const [settings, setSettings] = useState<Settings>(load);

  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(settings));
    } catch {
      /* Settings are a convenience; failing to persist them is not fatal. */
    }
    document.documentElement.dataset.appearance = settings.appearance;
  }, [settings]);

  const update = useCallback((patch: Partial<Settings>) => {
    setSettings((current) => ({ ...current, ...patch }));
  }, []);

  return [settings, update] as const;
}

/* ------------------------------------------------------------------ */
/* Saved session                                                       */
/* ------------------------------------------------------------------ */

import type { Session } from "./client";

const SESSION_KEY = "lokalen.session";

export function loadSession(): Session | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Session;
    return parsed?.token && parsed?.serverUrl && parsed?.user ? parsed : null;
  } catch {
    return null;
  }
}

export function storeSession(session: Session | null) {
  try {
    if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    else localStorage.removeItem(SESSION_KEY);
  } catch {
    /* Staying signed in across restarts is a convenience, not a requirement. */
  }
}

/** Remembers the last server typed, so the sign-in form is pre-filled. */
export function lastServerUrl(): string {
  try {
    return localStorage.getItem("lokalen.server") ?? "";
  } catch {
    return "";
  }
}

export function rememberServerUrl(url: string) {
  try {
    localStorage.setItem("lokalen.server", url);
  } catch {
    /* ignore */
  }
}

/** The room this machine was last signed in as, and who was at it. */
export function rememberedRoom(): string {
  try {
    return localStorage.getItem("lokalen.room") ?? "";
  } catch {
    return "";
  }
}

export function rememberRoom(room: string) {
  try {
    localStorage.setItem("lokalen.room", room);
  } catch {
    /* ignore */
  }
}

export function rememberedOperator(): string {
  try {
    return localStorage.getItem("lokalen.operator") ?? "";
  } catch {
    return "";
  }
}

export function rememberOperator(name: string) {
  try {
    localStorage.setItem("lokalen.operator", name);
  } catch {
    /* ignore */
  }
}
