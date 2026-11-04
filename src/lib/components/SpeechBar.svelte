<script lang="ts">
  import { t } from "$lib/i18n";
  import { speechProgress, speechState, seekSpeech, stopSpeech, toggleSpeech } from "$lib/tts/speech";

  /** Non-null while the user drags: the label follows the thumb, audio follows
   *  on release, so scrubbing does not restart the source on every pixel. */
  let dragging = $state<number | null>(null);

  let max = $derived(Math.max($speechProgress.total ?? $speechProgress.duration, 0.001));
  let value = $derived(Math.min(dragging ?? $speechProgress.position, max));
  let seekable = $derived($speechProgress.duration > 0);

  function handleInput(event: Event) {
    dragging = Number((event.currentTarget as HTMLInputElement).value);
  }

  function handleSeek(event: Event) {
    const time = Number((event.currentTarget as HTMLInputElement).value);
    dragging = null;
    seekSpeech(time);
  }

  function formatTime(seconds: number): string {
    const total = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
    const minutes = Math.floor(total / 60);
    return `${minutes}:${(total % 60).toString().padStart(2, "0")}`;
  }
</script>

{#if $speechState !== "idle"}
  <div class="speech-bar" role="region" aria-label={$t("speech.progressAria")}>
    <button
      class="bar-btn play"
      onclick={toggleSpeech}
      title={$speechState === "playing" ? $t("toolbar.pauseReading") : $t("toolbar.resumeReading")}
      aria-label={$speechState === "playing" ? $t("toolbar.pauseReading") : $t("toolbar.resumeReading")}
    >
      {#if $speechState === "playing"}
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
          <rect x="4" y="2.5" width="3" height="11" rx="0.8"/>
          <rect x="9" y="2.5" width="3" height="11" rx="0.8"/>
        </svg>
      {:else}
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
          <path d="M5 2.6a.6.6 0 0 1 .9-.5l7.6 5a.6.6 0 0 1 0 1l-7.6 5a.6.6 0 0 1-.9-.5z"/>
        </svg>
      {/if}
    </button>

    <span class="time now">{formatTime(value)}</span>

    <input
      class="bar-slider"
      type="range"
      min="0"
      max={max}
      step="0.1"
      value={value}
      disabled={!seekable}
      oninput={handleInput}
      onchange={handleSeek}
      title={$speechProgress.generation !== null ? $t("speech.seekHint") : $t("speech.progressAria")}
      aria-label={$t("speech.progressAria")}
    />

    <span class="time total">{formatTime(max)}</span>

    {#if $speechProgress.generation !== null}
      <span class="badge generating">{$t("speech.generating", { percent: $speechProgress.generation })}</span>
    {:else if $speechProgress.cached}
      <span class="badge cached">
        {$t("speech.cached")}{#if $speechProgress.bitrate}{$t("speech.bitrate", { bitrate: $speechProgress.bitrate })}{/if}
      </span>
    {/if}

    <button
      class="bar-btn close"
      onclick={stopSpeech}
      title={$t("toolbar.stopReading")}
      aria-label={$t("speech.closeAria")}
    >
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true">
        <line x1="3.5" y1="3.5" x2="12.5" y2="12.5"/>
        <line x1="12.5" y1="3.5" x2="3.5" y2="12.5"/>
      </svg>
    </button>
  </div>
{/if}

<style>
  .speech-bar {
    position: fixed;
    left: 50%;
    bottom: 18px;
    transform: translateX(-50%);
    z-index: 40;
    display: flex;
    align-items: center;
    gap: 10px;
    width: min(640px, calc(100vw - 32px));
    padding: 8px 12px;
    background: rgba(255, 255, 255, 0.94);
    backdrop-filter: blur(14px);
    -webkit-backdrop-filter: blur(14px);
    border: 1px solid #e5e5e5;
    border-radius: 12px;
    box-shadow: 0 8px 28px rgba(0, 0, 0, 0.12), 0 1px 3px rgba(0, 0, 0, 0.06);
  }

  :global(html.dark) .speech-bar {
    background: rgba(30, 30, 32, 0.94);
    border-color: #3a3a3c;
    box-shadow: 0 8px 28px rgba(0, 0, 0, 0.45);
  }

  .bar-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    flex-shrink: 0;
    border: none;
    border-radius: 7px;
    background: transparent;
    color: #1c1c1e;
    cursor: pointer;
  }

  :global(html.dark) .bar-btn {
    color: #e5e5e7;
  }

  .bar-btn:hover {
    background: #f2f2f7;
  }

  :global(html.dark) .bar-btn:hover {
    background: #2c2c2e;
  }

  .bar-btn.play {
    color: #0891b2;
  }

  :global(html.dark) .bar-btn.play {
    color: #22d3ee;
  }

  .bar-btn.close {
    color: #8e8e93;
  }

  .time {
    flex-shrink: 0;
    font-size: 11px;
    color: #5f6368;
    font-variant-numeric: tabular-nums;
    min-width: 34px;
  }

  .time.total {
    text-align: right;
    color: #aeaeb2;
  }

  :global(html.dark) .time {
    color: #aeaeb2;
  }

  .bar-slider {
    flex: 1;
    min-width: 0;
    accent-color: #0891b2;
    cursor: pointer;
  }

  .bar-slider:disabled {
    cursor: default;
    opacity: 0.5;
  }

  .badge {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 7px;
    border-radius: 999px;
    font-size: 10px;
    font-weight: 600;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }

  .badge.generating {
    color: #0891b2;
    background: #e5f5f8;
  }

  .badge.cached {
    color: #6b7280;
    background: #f2f2f7;
  }

  :global(html.dark) .badge.generating {
    color: #22d3ee;
    background: #0a1e2e;
  }

  :global(html.dark) .badge.cached {
    color: #aeaeb2;
    background: #2c2c2e;
  }

  @media print {
    .speech-bar {
      display: none !important;
    }
  }
</style>
