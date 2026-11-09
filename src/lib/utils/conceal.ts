/**
 * Column concealment for the dual reading layout.
 *
 * The cover state is keyed by tab id, not by pane, so switching a column to
 * another document and back restores that document's own state. The helpers
 * are pure sets so the toggle rules stay testable without a DOM.
 */

/** Toggle one tab id, returning a new set. */
export function toggleConcealed(
  current: ReadonlySet<string>,
  tabId: string,
): Set<string> {
  const next = new Set(current);
  if (next.has(tabId)) next.delete(tabId);
  else next.add(tabId);
  return next;
}

/** Drop ids whose tab is gone; returns the original set when nothing changed. */
export function pruneConcealed(
  current: ReadonlySet<string>,
  liveIds: Iterable<string>,
): ReadonlySet<string> {
  const live = new Set(liveIds);
  const next = new Set([...current].filter((id) => live.has(id)));
  return next.size === current.size ? current : next;
}
