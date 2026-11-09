import { describe, expect, it } from "vitest";
import { canSaveTab, needsSaveAs, type SaveableTab } from "../../src/lib/utils/tab-save";

const tab = (filePath: string, dirty: boolean): SaveableTab => ({ filePath, dirty });

describe("save availability", () => {
  it("enables Save for a brand-new document before the first keystroke", () => {
    const fresh = tab("new://1760000000000-0", false);
    expect(needsSaveAs(fresh)).toBe(true);
    expect(canSaveTab(fresh)).toBe(true);
  });

  it("enables Save for a dirty file on disk", () => {
    expect(canSaveTab(tab("/docs/notes.md", true))).toBe(true);
  });

  it("keeps Save disabled for a clean file, paste/url tabs and no tab", () => {
    expect(canSaveTab(tab("/docs/notes.md", false))).toBe(false);
    expect(canSaveTab(tab("paste://1", false))).toBe(false);
    expect(canSaveTab(tab("url://https://example.com", false))).toBe(false);
    expect(canSaveTab(null)).toBe(false);
  });

  it("only treats new:// tabs as Save As targets", () => {
    expect(needsSaveAs(tab("new://1", true))).toBe(true);
    expect(needsSaveAs(tab("/docs/new.md", true))).toBe(false);
    expect(needsSaveAs(null)).toBe(false);
  });
});
