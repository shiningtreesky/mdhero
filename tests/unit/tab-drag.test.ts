import { describe, expect, it } from "vitest";
import {
  addEmptyPaneRow,
  clipRowsToSeam,
  resolveDrop,
  type TabRowGeometry,
} from "../../src/lib/utils/tab-drag";

// Two rows sitting side by side in the same band: the left column's row spans
// 8..810, the right column's row spans 810..1610, both at y 44..88. The left
// row holds tabs ending at 108 and 208, plus the trailing slack element.
const LEFT: TabRowGeometry = {
  pane: "left",
  left: 8,
  right: 810,
  top: 44,
  bottom: 88,
  orientation: "horizontal",
  childEnds: [108, 208],
};
const RIGHT: TabRowGeometry = {
  pane: "right",
  left: 810,
  right: 1610,
  top: 44,
  bottom: 88,
  orientation: "horizontal",
  childEnds: [930],
};
const ROWS = [LEFT, RIGHT];

// The side panel's tab column: one row at x 8..228 whose tabs end at y 100 and
// y 140.
const SIDE: TabRowGeometry = {
  pane: "left",
  left: 8,
  right: 228,
  top: 44,
  bottom: 600,
  orientation: "vertical",
  childEnds: [100, 140],
};

describe("tab drag across columns", () => {
  it("names the column the pointer is over, not the one the drag started in", () => {
    expect(resolveDrop(ROWS, 150, 60)?.pane).toBe("left");
    expect(resolveDrop(ROWS, 900, 60)?.pane).toBe("right");
    expect(resolveDrop(ROWS, 1400, 87)?.pane).toBe("right");
  });

  it("finds no drop target when the pointer is outside every row", () => {
    expect(resolveDrop(ROWS, 900, 20)).toBeNull(); // over the toolbar
    expect(resolveDrop(ROWS, 900, 300)).toBeNull(); // over the documents
    expect(resolveDrop(ROWS, 4000, 60)).toBeNull();
  });

  it("maps x to the slot before the tab it lands on", () => {
    expect(resolveDrop(ROWS, 50, 60)?.index).toBe(0); // before the first tab
    expect(resolveDrop(ROWS, 150, 60)?.index).toBe(1); // between tab 1 and tab 2
    expect(resolveDrop(ROWS, 811, 60)?.index).toBe(0); // the other row's first slot
    expect(resolveDrop(ROWS, 1000, 60)?.index).toBe(1); // past that row's last tab
  });

  it("an empty column still offers its whole row as a target", () => {
    expect(resolveDrop([LEFT, { ...RIGHT, childEnds: [] }], 1500, 60)?.pane).toBe("right");
  });

  it("an empty column's body also takes drops below the tab strip", () => {
    // The right column has no tabs, so its blank body is the natural target.
    // Dropping there used to return null and leave the dragged tab behind.
    const body = { left: 810, right: 1610, top: 88, bottom: 900 };
    const rows = addEmptyPaneRow([LEFT, { ...RIGHT, childEnds: [] }], "right", body, false);
    expect(resolveDrop(rows, 1200, 300)).toEqual({ pane: "right", index: 0 });
  });

  it("a column with tabs only takes drops on its tab strip", () => {
    const body = { left: 810, right: 1610, top: 88, bottom: 900 };
    const rows = addEmptyPaneRow([LEFT, RIGHT], "right", body, true);
    expect(rows).toHaveLength(2);
    expect(resolveDrop(rows, 1200, 300)).toBeNull();
  });

  it("clips the left strip at the seam so an empty left column is a target too", () => {
    // Measured from the whole strip, the left row spans the window; with no
    // tabs of its own it must still take drops in the middle of its column.
    const emptyLeft: TabRowGeometry = { ...LEFT, right: 1610, childEnds: [] };
    const rows = clipRowsToSeam([emptyLeft, RIGHT], 810);
    expect(rows[0].right).toBe(810);
    expect(resolveDrop(rows, 400, 60)).toEqual({ pane: "left", index: 0 });
    expect(resolveDrop(rows, 900, 60)?.pane).toBe("right");
  });

  it("keeps the whole row when there is no right column", () => {
    const rows = clipRowsToSeam([{ ...LEFT, right: 1610, childEnds: [] }], null);
    expect(resolveDrop(rows, 1500, 60)?.pane).toBe("left");
  });

  it("does not clip a side-panel row", () => {
    expect(clipRowsToSeam([SIDE], 810)[0].right).toBe(228);
  });
});

describe("side-panel tab drag", () => {
  it("maps y to the slot before the tab it lands on", () => {
    expect(resolveDrop([SIDE], 100, 60)?.index).toBe(0);
    expect(resolveDrop([SIDE], 100, 120)?.index).toBe(1);
    expect(resolveDrop([SIDE], 100, 300)?.index).toBe(2);
  });

  it("ignores y when the pointer is beside the panel", () => {
    expect(resolveDrop([SIDE], 500, 120)).toBeNull();
  });
});
