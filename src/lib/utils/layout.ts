// Geometry shared by the fixed-position parts of the window.
//
// The toolbar always runs across the top. The tabs are either a row under it
// or a resizable panel on the left. +page.svelte publishes the result as two
// CSS variables that the fixed elements position themselves from:
// `--chrome-top`, the height of everything above the document, and `--tabs-w`,
// the width of the side tabs panel (0 when the tabs are on top).

import type { ReaderSettings } from "$lib/stores/settings";

/** Height of the chrome when the tabs are on the side: the toolbar alone, as
 *  it renders since the View/Split/Edit switcher (#19). The side tabs panel
 *  starts right under it. */
export const SIDE_TABS_CHROME = 44;
/** Height of the chrome when the tabs are a row under the toolbar: the
 *  toolbar, then the 44px tab row, which sticks right under it. */
export const TOP_TABS_CHROME = 88;

/** Width of the side tabs panel for these settings, 0 when tabs are on top. */
export function sideTabsWidth(s: Pick<ReaderSettings, "tabsPosition" | "tabsWidth">): number {
  return s.tabsPosition === "side" ? s.tabsWidth : 0;
}

/** The chrome height for a side tabs panel of that width: moving the tabs to
 *  the side drops the tab row, so the document starts higher. */
export function chromeTopFor(width: number): number {
  return width > 0 ? SIDE_TABS_CHROME : TOP_TABS_CHROME;
}

/** Height of the chrome above the document, as currently published. */
export function chromeTop(): number {
  const value = parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue("--chrome-top"),
  );
  return Number.isFinite(value) ? value : TOP_TABS_CHROME;
}

/**
 * Reflow notification for overlays that position themselves from DOM rects.
 *
 * Pinned gloss bubbles, sentence bubbles and paragraph cards are `position:
 * fixed` elements placed from `getBoundingClientRect()`. They already follow
 * scrolling and window resizes, but a type-settings change (line spacing in
 * particular) reflows the article without either event — Svelte writes the new
 * value into the article's inline style object, which fires no mutation record
 * the actions listen for.
 *
 * The reading pane therefore announces the reflow once the new style is in the
 * DOM, and every overlay re-glues itself to its anchor.
 */
export const LAYOUT_CHANGE_EVENT = "mdhero:layout-change";

export function notifyLayoutChange(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(LAYOUT_CHANGE_EVENT));
}
