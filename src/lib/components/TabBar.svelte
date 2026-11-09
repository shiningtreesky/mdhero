<script lang="ts">
  import { onDestroy, onMount, tick } from "svelte";
  import { flip } from "svelte/animate";
  import { cubicOut } from "svelte/easing";
  import { derived, get } from "svelte/store";
  import { PanelLeft, PanelTop } from "@lucide/svelte";
  import { tabStore, HOME_TAB_ID, type Tab } from "$lib/stores/tabs";
  import type { PaneId } from "$lib/stores/panes";
  import { tabDrag, type DragRect, type TabDragTarget } from "$lib/stores/tab-drag";
  import {
    settings,
    clampTabsWidth,
    maxTabsWidthFor,
    DEFAULT_TABS_WIDTH,
    MIN_TABS_WIDTH,
  } from "$lib/stores/settings";
  import { tocVisible, tocEntries } from "$lib/stores/toc";
  import { newDocument, revealInFileManager } from "$lib/tauri/files";
  import { copyFileName, copyPath } from "$lib/utils/clipboard";
  import { createDelayedCall } from "$lib/utils/delayed-call";
  import { stripVerbatimPrefix, tabFolderLabel, tabsNeedingFolder } from "$lib/utils/path";
  import { clipRowsToSeam, resolveDrop } from "$lib/utils/tab-drag";
  import PanelResizer from "./PanelResizer.svelte";
  import { translate, t } from "$lib/i18n";

  let {
    onCloseTab = (id: string) => tabStore.closeTab(id),
    pane = "left",
    focused = false,
  }: {
    onCloseTab?: (id: string) => void;
    /** The column this row belongs to: each column has its own tab row. */
    pane?: PaneId;
    /** Whether the keyboard, search, ToC and status bar act on this column.
     *  Only the focused column shows its tab as active. */
    focused?: boolean;
  } = $props();

  const { tabs, activeTabId } = tabStore;
  /** This column's tabs, in row order. The drag indexes below are row-local. */
  let rowTabs = $derived($tabs.filter((t) => t.pane === pane));

  // The ghost follows the pointer on every mousemove, but the rows only change
  // when the tab or its target slot changes. Keeping those separate stops the
  // flip animations from being aborted by pointer-only updates.
  const draggedTabId = derived(tabDrag, (drag) => drag?.tabId ?? null);
  const draggedTarget = derived(tabDrag, (drag) => drag?.target ?? null);

  interface RowEntry {
    key: string;
    tab: Tab | null;
    /** Position in `rowTabs`, so a drop knows where the tab came from. */
    index: number;
  }

  /** The row as it should look mid-drag: the dragged tab is lifted out and a
   *  gap is left at the slot the pointer is over. When the drag moves on, the
   *  keyed each block animates the remaining tabs into their new places. */
  let rowEntries = $derived.by(() => {
    const tabId = $draggedTabId;
    const target = $draggedTarget;
    const base: RowEntry[] = rowTabs.map((tab, index) => ({ key: tab.id, tab, index }));
    if (!tabId) return base;
    const visible = base.filter((entry) => entry.tab?.id !== tabId);
    if (target?.pane !== pane) return visible;
    const at = Math.max(0, Math.min(target.index, visible.length));
    return [
      ...visible.slice(0, at),
      { key: "__tab_drag_gap__", tab: null, index: -1 },
      ...visible.slice(at),
    ];
  });

  const DRAG_THRESHOLD = 4;
  const LAND_MS = 185;
  const RETURN_MS = 185;

  let reduceMotion = $state(false);
  let suppressClickUntil = 0;
  /** Cleanup for the drag currently owned by this row, if any. */
  let cleanupDrag: (() => void) | null = null;

  onMount(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    reduceMotion = media.matches;
    const onChange = () => (reduceMotion = media.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  });

  onDestroy(() => {
    cleanupDrag?.();
    if (get(tabDrag)?.sourcePane === pane) clearDragState();
  });

  function motionMs(ms: number): number {
    return reduceMotion ? 0 : ms;
  }

  /** Walks the live rows so a pointer maps to a column and an insertion slot.
   *  The dragged tab is left out: an index is a slot in the tabs still there. */
  function targetUnderPointer(x: number, y: number, tabId: string): TabDragTarget | null {
    const rows = Array.from(document.querySelectorAll<HTMLElement>(".tabbar-files")).map((row) => {
      const orientation: "horizontal" | "vertical" =
        row.dataset.orientation === "vertical" ? "vertical" : "horizontal";
      // The side panel is taller than its tab list; the empty part under the
      // last tab is still a drop area, so measure the panel for that layout.
      // A top row must measure the whole strip instead: `.tabbar-files` only
      // spans its tabs and collapses to a ~16px by 0px sliver in an empty
      // column, which used to make that column impossible to drop into.
      const panel = row.closest<HTMLElement>(".tabbar.side");
      const bar = row.closest<HTMLElement>(".tabbar") ?? row;
      const rect = (panel ?? bar).getBoundingClientRect();
      const childEnds = Array.from(row.querySelectorAll<HTMLElement>("[data-tab-id]"))
        .filter((child) => child.dataset.tabId !== tabId)
        .map((child) => {
          const box = child.getBoundingClientRect();
          return orientation === "vertical" ? box.bottom : box.right;
        });
      return {
        pane: (row.dataset.pane as PaneId) || pane,
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        orientation,
        childEnds,
      };
    });
    // The left strip's box still spans the window; cut it where the pinned
    // right column starts so it cannot steal drops aimed at the right row.
    const rightBar = document.querySelector<HTMLElement>(".tabbar.pane-right");
    const seam = rightBar ? rightBar.getBoundingClientRect().left : null;
    return resolveDrop(clipRowsToSeam(rows, seam), x, y);
  }

  function gapRect(target: TabDragTarget): DragRect | null {
    const gap = document.querySelector<HTMLElement>(
      `.tabbar-files[data-pane="${target.pane}"] [data-drag-gap]`
    );
    if (!gap) return null;
    const box = gap.getBoundingClientRect();
    return { left: box.left, top: box.top, width: box.width, height: box.height };
  }

  function clearDragState() {
    tabDrag.set(null);
    (window as any).__mdhero_tab_dragging = false;
    document.body.classList.remove("tab-dragging");
  }

  function handleTabClick(tab: Tab) {
    // The mouseup that ends a drag can still produce a click. The tab is not
    // being chosen then: the drop is still landing (or returning).
    if (get(tabDrag) || Date.now() < suppressClickUntil) return;
    tabStore.switchTab(tab.id);
  }

  function gapStyle(): string {
    const drag = $tabDrag;
    if (!drag) return "";
    return side
      ? `height: ${drag.height}px; width: 100%;`
      : `width: ${drag.width}px; height: ${drag.height}px;`;
  }

  let contextMenuTab = $state<Tab | null>(null);
  let contextMenuPos = $state({ x: 0, y: 0 });
  let contextMenuEl = $state<HTMLElement | null>(null);
  // Result of the last copy (or failed reveal), shown in place of the label of
  // the entry clicked.
  let copyFeedback = $state<{ item: "path" | "name" | "reveal"; text: string } | null>(null);

  // Tabs in a row across the top, or in a resizable panel on the left. The side
  // panel is the primary column's arrangement; the second column always keeps
  // its own row of tabs.
  let side = $derived($settings.tabsPosition === "side" && pane === "left");
  // Side tabs whose folder goes under their name, to tell same-named files apart.
  let withFolder = $derived(tabsNeedingFolder($tabs));

  function toggleTabsPosition() {
    settings.update((s) => ({ ...s, tabsPosition: s.tabsPosition === "side" ? "top" : "side" }));
  }

  /** The width the side panel shares with the document: the window, less the
   *  table of contents when it is showing. */
  function availableWidth(): number {
    const toc = get(tocVisible) && get(tocEntries).length > 0 ? get(settings).tocWidth : 0;
    return window.innerWidth - toc;
  }

  function handleClose(e: MouseEvent, id: string) {
    e.stopPropagation();
    onCloseTab(id);
  }

  // Middle-click anywhere on a tab closes it, matching browsers/VS Code (#46).
  // Only clean tabs: a dirty tab needs the unsaved-changes dialog, and opening
  // that native modal from an auxclick handler wedges it in WKWebView (the modal
  // becomes unresponsive). So middle-click skips dirty tabs — the X button (a
  // plain click) still closes them with the prompt.
  function handleAuxClick(e: MouseEvent, id: string) {
    if (e.button !== 1) return;
    e.preventDefault();
    if ($tabs.find((t) => t.id === id)?.dirty) return;
    onCloseTab(id);
  }

  function handleMouseDown(e: MouseEvent, tab: Tab, index: number) {
    // Suppress the middle-button default (autoscroll) so the tab close on
    // auxclick fires cleanly on the first click (#46) — but don't close here;
    // closing on mousedown mis-fires as the row re-renders. Don't start a drag.
    if (e.button === 1) {
      e.preventDefault();
      return;
    }
    // Only the left button starts a drag.
    if (e.button !== 0) return;
    const clicked = e.target as HTMLElement;
    if (clicked.closest(".tab-close") || clicked.closest(".dropdown")) return;

    const tabEl = e.currentTarget as HTMLElement;
    const startRect = tabEl.getBoundingClientRect();
    const startX = e.clientX;
    const startY = e.clientY;
    const offsetX = e.clientX - startRect.left;
    const offsetY = e.clientY - startRect.top;
    e.preventDefault();

    let active = false;
    let finished = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
      window.removeEventListener("keydown", handleKeyDown, true);
      if (timer) clearTimeout(timer);
      if (cleanupDrag === cleanup) cleanupDrag = null;
      if (active) clearDragState();
    };

    function beginDrag(clientX: number, clientY: number) {
      active = true;
      document.body.classList.add("tab-dragging");
      (window as any).__mdhero_tab_dragging = true;
      tabDrag.set({
        tabId: tab.id,
        sourcePane: pane,
        sourceIndex: index,
        sourceRect: {
          left: startRect.left,
          top: startRect.top,
          width: startRect.width,
          height: startRect.height,
        },
        x: clientX - offsetX,
        y: clientY - offsetY,
        width: startRect.width,
        height: startRect.height,
        target: targetUnderPointer(clientX, clientY, tab.id),
        phase: "dragging",
      });
    }

    function handleMouseMove(ev: MouseEvent) {
      if (finished) return;
      if (!active) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < DRAG_THRESHOLD) return;
        beginDrag(ev.clientX, ev.clientY);
        return;
      }
      const target = targetUnderPointer(ev.clientX, ev.clientY, tab.id);
      tabDrag.update((drag) => {
        if (!drag || drag.phase !== "dragging") return drag;
        const sameTarget = drag.target?.pane === target?.pane && drag.target?.index === target?.index;
        return {
          ...drag,
          x: ev.clientX - offsetX,
          y: ev.clientY - offsetY,
          target: sameTarget ? drag.target : target,
        };
      });
    }

    function flyBack() {
      const drag = get(tabDrag);
      if (!drag) {
        cleanup();
        return;
      }
      tabDrag.set({
        ...drag,
        phase: "returning",
        target: { pane: drag.sourcePane, index: drag.sourceIndex },
        x: drag.sourceRect.left,
        y: drag.sourceRect.top,
        width: drag.sourceRect.width,
        height: drag.sourceRect.height,
      });
      timer = setTimeout(cleanup, motionMs(RETURN_MS));
    }

    async function handleMouseUp() {
      if (finished) return;
      if (!active) {
        finished = true;
        cleanup();
        return;
      }
      finished = true;
      const drag = get(tabDrag);
      const target = drag?.target ?? null;
      if (!drag || !target) {
        flyBack();
        return;
      }
      // The last mousemove may not have painted yet; measure the gap after it.
      await tick();
      const gap = gapRect(target);
      if (!gap) {
        flyBack();
        return;
      }
      suppressClickUntil = Date.now() + 120;
      tabDrag.set({
        ...drag,
        phase: "landing",
        x: gap.left,
        y: gap.top,
        width: gap.width,
        height: gap.height,
      });
      timer = setTimeout(() => {
        if (target.pane === pane) {
          tabStore.reorderTabs(pane, index, target.index);
        } else {
          tabStore.moveTabToPane(tab.id, target.pane, target.index);
        }
        cleanup();
      }, motionMs(LAND_MS));
    }

    function handleKeyDown(ev: KeyboardEvent) {
      if (ev.key !== "Escape" || finished) return;
      ev.preventDefault();
      ev.stopPropagation();
      finished = true;
      if (!active) {
        cleanup();
        return;
      }
      flyBack();
    }

    cleanupDrag = cleanup;
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    window.addEventListener("keydown", handleKeyDown, true);
  }

  function handleNewTab() {
    newDocument();
  }

  // A tab backed by a real file has a canonical absolute path to copy; paste://,
  // url://, and not-yet-saved new:// tabs don't.
  function isFileTab(tab: Tab): boolean {
    return !!tab.filePath
      && !tab.filePath.startsWith("paste://")
      && !tab.filePath.startsWith("url://")
      && !tab.filePath.startsWith("new://");
  }

  // Every document tab gets the menu, since any of them can be closed and the
  // tabs can be moved from any of them; the copy entries only show for tabs
  // backed by a file.
  async function handleContextMenu(e: MouseEvent, tab: Tab) {
    e.preventDefault();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const menuWidth = 160;
    const maxX = window.innerWidth - menuWidth - 8;
    // Beside a side tab rather than under it, where the menu would cover the
    // next tab down.
    contextMenuPos = side
      ? { x: Math.min(rect.right + 4, maxX), y: rect.top }
      : { x: Math.min(rect.left, maxX), y: rect.bottom + 4 };
    contextMenuTab = tab;
    copyFeedback = null;
    // The previous menu may still be showing its feedback: its close must not
    // shut this one.
    closeAfterFeedback.cancel();
    // Beside a side tab near the bottom of the window, the menu would run past
    // the bottom edge, and a translated menu wider than 160px can run past the
    // right edge: move it back inside.
    await tick();
    if (!contextMenuEl) return;
    const box = contextMenuEl.getBoundingClientRect();
    const overflowX = box.right - (window.innerWidth - 8);
    const overflowY = box.bottom - (window.innerHeight - 8);
    if (overflowX > 0 || overflowY > 0) {
      contextMenuPos = {
        x: Math.max(8, contextMenuPos.x - Math.max(0, overflowX)),
        y: Math.max(8, contextMenuPos.y - Math.max(0, overflowY)),
      };
    }
  }

  function closeContextMenu() {
    contextMenuTab = null;
    copyFeedback = null;
  }

  // Leaves the feedback up long enough to read before the menu closes.
  const closeAfterFeedback = createDelayedCall(closeContextMenu, 900);

  async function handleCopy(item: "path" | "name") {
    if (!contextMenuTab) return;
    const copy = item === "path" ? copyPath : copyFileName;
    const success = await copy(contextMenuTab.filePath);
    copyFeedback = { item, text: success ? translate("common.copied") : translate("common.copyFailed") };
    closeAfterFeedback.schedule();
  }

  // On success the file manager window is the feedback, so the menu just
  // closes. It fails when the file was moved or deleted since it was opened.
  async function handleReveal() {
    if (!contextMenuTab) return;
    try {
      await revealInFileManager(contextMenuTab.filePath);
      closeContextMenu();
    } catch (err) {
      console.error("revealItemInDir failed:", err);
      copyFeedback = { item: "reveal", text: translate("tabbar.openFileLocationFailed") };
      closeAfterFeedback.schedule();
    }
  }

  // Escape dismisses the menu and nothing else. The page's own Escape handler
  // listens on window too, but in the bubble phase, so without this it would
  // also close the active tab (close-on-Escape setting).
  function handleMenuKeydown(e: KeyboardEvent) {
    if (e.key !== "Escape" || !contextMenuTab) return;
    e.preventDefault();
    e.stopPropagation();
    closeContextMenu();
  }

  function handleCloseFromMenu() {
    if (!contextMenuTab) return;
    const id = contextMenuTab.id;
    closeContextMenu();
    onCloseTab(id);
  }

  function handleTogglePositionFromMenu() {
    closeContextMenu();
    toggleTabsPosition();
  }
