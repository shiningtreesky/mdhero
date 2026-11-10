/**
 * Keyboard shortcuts are stored as `KeyboardEvent.code` values (physical keys),
 * so a binding survives a layout change. Everything here is pure, which keeps
 * matching, labelling and persistence parsing testable without a DOM.
 */

/** The `~` / `` ` `` key below Esc — the backquote key with no modifier. */
export const DEFAULT_PLAY_PAUSE_SHORTCUT = "Backquote";

export interface ShortcutSettings {
  /** `KeyboardEvent.code` of the play/pause reading shortcut. */
  playPause: string;
}

export const DEFAULT_SHORTCUT_SETTINGS: ShortcutSettings = {
  playPause: DEFAULT_PLAY_PAUSE_SHORTCUT,
};

/** Only the fields matching needs — tests pass plain objects, the app passes
 *  real `KeyboardEvent`s. */
export interface ShortcutEventLike {
  code: string;
  ctrlKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  repeat?: boolean;
}

const MODIFIER_CODES = new Set([
  "ShiftLeft",
  "ShiftRight",
  "ControlLeft",
  "ControlRight",
  "AltLeft",
  "AltRight",
  "MetaLeft",
  "MetaRight",
]);

const CODE_LABELS: Record<string, string> = {
  Backquote: "~",
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Space: "Space",
  Enter: "Enter",
  Escape: "Esc",
  Tab: "Tab",
  Backspace: "Backspace",
  Delete: "Delete",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  PageUp: "PageUp",
  PageDown: "PageDown",
  Home: "Home",
  End: "End",
  Insert: "Insert",
};

/** The three mutually exclusive reading modes, plus 词's IPA view. */
export type ReadingModeTarget = "paras" | "sentence" | "gloss" | "phonetic";

/**
 * Main-row `1`/`2`/`3`/`4` select 段/句/词/音. Matching on the physical `code`
 * keeps the binding on the same keys under non-QWERTY layouts; numpad digits
 * and every other key return null.
 */
export function readingModeForCode(code: string): ReadingModeTarget | null {
  switch (code) {
    case "Digit1":
      return "paras";
    case "Digit2":
      return "sentence";
    case "Digit3":
      return "gloss";
    case "Digit4":
      return "phonetic";
    default:
      return null;
  }
}

/** Human-readable label for a stored key code: `Backquote` → `~`. */
export function shortcutLabel(code: string): string {
  if (CODE_LABELS[code]) return CODE_LABELS[code];
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  return code;
}

/**
 * The key a recording should store, or null when the press must be ignored:
 * key repeat, modifier combinations (Ctrl/Alt/Meta/Shift + key), and the
 * modifier keys themselves. Without this a shortcut would steal Ctrl+W or
 * block typing a real character.
 */
export function codeFromEvent(event: ShortcutEventLike): string | null {
  if (event.repeat) return null;
  if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return null;
  const code = event.code;
  if (!code || MODIFIER_CODES.has(code)) return null;
  return code;
}

/** True when this keydown is the bound shortcut and nothing else. */
export function matchesShortcut(event: ShortcutEventLike, code: string): boolean {
  return !!code && codeFromEvent(event) === code;
}

/**
 * Reads the persisted settings. Anything unreadable falls back to the default,
 * so a broken localStorage entry can never leave the app without a shortcut.
 */
export function parseShortcutSettings(raw: string | null): ShortcutSettings {
  if (!raw) return { ...DEFAULT_SHORTCUT_SETTINGS };
  try {
    const parsed = JSON.parse(raw) as Partial<ShortcutSettings> | null;
    if (!parsed || typeof parsed !== "object") return { ...DEFAULT_SHORTCUT_SETTINGS };
    return {
      playPause:
        typeof parsed.playPause === "string" && parsed.playPause
          ? parsed.playPause
          : DEFAULT_SHORTCUT_SETTINGS.playPause,
    };
  } catch {
    return { ...DEFAULT_SHORTCUT_SETTINGS };
  }
}
