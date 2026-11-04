import { describe, expect, it } from "vitest";
import { get } from "svelte/store";
import {
  A4_HEIGHT,
  A4_WIDTH,
  COLUMN_WIDTH,
  SIDE_COLUMN_WIDTH,
  pageWindowSize,
} from "../../src/lib/utils/page";

// The window is measured from the sheet out: chrome on top, the status bar
// under it, a 20px mat around a single page, and a scrollbar gutter plus the
// seam line per column when two sheets sit side by side.
const SINGLE = { layout: "single" as const, sideTabsWidth: 0, tocWidth: 0, chromeTop: 88 };

describe("A4 page window", () => {
  it("sizes the sheet as A4 at the 96px-per-inch reference", () => {
    expect(A4_WIDTH).toBe(794); // 210mm
    expect(A4_HEIGHT).toBe(1123); // 297mm
  });

  it("fits one sheet with its mat, chrome and status bar", () => {
    expect(pageWindowSize(SINGLE)).toEqual({ width: 834, height: 1235 });
  });

  it("keeps the sheet full width when the panels are open", () => {
    const size = pageWindowSize({ ...SINGLE, sideTabsWidth: 220, tocWidth: 240 });
    expect(size.width).toBe(834 + 220 + 240);
    expect(size.height).toBe(1235);
  });

  it("gives split two columns of sheet plus gutter", () => {
    expect(pageWindowSize({ layout: "split", sideTabsWidth: 0, tocWidth: 0, chromeTop: 88 }).width).toBe(
      2 * COLUMN_WIDTH,
    );
  });

  it("gives dual a seam line that split does not need", () => {
    expect(SIDE_COLUMN_WIDTH).toBe(COLUMN_WIDTH + 1);
    const dual = pageWindowSize({ layout: "dual", sideTabsWidth: 0, tocWidth: 0, chromeTop: 88 });
    expect(dual.width).toBe(1601);
    // Every column holds one full sheet: 794 of the 1601 minus the window's
    // scrollbar (6) and the pinned column's scrollbar and the seam.
    expect(1601 - 6 - 6 - 1).toBe(2 * A4_WIDTH);
  });

  it("shortens the height when the tab row moves to the side", () => {
    expect(pageWindowSize({ ...SINGLE, chromeTop: 44 }).height).toBe(1235 - 44);
  });

  it("clamps to the screen rather than hanging off it", () => {
    const size = pageWindowSize({ ...SINGLE, available: { width: 1280, height: 800 } });
    expect(size).toEqual({ width: 834, height: 800 });
  });

  it("opens the reader at the page width", async () => {
    // No localStorage in the node test environment, so this is the defaults path.
    const { settings } = await import("../../src/lib/stores/settings");
    expect(get(settings).maxWidth).toBe(A4_WIDTH);
    expect(get(settings).widthMode).toBe("comfortable");
  });
});
