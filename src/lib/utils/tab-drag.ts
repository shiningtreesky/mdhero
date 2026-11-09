import type { PaneId } from "../stores/panes";

/** One column's tab row, as measured in the window. `childEnds` holds the far
 *  edge of every tab in the row — right edges for a horizontal row, bottom
 *  edges for the vertical side panel — which turns a pointer position into a
 *  slot. The dragged tab and the drag placeholder are left out: an index is
 *  therefore both a slot in the remaining tabs and the insertion index used on
 *  drop. */
export interface TabRowGeometry {
  pane: PaneId;
  left: number;
  right: number;
  top: number;
  bottom: number;
  orientation: "horizontal" | "vertical";
  childEnds: number[];
}

/**
 * The left tab strip stretches across the whole window and only reserves the
 * right column with padding, so its measured box overlaps the right strip.
 * Clip it at the seam where the pinned right column starts (null when there is
 * no right column). Every pointer position then belongs to exactly one row,
 * while a left row with no tabs still covers its whole column.
 */
export function clipRowsToSeam(
  rows: TabRowGeometry[],
  seam: number | null,
): TabRowGeometry[] {
  if (seam === null || !Number.isFinite(seam)) return rows;
  return rows.map((row) =>
    row.pane === "left" && row.orientation === "horizontal" && row.right > seam
      ? { ...row, right: seam }
      : row,
  );
}

/**
 * The row a dragged tab should drop into, and the slot inside that row. A
 * pointer outside every row drops nowhere, so a drag that never enters a row
 * leaves the tab where it was instead of jumping to the first row.
 */
export function resolveDrop(
  rows: TabRowGeometry[],
  x: number,
  y: number,
): { pane: PaneId; index: number } | null {
  for (const row of rows) {
    if (x < row.left || x > row.right || y < row.top || y > row.bottom) continue;
    const point = row.orientation === "vertical" ? y : x;
    let index = row.childEnds.length;
    for (let i = 0; i < row.childEnds.length; i++) {
      if (point < row.childEnds[i]) {
        index = i;
        break;
      }
    }
    return { pane: row.pane, index };
  }
  return null;
}
