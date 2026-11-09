import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { get } from "svelte/store";

async function loadSettingsWith(stored: string | null) {
  vi.stubGlobal("localStorage", {
    getItem: () => stored,
    setItem: () => {},
  });
  vi.resetModules();
  const { settings } = await import("../../src/lib/stores/settings");
  return get(settings);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("wrapCodeBlocks setting", () => {
  it("keeps code blocks scrolling by default", async () => {
    expect((await loadSettingsWith(null)).wrapCodeBlocks).toBe(false);
  });

  it("keeps scrolling for settings saved before the option existed", async () => {
    const stored = JSON.stringify({ fontSize: 18, restoreTabsOnLaunch: false });
    expect((await loadSettingsWith(stored)).wrapCodeBlocks).toBe(false);
  });

  it("restores a saved choice to wrap", async () => {
    const stored = JSON.stringify({ wrapCodeBlocks: true });
    expect((await loadSettingsWith(stored)).wrapCodeBlocks).toBe(true);
  });
});

// The wrap itself is CSS on a class toggled by the setting; a node test has no
// DOM to render it, so guard the two ends of that link in the source.
describe("the renderer honours the setting", () => {
  const component = readFileSync(
    resolve(process.cwd(), "src/lib/components/MarkdownRenderer.svelte"),
    "utf8",
  );

  it("toggles the wrap-code class from the setting", () => {
    expect(component).toContain("class:wrap-code={$settings.wrapCodeBlocks}");
  });

  it("wraps pre blocks only under that class", () => {
    expect(component).toMatch(
      /article\.wrap-code :global\(pre\) \{[^}]*white-space: pre-wrap;/,
    );
  });
});
