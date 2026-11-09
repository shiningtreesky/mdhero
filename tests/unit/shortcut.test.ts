import { describe, expect, it } from "vitest";
import {
  DEFAULT_PLAY_PAUSE_SHORTCUT,
  DEFAULT_SHORTCUT_SETTINGS,
  codeFromEvent,
  matchesShortcut,
  parseShortcutSettings,
  readingModeForCode,
  shortcutLabel,
} from "../../src/lib/utils/shortcut";

describe("shortcut defaults", () => {
  it("binds play/pause to the backquote key and labels it ~", () => {
    expect(DEFAULT_PLAY_PAUSE_SHORTCUT).toBe("Backquote");
    expect(DEFAULT_SHORTCUT_SETTINGS.playPause).toBe("Backquote");
    expect(shortcutLabel("Backquote")).toBe("~");
  });
});

describe("shortcut matching", () => {
  it("matches the plain key press", () => {
    expect(matchesShortcut({ code: "Backquote" }, "Backquote")).toBe(true);
  });

  it("ignores modifier combinations", () => {
    for (const mod of ["ctrlKey", "altKey", "metaKey", "shiftKey"] as const) {
      expect(matchesShortcut({ code: "Backquote", [mod]: true }, "Backquote")).toBe(false);
    }
  });

  it("ignores key repeat", () => {
    expect(matchesShortcut({ code: "Backquote", repeat: true }, "Backquote")).toBe(false);
  });

  it("does not bind a modifier key itself", () => {
    expect(codeFromEvent({ code: "ShiftLeft", shiftKey: true })).toBeNull();
    expect(codeFromEvent({ code: "MetaLeft", metaKey: true })).toBeNull();
    expect(codeFromEvent({ code: "ControlLeft", ctrlKey: true })).toBeNull();
  });

  it("accepts a rebound key and rejects the old one", () => {
    expect(matchesShortcut({ code: "KeyP" }, "KeyP")).toBe(true);
    expect(matchesShortcut({ code: "Backquote" }, "KeyP")).toBe(false);
  });
});

describe("reading mode shortcuts", () => {
  it("maps main-row 1/2/3 to 段/句/词", () => {
    expect(readingModeForCode("Digit1")).toBe("paras");
    expect(readingModeForCode("Digit2")).toBe("sentence");
    expect(readingModeForCode("Digit3")).toBe("gloss");
  });

  it("ignores the numpad and every other key", () => {
    for (const code of ["Numpad1", "Numpad2", "Numpad3", "Digit4", "Digit0", "KeyA", ""]) {
      expect(readingModeForCode(code)).toBeNull();
    }
  });
});

describe("shortcut labels", () => {
  it("renders letters, digits and punctuation", () => {
    expect(shortcutLabel("KeyP")).toBe("P");
    expect(shortcutLabel("Digit1")).toBe("1");
    expect(shortcutLabel("Comma")).toBe(",");
    expect(shortcutLabel("UnknownKey")).toBe("UnknownKey");
  });
});

describe("shortcut persistence", () => {
  it("falls back to the default without a stored value", () => {
    expect(parseShortcutSettings(null)).toEqual({ playPause: "Backquote" });
  });

  it("reads a stored binding", () => {
    expect(parseShortcutSettings(JSON.stringify({ playPause: "KeyP" }))).toEqual({
      playPause: "KeyP",
    });
  });

  it("survives malformed or empty stored values", () => {
    expect(parseShortcutSettings("{not json")).toEqual({ playPause: "Backquote" });
    expect(parseShortcutSettings(JSON.stringify({}))).toEqual({ playPause: "Backquote" });
    expect(parseShortcutSettings(JSON.stringify({ playPause: "" }))).toEqual({
      playPause: "Backquote",
    });
  });
});
