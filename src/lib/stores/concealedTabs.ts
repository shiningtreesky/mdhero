import { writable } from "svelte/store";
import { pruneConcealed as pruneSet, toggleConcealed as toggleSet } from "$lib/utils/conceal";

/**
 * Tab ids whose content is covered in the dual reading layout. Session-only:
 * a fresh launch always shows both columns. Per-tab rather than per-pane, so
 * switching away from a covered document and back keeps it covered.
 */
export const concealedTabs = writable<ReadonlySet<string>>(new Set());

export function toggleConcealed(tabId: string | null | undefined): void {
  if (!tabId) return;
  concealedTabs.update((current) => toggleSet(current, tabId));
}

/** Forget ids whose tabs were closed. */
export function pruneConcealed(liveIds: Iterable<string>): void {
  concealedTabs.update((current) => pruneSet(current, liveIds));
}
