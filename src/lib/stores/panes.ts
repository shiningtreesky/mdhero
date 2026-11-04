import { writable } from "svelte/store";

/** Which column a tab sits in. The left column is the one the tab strip, the
 *  ToC and the window scroll have always belonged to; the right column is what
 *  the Dual button opens, and it holds the tabs that have been dragged over. */
export type PaneId = "left" | "right";

/**
 * The column whose document the single-owner parts of the app act on: the
 * keyboard shortcuts, search, the ToC, the status bar, save and print. There is
 * only ever one current document, which is what keeps those singletons single
 * while two documents still sit side by side.
 */
export const focusedPane = writable<PaneId>("left");

/** Whether the right column is on screen. An empty right column is useful: it
 *  is where a dragged tab lands before there is a second document to show. */
export const rightPaneOpen = writable(false);
