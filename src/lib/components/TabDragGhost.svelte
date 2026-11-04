<script lang="ts">
  import { tabDrag } from "$lib/stores/tab-drag";
  import { tabStore } from "$lib/stores/tabs";
  import { settings } from "$lib/stores/settings";
  import { t } from "$lib/i18n";
  import { stripVerbatimPrefix, tabFolderLabel, tabsNeedingFolder } from "$lib/utils/path";

  const { tabs } = tabStore;

  let drag = $derived($tabDrag);
  let tab = $derived(drag ? $tabs.find((t) => t.id === drag!.tabId) ?? null : null);
  // The side panel stacks a folder line under the name when two tabs share a
  // file name; the ghost keeps that shape while it is over the panel.
  let side = $derived(!!drag && drag.sourcePane === "left" && $settings.tabsPosition === "side");
  let withFolder = $derived(tabsNeedingFolder($tabs));
  let settling = $derived(drag?.phase === "landing" || drag?.phase === "returning");
</script>

{#if drag && tab}
  <div
    class="drag-ghost"
    class:settling
    style:width="{drag.width}px"
    style:height="{drag.height}px"
    style:transform="translate3d({drag.x}px, {drag.y}px, 0)"
    title={side ? stripVerbatimPrefix(tab.filePath) : undefined}
  >
    <div class="ghost-body" class:side>
      <span class="ghost-label">
        {#if tab.diskChanged}<span class="ghost-disk">⟳</span>{:else if tab.dirty}<span class="ghost-dirty">•</span>{/if}{tab.fileName}
      </span>
      {#if side && withFolder.has(tab.id)}
        <span class="ghost-folder">{tabFolderLabel(tab.filePath, $t)}</span>
      {/if}
    </div>
  </div>
{/if}

<style>
  /* Painted once, above both tab rows. The outer element carries the viewport
     position; the inner one carries the lift, so the two transitions never
     fight over `transform`. */
  .drag-ghost {
    position: fixed;
    top: 0;
    left: 0;
    z-index: 80;
    pointer-events: none;
    opacity: 0.92;
    will-change: transform, width, height;
  }

  .drag-ghost.settling {
    transition:
      transform 185ms cubic-bezier(0.2, 0.8, 0.2, 1),
      width 185ms cubic-bezier(0.2, 0.8, 0.2, 1),
      height 185ms cubic-bezier(0.2, 0.8, 0.2, 1),
      opacity 120ms ease;
    opacity: 1;
  }

  .ghost-body {
    display: flex;
    align-items: center;
    width: 100%;
    height: 100%;
    box-sizing: border-box;
    padding: 7px 14px;
    border-radius: 8px;
    background: #fafafa;
    color: #1c1c1e;
    font-size: 12px;
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    box-shadow:
      0 10px 24px rgba(0, 0, 0, 0.18),
      0 2px 6px rgba(0, 0, 0, 0.12);
    transform: scale(1.025);
    transform-origin: center;
    transition: transform 140ms ease;
  }

  .settling .ghost-body {
    transform: scale(1);
  }

  .ghost-body.side {
    flex-direction: column;
    align-items: stretch;
    justify-content: center;
    gap: 1px;
    padding: 6px 10px;
  }

  .ghost-label {
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .ghost-folder {
    font-size: 11px;
    font-weight: 400;
    color: #8e8e93;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .ghost-dirty {
    color: #0891b2;
    font-weight: 700;
    margin-right: 4px;
  }

  .ghost-disk {
    color: #d97706;
    margin-right: 4px;
    font-size: 0.9em;
  }

  :global(html.dark) .ghost-body {
    background: #1e1e20;
    color: #e5e5e7;
    box-shadow:
      0 10px 24px rgba(0, 0, 0, 0.45),
      0 2px 6px rgba(0, 0, 0, 0.3);
  }

  :global(html.dark) .ghost-folder {
    color: #6e6e73;
  }

  :global(html.dark) .ghost-dirty {
    color: #22d3ee;
  }

  @media (prefers-reduced-motion: reduce) {
    .drag-ghost,
    .ghost-body {
      transition: none;
    }

    .ghost-body {
      transform: none;
    }
  }
</style>
