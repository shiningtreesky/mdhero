// The document is laid out on one A4 sheet of paper.

/** A4 is 210 × 297 mm; against the 96 CSS-px-per-inch reference that is
 *  794 × 1123. The sheet is A4 in proportion and in print, not measured to the
 *  millimetre against the display: nothing here reads the panel's real DPI. */
export const A4_WIDTH = 794;
export const A4_HEIGHT = 1123;

/** Gray mat between the sheet edge and the window edge. */
const PAGE_MAT = 20;

/** `::-webkit-scrollbar` reserves this much of the client width (see app.css),
 *  so a scrollable column needs it back to keep its sheet full width. */
const SCROLLBAR_GUTTER = 6;

/** The line that separates two columns. Without a pixel of its own the pinned
 *  sheet loses one from its A4 width. */
const COLUMN_DIVIDER = 1;

/** The primary column: one sheet, and the window's own scrollbar. */
export const COLUMN_WIDTH = A4_WIDTH + SCROLLBAR_GUTTER;

/** The pinned column of the dual layout: one sheet, its own scrollbar, and the
 *  seam between the two columns. */
export const SIDE_COLUMN_WIDTH = COLUMN_WIDTH + COLUMN_DIVIDER;

/** The fixed status bar sits over the bottom of the window, below the sheet. */
const STATUS_BAR_HEIGHT = 24;

/** How many sheets the layout puts side by side, and how they are separated. */
export type PageLayout = "single" | "split" | "dual"

export interface PageWindowInput {
  /** `split` is editor + preview of one document; `dual` is two documents. */
  layout: PageLayout;
  /** Side tabs panel width; 0 when the tabs are the row on top. */
  sideTabsWidth: number;
  /** Table-of-contents sidebar width; 0 when it is hidden. */
  tocWidth: number;
  /** Toolbar and tab row above the document. */
  chromeTop: number;
  /** Screen room to fit inside. Omitted, the size is returned unclamped. */
  available?: { width: number; height: number };
}

/** The window size, in logical pixels, that shows a whole sheet per column
 *  without scrolling. Clamped to `available`, so on a screen shorter than a
 *  page the sheet keeps its A4 size and the window scrolls instead. */
export function pageWindowSize(input: PageWindowInput): { width: number; height: number } {
  // A column pays for its own scrollbar; in the single layout the mat absorbs
  // the window's instead, and the ToC and side tabs panels sit outside both.
  const sheetRoom =
    input.layout === "dual" ? COLUMN_WIDTH + SIDE_COLUMN_WIDTH
    : input.layout === "split" ? 2 * COLUMN_WIDTH
    : A4_WIDTH + 2 * PAGE_MAT;
  const width = sheetRoom + input.sideTabsWidth + input.tocWidth;
  const height = input.chromeTop + A4_HEIGHT + STATUS_BAR_HEIGHT;
  if (!input.available) return { width, height };
  return {
    width: Math.min(width, input.available.width),
    height: Math.min(height, input.available.height),
  };
}
