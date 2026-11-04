import { derived, get, writable } from "svelte/store";
import { focusedPane, rightPaneOpen, type PaneId } from "./panes";

export interface Tab {
  id: string;
  filePath: string;
  fileName: string;
  content: string;
  renderedHtml: string;
  frontmatter: Record<string, unknown> | null;
  wordCount: number;
  scrollTop: number;
  isEditing: boolean;
  editContent: string;
  dirty: boolean;
  lastSavedAt: number;
  /**
   * The file changed on disk while this tab had unsaved edits (#97). The edits
   * are kept; this flag marks the tab and makes Save ask before overwriting.
   * Cleared by a save, or once the tab is no longer dirty.
   */
  diskChanged: boolean;
  /** The column the tab is shown in. A tab belongs to one column, which is why
   *  dragging one across is a move rather than a copy. */
  pane: PaneId;
}

export const HOME_TAB_ID = "__home__";

/**
 * What survives a restart (#72): the on-disk files that were open, in tab
 * order, and which of them was active (`null` when the home tab was). Nothing
 * else — unsaved edits, scroll offsets and the `paste://` / `url://` / `new://`
 * tabs have no file to come back from.
 *
 * `paths` is the left column's set, so a session saved before the two-column
 * layout restores everything into it. `rightPaths` / `rightOpen` describe the
 * right column and are absent in those older sessions.
 */
export interface SavedSession {
  paths: string[];
  activePath: string | null;
  rightPaths?: string[];
  rightOpen?: boolean;
}

const SESSION_KEY = "mdhero-session";

function isRestorablePath(filePath: string): boolean {
  return !!filePath
    && !filePath.startsWith("paste://")
    && !filePath.startsWith("url://")
    && !filePath.startsWith("new://");
}

function loadSession(): SavedSession | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed?.paths)) return null;
    const rightPaths = Array.isArray(parsed.rightPaths)
      ? parsed.rightPaths.filter((p: unknown) => typeof p === "string" && isRestorablePath(p))
      : [];
    const session: SavedSession = {
      paths: parsed.paths.filter((p: unknown) => typeof p === "string" && isRestorablePath(p)),
      activePath: typeof parsed.activePath === "string" ? parsed.activePath : null,
    };
    // Only describe the right column when the stored session has one, so a
    // session written before the two-column layout reads back unchanged.
    if (rightPaths.length > 0 || parsed.rightOpen === true) {
      session.rightPaths = rightPaths;
      session.rightOpen = parsed.rightOpen === true || rightPaths.length > 0;
    }
    return session;
  } catch {
    return null;
  }
}

function saveSession(session: SavedSession) {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  } catch {}
}

