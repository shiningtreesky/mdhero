import { writable } from "svelte/store";
import {
  DEFAULT_SHORTCUT_SETTINGS,
  parseShortcutSettings,
  type ShortcutSettings,
} from "../utils/shortcut";

export const SHORTCUTS_STORAGE_KEY = "mdhero:shortcuts";

export { DEFAULT_SHORTCUT_SETTINGS };

function load(): ShortcutSettings {
  if (typeof localStorage === "undefined") return { ...DEFAULT_SHORTCUT_SETTINGS };
  try {
    return parseShortcutSettings(localStorage.getItem(SHORTCUTS_STORAGE_KEY));
  } catch {
    return { ...DEFAULT_SHORTCUT_SETTINGS };
  }
}

const store = writable<ShortcutSettings>(load());

store.subscribe((value) => {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(SHORTCUTS_STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Restricted webview: the binding still applies for this session.
  }
});

export const shortcuts = {
  subscribe: store.subscribe,
  set: store.set,
  update: store.update,
};

/** Rebind the play/pause reading shortcut; takes effect on the next keypress. */
export function setPlayPauseShortcut(code: string): void {
  if (!code) return;
  store.update((value) => ({ ...value, playPause: code }));
}

export function restoreDefaultShortcuts(): void {
  store.set({ ...DEFAULT_SHORTCUT_SETTINGS });
}
