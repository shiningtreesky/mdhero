import { beforeEach, describe, expect, it, vi } from "vitest";
import { get } from "svelte/store";

/**
 * The two columns of the dual layout. One flat tab list carries a `pane`
 * field, and each column has its own active tab, so a document is read in one
 * place at a time and moving one across is the same operation as dragging its
 * tab between the two rows.
 */
async function freshStores() {
  vi.resetModules();
  (globalThis as any).localStorage = { getItem: () => null, setItem: () => {} };
  (globalThis as any).window = { scrollY: 0 };
  const tabsMod = await import("../../src/lib/stores/tabs");
  const panesMod = await import("../../src/lib/stores/panes");
  return {
    store: tabsMod.tabStore,
    focusedPane: panesMod.focusedPane,
    rightPaneOpen: panesMod.rightPaneOpen,
  };
}

function ids(store: Awaited<ReturnType<typeof freshStores>>["store"]) {
  return {
    left: store.paneTabs("left").map((t) => t.id),
    right: store.paneTabs("right").map((t) => t.id),
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("columns of tabs", () => {
  it("opens a new tab in the left column and in the one asked for", async () => {
    const { store } = await freshStores();
    const a = store.addTab("/docs/a.md", "a.md", "", "");
    const b = store.addTab("/docs/b.md", "b.md", "", "", null, 0, "right");

    expect(ids(store)).toEqual({ left: [a], right: [b] });
  });

  it("a dragged tab becomes the other column's active one, and its old column falls back", async () => {
    const { store, focusedPane } = await freshStores();
    const a = store.addTab("/docs/a.md", "a.md", "", "");
    const b = store.addTab("/docs/b.md", "b.md", "", "");
    store.closeTab(a); // leaves b active
    expect(ids(store)).toEqual({ left: [b], right: [] });

    store.moveTabToPane(b, "right");

    expect(ids(store)).toEqual({ left: [], right: [b] });
    expect(get(focusedPane)).toBe("right");
    expect(get(store.activeIds)).toEqual({ left: "__home__", right: b });
  });

  it("opening the right column by dragging is enough to make it appear", async () => {
    const { store, rightPaneOpen } = await freshStores();
    const a = store.addTab("/docs/a.md", "a.md", "", "");
    expect(get(rightPaneOpen)).toBe(false);

    store.moveTabToPane(a, "right");
    expect(get(rightPaneOpen)).toBe(true);
  });

  it("closing a tab leaves the other column reading whatever it had", async () => {
    const { store } = await freshStores();
    const left = store.addTab("/docs/left.md", "left.md", "", "");
    const right = store.addTab("/docs/right.md", "right.md", "", "", null, 0, "right");

    store.closeTab(right);

    expect(get(store.activeIds)).toEqual({ left, right: "__home__" });
    // The left column never lost its own document.
    expect(store.paneTabs("left")[0].filePath).toBe("/docs/left.md");
  });

  it("clicking a tab in the other column makes that column the current one", async () => {
    const { store, focusedPane } = await freshStores();
    store.addTab("/docs/left.md", "left.md", "", "");
    const right = store.addTab("/docs/right.md", "right.md", "", "", null, 0, "right");

    store.switchTab(right);
    expect(get(focusedPane)).toBe("right");
    store.switchTab(store.paneTabs("left")[0].id);
    expect(get(focusedPane)).toBe("left");
  });

  it("handing the right column back keeps the document that was being read", async () => {
    const { store, focusedPane, rightPaneOpen } = await freshStores();
    const left = store.addTab("/docs/left.md", "left.md", "", "");
    const right = store.addTab("/docs/right.md", "right.md", "", "", null, 0, "right");
    store.switchTab(right);
    expect(get(focusedPane)).toBe("right");

    store.collapseRightPane();

    expect(get(rightPaneOpen)).toBe(false);
    expect(ids(store)).toEqual({ left: [left, right], right: [] });
    expect(get(focusedPane)).toBe("left");
    expect(get(store.activeIds).left).toBe(right);
  });

  it("moves a dragged tab into the slot it was dropped on", async () => {
    const { store } = await freshStores();
    const l = store.addTab("/docs/l.md", "l.md", "", "");
    const r1 = store.addTab("/docs/r1.md", "r1.md", "", "", null, 0, "right");
    const r2 = store.addTab("/docs/r2.md", "r2.md", "", "", null, 0, "right");

    store.moveTabToPane(l, "right", 1);

    expect(ids(store)).toEqual({ left: [], right: [r1, l, r2] });
  });

  it("drops onto an empty column at its first slot", async () => {
    const { store } = await freshStores();
    const a = store.addTab("/docs/a.md", "a.md", "", "");
    const b = store.addTab("/docs/b.md", "b.md", "", "");

    store.moveTabToPane(a, "right", 0);
    store.moveTabToPane(b, "right", 1);

    expect(ids(store)).toEqual({ left: [], right: [a, b] });
  });

  it("reordering inside a column never pulls a tab across or past one", async () => {
    const { store } = await freshStores();
    const l1 = store.addTab("/docs/1.md", "1.md", "", "");
    const l2 = store.addTab("/docs/2.md", "2.md", "", "");
    const r1 = store.addTab("/docs/r.md", "r.md", "", "", null, 0, "right");

    store.reorderTabs("left", 1, 0);

    expect(ids(store)).toEqual({ left: [l2, l1], right: [r1] });
  });
});