function createTabStore() {
  const tabs = writable<Tab[]>([]);

  // One active tab per column. Everything that used to follow one global active
  // tab — the document store, the ToC, search, the status bar, the keyboard —
  // reads `activeTabId`, which is the active tab of whichever column has focus.
  // That keeps those singletons single instead of cloning them per column.
  const activeIds = writable<Record<PaneId, string | null>>({ left: HOME_TAB_ID, right: null });
  const activeTabId = derived([activeIds, focusedPane], ([ids, pane]) => ids[pane] ?? HOME_TAB_ID);

  // Captured once, before the persistence subscription below overwrites the
  // key with this (empty) session. `restoreSession` reads it on launch.
  const savedSession = loadSession();

  function persistSession() {
    const currentTabs = get(tabs);
    const restorable = currentTabs.filter((t) => isRestorablePath(t.filePath));
    const active = currentTabs.find((t) => t.id === get(activeTabId));
    const rightPaths = restorable.filter((t) => t.pane === "right").map((t) => t.filePath);
    const session: SavedSession = {
      paths: restorable.filter((t) => t.pane === "left").map((t) => t.filePath),
      activePath: active && isRestorablePath(active.filePath) ? active.filePath : null,
    };
    // Only name the right column when there is something to say about it, so a
    // session that never opened one keeps the shape that has always been written.
    if (rightPaths.length > 0 || get(rightPaneOpen)) {
      session.rightPaths = rightPaths;
      session.rightOpen = get(rightPaneOpen);
    }
    saveSession(session);
  }
  tabs.subscribe(persistSession);
  activeTabId.subscribe(persistSession);

  /** The session as it was when this store initialised — i.e. the previous run's. */
  function getSavedSession(): SavedSession | null {
    return savedSession;
  }

  function generateId(): string {
    return Math.random().toString(36).slice(2, 10);
  }

  function setPaneActive(pane: PaneId, id: string | null, focus = true) {
    activeIds.update((m) => ({ ...m, [pane]: id }));
    if (focus) focusedPane.set(pane);
  }

  function activeIn(pane: PaneId): string | null {
    return get(activeIds)[pane];
  }

  /** Tabs of one column, in the order the row shows them. */
  function paneTabs(pane: PaneId, list = get(tabs)): Tab[] {
    return list.filter((t) => t.pane === pane);
  }

  /** When the active tab of a column disappears, the tab next to it takes over. */
  function pickFallback(pane: PaneId, index: number, list: Tab[]) {
    const rest = paneTabs(pane, list);
    setPaneActive(pane, rest.length ? rest[Math.min(index, rest.length - 1)].id : HOME_TAB_ID, false);
  }

  function addTab(
    filePath: string,
    fileName: string,
    content: string,
    renderedHtml: string,
    frontmatter?: Record<string, unknown> | null,
    wordCount?: number,
    /** The column to open it in; defaults to the column being worked in. */
    pane: PaneId = get(focusedPane),
    /** Insert the tab right after this tab instead of at the end of the row. */
    afterTabId?: string,
  ): string {
    const currentTabs = get(tabs);

    // If file is already open, switch to it. A file has one tab and that tab
    // belongs to one column, so the same document cannot sit in both columns.
    const existing = currentTabs.find((t) => t.filePath === filePath);
    if (existing) {
      setPaneActive(existing.pane, existing.id);
      tabs.update((ts) =>
        ts.map((t) => {
          if (t.id !== existing.id) return t;
          // Preserve edit state on re-add — only refresh content/render if not dirty
          if (t.isEditing) {
            const dirty = t.editContent !== content;
            return { ...t, content, renderedHtml, frontmatter: frontmatter ?? null, wordCount: wordCount ?? 0, dirty };
          }
          return { ...t, content, renderedHtml, frontmatter: frontmatter ?? null, wordCount: wordCount ?? 0, editContent: content, dirty: false };
        })
      );
      return existing.id;
    }

    const id = generateId();
    const newTab: Tab = {
      id,
      filePath,
      fileName,
      content,
      renderedHtml,
      frontmatter: frontmatter ?? null,
      wordCount: wordCount ?? 0,
      scrollTop: 0,
      isEditing: false,
      editContent: content,
      dirty: false,
      lastSavedAt: 0,
      diskChanged: false,
      pane,
    };

    const afterIndex = afterTabId
      ? currentTabs.findIndex((t) => t.id === afterTabId)
      : -1;
    const insertAt = afterIndex >= 0 ? afterIndex + 1 : currentTabs.length;
    tabs.update((ts) => [...ts.slice(0, insertAt), newTab, ...ts.slice(insertAt)]);
    setPaneActive(pane, id);
    return id;
  }

  /**
   * Replace a tab's content while a translation is streaming into it. The
   * rendered HTML is refreshed by the caller at a throttled rate; `dirty` stays
   * false until a write fails, so the tab does not look like an unsaved edit
   * while the translation is still arriving.
   */
  function updateStreamingContent(
    id: string,
    content: string,
    renderedHtml: string,
    frontmatter: Record<string, unknown> | null,
    wordCount: number,
    dirty = false,
  ) {
    tabs.update((ts) =>
      ts.map((t) =>
        t.id === id
          ? {
              ...t,
              content,
              editContent: content,
              renderedHtml,
              frontmatter,
              wordCount,
              dirty,
            }
          : t,
      ),
    );
  }

  /** The translation finished and its final content is on disk. */
  function finishStreaming(
    id: string,
    content: string,
    renderedHtml: string,
    frontmatter: Record<string, unknown> | null,
    wordCount: number,
  ) {
    tabs.update((ts) =>
      ts.map((t) =>
        t.id === id
          ? {
              ...t,
              content,
              editContent: content,
              renderedHtml,
              frontmatter,
              wordCount,
              dirty: false,
              diskChanged: false,
              lastSavedAt: Date.now(),
            }
          : t,
      ),
    );
  }

  function closeTab(id: string) {
    if (id === HOME_TAB_ID) return; // Can't close home tab
    saveScrollPosition();
    const currentTabs = get(tabs);
    const tab = currentTabs.find((t) => t.id === id);
    if (!tab) return;

    const indexInPane = paneTabs(tab.pane, currentTabs).findIndex((t) => t.id === id);
    const newTabs = currentTabs.filter((t) => t.id !== id);
    tabs.set(newTabs);

    // Only the column that owned the tab moves to a neighbour. The other column
    // keeps showing whatever it was showing.
    if (activeIn(tab.pane) === id) pickFallback(tab.pane, indexInPane, newTabs);
  }

  function goHome() {
    saveScrollPosition();
    setPaneActive(get(focusedPane), HOME_TAB_ID);
  }

  function saveScrollPosition() {
    const currentId = get(activeTabId);
    if (currentId) {
      const scrollTop = window.scrollY;
      tabs.update((ts) =>
        ts.map((t) => (t.id === currentId ? { ...t, scrollTop } : t))
      );
    }
  }

  function switchTab(id: string) {
    const tab = get(tabs).find((t) => t.id === id);
    if (!tab) return;
    // Clicking a tab in the other column makes that column the one the keyboard,
    // search and ToC act on. If the tab is already that column's active one,
    // only the focus changes.
    if (activeIn(tab.pane) === id) {
      focusedPane.set(tab.pane);
      return;
    }
    saveScrollPosition();
    setPaneActive(tab.pane, id);
  }

  /** Drag a tab into the other column: it becomes that column's active tab, and
   *  the column it came from falls back to a neighbour. The editor goes with the
   *  column that was being worked in, so the tab leaves edit mode.
   *  `index` is the slot in the destination row (0 = before its first tab,
   *  omitted = at the end). */
  function moveTabToPane(id: string, pane: PaneId, index?: number) {
    const currentTabs = get(tabs);
    const tab = currentTabs.find((t) => t.id === id);
    if (!tab || tab.pane === pane) return;
    const indexInPane = paneTabs(tab.pane, currentTabs).findIndex((t) => t.id === id);
    const without = currentTabs.filter((t) => t.id !== id);
    const destination = paneTabs(pane, without);
    const slot = index === undefined
      ? destination.length
      : Math.max(0, Math.min(index, destination.length));
    // Turn the column-local slot into a position in the flat tab list: before
    // the tab now in that slot, or after the last tab when appending.
    let globalIndex = without.length;
    if (slot < destination.length) {
      globalIndex = without.findIndex((t) => t.id === destination[slot].id);
    } else if (destination.length > 0) {
      globalIndex = without.findIndex((t) => t.id === destination[destination.length - 1].id) + 1;
    }
    const moved = [
      ...without.slice(0, globalIndex),
      { ...tab, pane, isEditing: false },
      ...without.slice(globalIndex),
    ];
    tabs.set(moved);
    rightPaneOpen.set(true);
    if (activeIn(tab.pane) === id) pickFallback(tab.pane, indexInPane, moved);
    setPaneActive(pane, id);
  }

  /** Close the right column, handing its tabs back to the left column at the end
   *  of that row, and keeping whatever was being read the active one. */
  function collapseRightPane() {
    rightPaneOpen.set(false);
    const current = get(tabs);
    const right = current.filter((t) => t.pane === "right");
    if (right.length === 0) return;
    const left = current.filter((t) => t.pane === "left");
    tabs.set([...left, ...right.map((t) => ({ ...t, pane: "left" as PaneId }))]);
    const activeRight = activeIn("right");
    activeIds.update((m) => ({
      ...m,
      right: null,
      left: activeRight && activeRight !== HOME_TAB_ID ? activeRight : m.left,
    }));
    if (get(focusedPane) === "right") focusedPane.set("left");
  }

  function updateTabContent(filePath: string, content: string, renderedHtml: string, frontmatter?: Record<string, unknown> | null, wordCount?: number) {
    tabs.update((ts) =>
      ts.map((t) => {
        if (t.filePath !== filePath) return t;
        const next: Tab = {
          ...t,
          content,
          renderedHtml,
          frontmatter: frontmatter ?? t.frontmatter,
          wordCount: wordCount ?? t.wordCount,
        };
        // Preserve in-progress edits when content updates from external sources (file watcher)
        if (t.isEditing) {
          next.dirty = t.editContent !== content;
          // Remember that the disk moved under unsaved edits, so the tab can
          // show it and Save can ask first (#97). Not raised when the disk
          // now matches what the user typed — there is nothing to lose then.
          next.diskChanged = next.dirty && (t.diskChanged || content !== t.content);
        } else {
          next.editContent = content;
          next.dirty = false;
          next.diskChanged = false;
        }
        return next;
      })
    );
  }

  function getActiveTab(): Tab | null {
    const id = get(activeTabId);
    if (!id || id === HOME_TAB_ID) return null;
    return get(tabs).find((t) => t.id === id) ?? null;
  }

  /** Move a tab along its column's row. The indexes are column-local — each
   *  column has its own row — while the store keeps one flat list. */
  function reorderTabs(pane: PaneId, fromIndex: number, toIndex: number) {
    tabs.update((ts) => {
      const globalIndex = (columnLocal: number) => {
        let seen = -1;
        for (let i = 0; i < ts.length; i++) {
          if (ts[i].pane === pane && ++seen === columnLocal) return i;
        }
        return -1;
      };
      const from = globalIndex(fromIndex);
      const to = globalIndex(toIndex);
      if (from < 0 || to < 0) return ts;
      const arr = [...ts];
      const [moved] = arr.splice(from, 1);
      arr.splice(to, 0, moved);
      return arr;
    });
  }

  function setEditing(id: string, editing: boolean) {
    tabs.update((ts) =>
      ts.map((t) => {
        if (t.id !== id) return t;
        // When entering edit mode, sync editContent to current content if not already dirty
        if (editing && !t.isEditing && !t.dirty) {
          return { ...t, isEditing: true, editContent: t.content };
        }
        return { ...t, isEditing: editing };
      })
    );
  }

  function updateEditContent(id: string, newContent: string) {
    tabs.update((ts) =>
      ts.map((t) => {
        if (t.id !== id) return t;
        return { ...t, editContent: newContent, dirty: newContent !== t.content };
      })
    );
  }

  function markSaved(id: string) {
    tabs.update((ts) =>
      ts.map((t) => {
        if (t.id !== id) return t;
        return { ...t, content: t.editContent, dirty: false, diskChanged: false, lastSavedAt: Date.now() };
      })
    );
  }

  function getLastSavedAt(filePath: string): number {
    const t = get(tabs).find((x) => x.filePath === filePath);
    return t?.lastSavedAt ?? 0;
  }

  // Re-point a tab at a real filesystem path + name. Used when an unsaved
  // `new://` document gets a location on its first save (#63).
  function rebindPath(id: string, filePath: string, fileName: string) {
    tabs.update((ts) =>
      ts.map((t) => (t.id === id ? { ...t, filePath, fileName } : t))
    );
  }

  return {
    tabs,
    activeTabId,
    activeIds,
    addTab,
    closeTab,
    switchTab,
    updateTabContent,
    updateStreamingContent,
    finishStreaming,
    getActiveTab,
    reorderTabs,
    moveTabToPane,
    collapseRightPane,
    paneTabs,
    goHome,
    setEditing,
    updateEditContent,
    markSaved,
    getLastSavedAt,
    rebindPath,
    saveScrollPosition,
    getSavedSession,
  };
}

export const tabStore = createTabStore();
