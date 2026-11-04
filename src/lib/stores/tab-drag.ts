import { writable } from "svelte/store";
import type { PaneId } from "./panes";

export interface DragRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface TabDragTarget {
  pane: PaneId;
  /** Insertion slot among the row's tabs, with the dragged tab left out. */
  index: number;
}

export type TabDragPhase = "dragging" | "landing" | "returning";

/**
 * The tab currently being dragged. This is shared because both columns render
 * their own row: the source row closes up, the target row opens a gap, and the
 * ghost is painted once above both of them.
 */
export interface TabDragState {
  tabId: string;
  sourcePane: PaneId;
  sourceIndex: number;
  /** Where the tab sat when the drag began; the return animation flies to it. */
  sourceRect: DragRect;
  /** Current ghost position, in viewport coordinates. */
  x: number;
  y: number;
  width: number;
  height: number;
  target: TabDragTarget | null;
  phase: TabDragPhase;
}

export const tabDrag = writable<TabDragState | null>(null);
