import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyCurrentTheme,
  getEffectiveTheme,
  initThemeListener,
  themeMode,
  toggleTheme,
} from "../../src/lib/stores/theme";

function stubDom(osDark: boolean, mediaQueryBroken = false): Set<string> {
  const classes = new Set<string>();
  vi.stubGlobal("document", {
    documentElement: {
      classList: {
        add: (name: string) => classes.add(name),
        remove: (name: string) => classes.delete(name),
      },
    },
  });
  vi.stubGlobal("window", {
    matchMedia: () => {
      if (mediaQueryBroken) throw new Error("matchMedia unavailable");
      return {
        matches: osDark,
        addEventListener: () => {},
        addListener: () => {},
      };
    },
  });
  return classes;
}

beforeEach(() => {
  themeMode.set("system");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("theme switching", () => {
  it("makes the first click visible on a light OS (system -> dark)", () => {
    const classes = stubDom(false);
    expect(getEffectiveTheme()).toBe("light");
    expect(toggleTheme()).toBe("dark");
    expect(classes.has("dark")).toBe(true);
    expect(toggleTheme()).toBe("light");
    expect(classes.has("dark")).toBe(false);
  });

  it("makes the first click visible on a dark OS (system -> light)", () => {
    const classes = stubDom(true);
    applyCurrentTheme();
    expect(classes.has("dark")).toBe(true);
    expect(toggleTheme()).toBe("light");
    expect(classes.has("dark")).toBe(false);
  });

  it("still follows the store when the OS media query API throws", () => {
    const classes = stubDom(false, true);
    expect(() => initThemeListener()).not.toThrow();
    themeMode.set("dark");
    expect(classes.has("dark")).toBe(true);
  });

  it("is safe without a document (SSR / startup)", () => {
    expect(() => applyCurrentTheme()).not.toThrow();
  });
});
