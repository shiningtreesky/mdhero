import { afterEach, describe, expect, it, vi } from "vitest";
import { get } from "svelte/store";

async function loadGlossaryWith(stored: string | null) {
  vi.stubGlobal("localStorage", {
    getItem: () => stored,
    setItem: () => {},
  });
  vi.resetModules();
  const { glossarySettings } = await import("../../src/lib/stores/glossarySettings");
  return get(glossarySettings);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("glossary speak-on-click setting", () => {
  it("defaults to off", async () => {
    expect((await loadGlossaryWith(null)).speakOnClick).toBe(false);
  });

  it("restores a saved choice either way", async () => {
    for (const value of [true, false]) {
      const stored = JSON.stringify({ speakOnClick: value });
      expect((await loadGlossaryWith(stored)).speakOnClick).toBe(value);
    }
  });

  it("falls back to the default for anything that is not a boolean", async () => {
    for (const junk of ["false", "true", null, 0, 1, "", {}]) {
      const stored = JSON.stringify({ speakOnClick: junk });
      expect((await loadGlossaryWith(stored)).speakOnClick).toBe(false);
    }
  });
});

describe("glossary phonetic settings", () => {
  it("defaults to off with both accents selected", async () => {
    const settings = await loadGlossaryWith(null);
    expect(settings.showPhonetic).toBe(false);
    expect(settings.phoneticUk).toBe(true);
    expect(settings.phoneticUs).toBe(true);
  });

  it("restores saved choices", async () => {
    const stored = JSON.stringify({
      showPhonetic: true,
      phoneticUk: false,
      phoneticUs: true,
    });
    const settings = await loadGlossaryWith(stored);
    expect(settings.showPhonetic).toBe(true);
    expect(settings.phoneticUk).toBe(false);
    expect(settings.phoneticUs).toBe(true);
  });

  it("falls back to defaults for non-booleans", async () => {
    const stored = JSON.stringify({
      showPhonetic: "yes",
      phoneticUk: null,
      phoneticUs: 0,
    });
    const settings = await loadGlossaryWith(stored);
    expect(settings.showPhonetic).toBe(false);
    expect(settings.phoneticUk).toBe(true);
    expect(settings.phoneticUs).toBe(true);
  });
});