</script>

<svelte:window onkeydowncapture={handleMenuKeydown} />

{#snippet tabName(tab: Tab)}
  {#if tab.diskChanged}<span class="tab-disk" title={$t('tabbar.diskChanged')}>⟳</span>{:else if tab.dirty}<span class="tab-dirty" title={$t('tabbar.unsaved')}>•</span>{/if}{tab.fileName}
{/snippet}

<div class="tabbar" class:side class:pane-left={pane === "left"} class:pane-right={pane === "right"}>
  <div class="tabbar-inner">
    <!-- Home tab: only the left column can go back to the recents screen. -->
    {#if pane === "left"}
    <div
      class="tab home-tab"
      class:active={focused && $activeTabId === HOME_TAB_ID}
      onclick={() => tabStore.goHome()}
      role="button"
      tabindex="0"
      onkeydown={(e) => e.key === 'Enter' && tabStore.goHome()}
    >
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">
        <path d="M2 6.5L7 2l5 4.5V12H9V9H5v3H2V6.5z"/>
      </svg>
      {#if side}<span class="tab-label">{$t('tabbar.home')}</span>{/if}
    </div>
    {/if}

    <!-- File tabs -->
    <div class="tabbar-files" data-pane={pane} data-orientation={side ? "vertical" : "horizontal"}>
      {#if pane === "right" && rowTabs.length === 0 && $tabDrag?.target?.pane !== pane}
        <!-- A tab can be dropped anywhere in an empty row, so say so. -->
        <span class="tab-empty">{$t('tabbar.dropHere')}</span>
      {/if}
      {#each rowEntries as entry (entry.key)}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
          animate:flip={{ duration: reduceMotion ? 0 : 170, easing: cubicOut }}
          onmousedown={(e) => entry.tab && handleMouseDown(e, entry.tab, entry.index)}
          onauxclick={(e) => entry.tab && handleAuxClick(e, entry.tab.id)}
          onclick={() => entry.tab && handleTabClick(entry.tab)}
          oncontextmenu={(e) => entry.tab && handleContextMenu(e, entry.tab)}
          class="tab"
          class:active={!!entry.tab && focused && $activeTabId === entry.tab.id}
          class:tab-drag-gap={!entry.tab}
          data-tab-id={entry.tab?.id}
          data-drag-gap={entry.tab ? undefined : "true"}
          aria-hidden={entry.tab ? undefined : "true"}
          style={entry.tab ? undefined : gapStyle()}
          title={entry.tab && side && isFileTab(entry.tab) ? stripVerbatimPrefix(entry.tab.filePath) : undefined}
        >
          {#if entry.tab}
            {@const tab = entry.tab}
            {#if side && withFolder.has(tab.id)}
              <span class="tab-text">
                <span class="tab-label">{@render tabName(tab)}</span>
                <span class="tab-folder">{tabFolderLabel(tab.filePath, $t)}</span>
              </span>
            {:else}
              <span class="tab-label">{@render tabName(tab)}</span>
            {/if}
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <span
              role="button"
              tabindex="-1"
              onclick={(e) => handleClose(e, tab.id)}
              onkeydown={() => {}}
              class="tab-close"
            >
              <svg width="9" height="9" viewBox="0 0 9 9" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"><line x1="1.5" y1="1.5" x2="7.5" y2="7.5"/><line x1="7.5" y1="1.5" x2="1.5" y2="7.5"/></svg>
            </span>
          {/if}
        </div>
      {/each}
      <!-- Absorbs a drop past the last tab, and gives an empty row a target wide
           enough to hit without aiming at a pixel. -->
      <span class="tabbar-drop" aria-hidden="true"></span>
    </div>

    <!-- New tab button: the columns share one document set, so the controls
         that act on the app live in the left row only. -->
    {#if pane === "left"}
    <button class="new-tab-btn" onclick={handleNewTab} title={$t('tabbar.newTab')}>
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
        <line x1="6" y1="2" x2="6" y2="10"/>
        <line x1="2" y1="6" x2="10" y2="6"/>
      </svg>
      {#if side}<span>{$t('tabbar.newTab')}</span>{/if}
    </button>
    <button
      class="layout-btn"
      onclick={toggleTabsPosition}
      title={side ? $t('tabbar.showTabsTopTitle') : $t('tabbar.showTabsSideTitle')}
      aria-label={side ? $t('tabbar.showTabsTopTitle') : $t('tabbar.showTabsSideTitle')}
    >
      {#if side}<PanelTop size={14} />{:else}<PanelLeft size={14} />{/if}
    </button>
    {/if}
  </div>
</div>
{#if side}
  <!-- z-index 15 like the panel itself. `--tabs-w` is owned by +page.svelte,
       which re-publishes it whenever the stored value changes. -->
  <PanelResizer
    width={$settings.tabsWidth}
    min={MIN_TABS_WIDTH}
    defaultWidth={DEFAULT_TABS_WIDTH}
    clampWidth={(value) => clampTabsWidth(value, availableWidth())}
    maxWidth={() => maxTabsWidthFor(availableWidth())}
    cssVar="--tabs-w"
    resizingClass="tabs-resizing"
    label={$t('tabbar.resize')}
    left="calc(var(--tabs-w, 220px) - 3px)"
    top="var(--chrome-top, 44px)"
    zIndex={15}
    onCommit={(width) => settings.update((s) => ({ ...s, tabsWidth: width }))}
  />
{/if}

{#if contextMenuTab}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="fixed inset-0 z-[9]" onclick={closeContextMenu} onkeydown={() => {}}></div>
  <div bind:this={contextMenuEl} class="dropdown" style="left: {contextMenuPos.x}px; top: {contextMenuPos.y}px;">
    {#if isFileTab(contextMenuTab)}
      <button onclick={() => handleCopy("name")} class="dropdown-item">
        <span>{copyFeedback?.item === "name" ? copyFeedback.text : $t('tabbar.copyFileName')}</span>
      </button>
      <button onclick={() => handleCopy("path")} class="dropdown-item">
        <span>{copyFeedback?.item === "path" ? copyFeedback.text : $t('tabbar.copyPath')}</span>
      </button>
      <button onclick={handleReveal} class="dropdown-item">
        <span>{copyFeedback?.item === "reveal" ? copyFeedback.text : $t('tabbar.openFileLocation')}</span>
      </button>
      <div class="dropdown-separator"></div>
    {/if}
    <button onclick={handleCloseFromMenu} class="dropdown-item">
      <span>{$t('menu.closeTab')}</span>
    </button>
    <div class="dropdown-separator"></div>
    <button onclick={handleTogglePositionFromMenu} class="dropdown-item">
      <span>{side ? $t('tabbar.showTabsTop') : $t('tabbar.showTabsSide')}</span>
    </button>
  </div>
{/if}

<style>
  /* Sticks right under the 44px toolbar (see utils/layout.ts). */
  .tabbar {
    position: sticky;
    top: 44px;
    z-index: 15;
    background: #dee1e6;
    padding: 6px 8px 0;
    overflow-x: auto;
  }

  :global(html.dark) .tabbar {
    background: #111113;
  }

  /* Each column has its own tab row. The left row is in flow (sticky above its
     document); the right row is pinned over its own column, whose width the
     `--side-w` variable published by +page.svelte measures. */
  .tabbar.pane-right {
    position: fixed;
    top: 44px;
    left: calc(100% - var(--side-w, 0px));
    right: 0;
  }

  .tabbar.pane-left {
    padding-right: calc(var(--side-w, 0px) + 8px);
  }

  .tab-empty {
    font-size: 12px;
    color: #8e8e93;
    padding: 4px 8px;
  }

  /* The slack inside a row that still counts as "drop into this row". */
  .tabbar-drop {
    flex: 1 1 auto;
    min-width: 16px;
  }

  .pane-right .tabbar-files {
    flex: 1 1 auto;
  }

  .tabbar::-webkit-scrollbar {
    height: 0;
  }

  .tabbar-inner {
    display: flex;
    align-items: flex-end;
    gap: 2px;
  }

  .tabbar-files {
    display: flex;
    align-items: flex-end;
    gap: 2px;
  }

  .tab {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 7px 14px;
    font-size: 12px;
    color: #5f6368;
    background: transparent;
    border: none;
    border-radius: 8px 8px 0 0;
    cursor: pointer;
    white-space: nowrap;
    max-width: 200px;
    min-width: 80px;
    transition: background 0.12s, color 0.12s;
    position: relative;
    user-select: none;
  }

  .tab:hover {
    background: rgba(255, 255, 255, 0.5);
  }

  :global(html.dark) .tab {
    color: #8e8e93;
  }

  :global(html.dark) .tab:hover {
    background: rgba(255, 255, 255, 0.05);
  }

  .tab.active {
    background: #fafafa;
    color: #1c1c1e;
    font-weight: 600;
    box-shadow: 0 -1px 3px rgba(0,0,0,0.06);
    border-bottom: 2px solid #0891B2;
  }

  :global(html.dark) .tab.active {
    background: #1e1e20;
    color: #e5e5e7;
    font-weight: 600;
    box-shadow: 0 -1px 3px rgba(0,0,0,0.2);
    border-bottom: 2px solid #22D3EE;
  }

  /* The slot the dragged tab will land in. The tabs around it move with the
     flip animation on the keyed each block, so the row visibly makes room. */
  .tab.tab-drag-gap {
    padding: 0;
    min-width: 0;
    max-width: none;
    flex: 0 0 auto;
    box-sizing: border-box;
    border: 1.5px dashed #0891B2;
    border-radius: 8px 8px 0 0;
    background: rgba(8, 145, 178, 0.08);
    box-shadow: inset 0 0 0 1px rgba(8, 145, 178, 0.05);
    pointer-events: none;
  }

  :global(html.dark) .tab.tab-drag-gap {
    border-color: #22D3EE;
    background: rgba(34, 211, 238, 0.1);
    box-shadow: inset 0 0 0 1px rgba(34, 211, 238, 0.06);
  }

  /* While a tab is lifted the whole window shows the grab cursor, including
     over the other column's row and the documents between them. */
  :global(body.tab-dragging),
  :global(body.tab-dragging *) {
    cursor: grabbing !important;
    user-select: none !important;
  }

  /* Home tab */
  .home-tab {
    min-width: auto;
    padding: 7px 10px;
    flex-shrink: 0;
  }

  .home-tab svg {
    flex-shrink: 0;
  }

  .tab-label {
    overflow: hidden;
    text-overflow: ellipsis;
    flex: 1;
    text-align: left;
  }

  .tab-disk {
    color: #d97706;
    margin-right: 4px;
    font-size: 0.9em;
  }

  .tab-dirty {
    color: #0891B2;
    font-weight: 700;
    margin-right: 4px;
  }

  :global(html.dark) .tab-dirty {
    color: #22D3EE;
  }

  .tab-close {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    border-radius: 50%;
    color: #999;
    opacity: 0;
    transition: opacity 0.12s, background 0.12s, color 0.12s;
    flex-shrink: 0;
  }

  .tab:hover .tab-close {
    opacity: 1;
  }

  .tab-close:hover {
    background: rgba(0, 0, 0, 0.08);
    color: #333;
  }

  :global(html.dark) .tab-close:hover {
    background: rgba(255, 255, 255, 0.1);
    color: #e5e5e7;
  }

  /* New tab button */
  .new-tab-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    margin-left: 2px;
    margin-bottom: 2px;
    background: none;
    border: none;
    border-radius: 6px;
    color: #8e8e93;
    cursor: pointer;
    flex-shrink: 0;
    transition: background 0.12s, color 0.12s;
  }

  .new-tab-btn:hover {
    background: rgba(255, 255, 255, 0.5);
    color: #0891B2;
  }

  :global(html.dark) .new-tab-btn:hover {
    background: rgba(255, 255, 255, 0.08);
    color: #22D3EE;
  }

  /* Moves the tabs between the top row and the side panel. At the far end of
     the row; in the panel, on a header line of its own above Home. */
  .layout-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    margin-left: auto;
    margin-bottom: 2px;
    background: none;
    border: none;
    border-radius: 6px;
    color: #8e8e93;
    cursor: pointer;
    flex-shrink: 0;
    transition: background 0.12s, color 0.12s;
  }

  .layout-btn:hover {
    background: rgba(255, 255, 255, 0.5);
    color: #0891B2;
  }

  :global(html.dark) .layout-btn:hover {
    background: rgba(255, 255, 255, 0.08);
    color: #22D3EE;
  }

  /* Side tabs: a fixed panel under the toolbar, as wide as `--tabs-w`. */
  .tabbar.side {
    position: fixed;
    top: var(--chrome-top, 44px);
    left: 0;
    bottom: 0;
    width: var(--tabs-w, 220px);
    padding: 4px 6px 12px;
    overflow-x: hidden;
    overflow-y: auto;
    border-right: 1px solid #d2d5da;
  }

  :global(html.dark) .tabbar.side {
    border-right-color: #2c2c2e;
  }

  .tabbar.side .tabbar-inner,
  .tabbar.side .tabbar-files {
    flex-direction: column;
    align-items: stretch;
  }

  .tabbar.side .layout-btn {
    order: -1;
    align-self: flex-end;
    margin: 0 0 2px;
  }

  .tabbar.side .tab {
    max-width: none;
    min-width: 0;
    padding: 6px 6px 6px 10px;
    border-radius: 8px;
  }

  .tabbar.side .home-tab {
    padding: 7px 10px;
    margin-bottom: 4px;
  }

  /* The accent moves from under the tab to its leading edge. */
  .tabbar.side .tab.active {
    border-bottom: none;
    box-shadow: inset 3px 0 0 #0891B2, 0 1px 3px rgba(0,0,0,0.06);
  }

  :global(html.dark) .tabbar.side .tab.active {
    box-shadow: inset 3px 0 0 #22D3EE, 0 1px 3px rgba(0,0,0,0.2);
  }

  .tabbar.side .tab.tab-drag-gap {
    width: 100%;
    border-radius: 8px;
  }

  .tab-text {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-width: 0;
  }

  .tab-folder {
    font-size: 11px;
    font-weight: 400;
    color: #8e8e93;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  :global(html.dark) .tab-folder {
    color: #6e6e73;
  }

  .tabbar.side .new-tab-btn {
    width: auto;
    justify-content: flex-start;
    gap: 8px;
    margin: 4px 0 0;
    padding: 0 10px;
    font-size: 12px;
  }

  .dropdown {
    position: fixed;
    /* As wide as the longest entry, so translated labels stay on one line. */
    min-width: 160px;
    width: max-content;
    background: white;
    border: 1px solid #e5e5e5;
    border-radius: 8px;
    box-shadow: 0 4px 20px rgba(0,0,0,0.08), 0 1px 3px rgba(0,0,0,0.06);
    z-index: 50;
    padding: 4px;
    overflow: hidden;
  }

  :global(html.dark) .dropdown {
    background: #2c2c2e;
    border-color: #3a3a3c;
    box-shadow: 0 4px 20px rgba(0,0,0,0.3);
  }

  .dropdown-item {
    display: flex;
    align-items: center;
    width: 100%;
    padding: 7px 10px;
    font-size: 12px;
    color: #1c1c1e;
    background: none;
    border: none;
    border-radius: 5px;
    cursor: pointer;
    text-align: left;
  }

  :global(html.dark) .dropdown-item {
    color: #e5e5e7;
  }

  .dropdown-item:hover {
    background: #f2f2f7;
  }

  :global(html.dark) .dropdown-item:hover {
    background: #3a3a3c;
  }

  .dropdown-separator {
    height: 1px;
    margin: 4px 6px;
    background: #e5e5e5;
  }

  :global(html.dark) .dropdown-separator {
    background: #3a3a3c;
  }

  @media print {
    .tabbar { display: none !important; }
  }
</style>
