<script lang="ts">
  import { X } from "@lucide/svelte";
  import { t } from "$lib/i18n";
  import type { MessageKey } from "$lib/i18n";
  import type { ScoreRow } from "$lib/utils/parasScore";

  const TYPE_LABEL: Record<ScoreRow["type"], MessageKey> = {
    heading: "score.type.heading",
    paragraph: "score.type.paragraph",
    list: "score.type.list",
    quote: "score.type.quote",
    cell: "score.type.cell",
  };

  let {
    visible = $bindable(false),
    loading = false,
    rows = [] as ScoreRow[],
    error = "",
    raw = "",
    degraded = false,
    translated = 0,
    total = 0,
    skipped = 0,
  }: {
    visible?: boolean;
    loading?: boolean;
    rows?: ScoreRow[];
    error?: string;
    raw?: string;
    degraded?: boolean;
    translated?: number;
    total?: number;
    skipped?: number;
  } = $props();

  function handleBackdropClick(e: MouseEvent) {
    if (e.target === e.currentTarget) visible = false;
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.stopPropagation();
      visible = false;
    }
  }

  function scoreClass(row: ScoreRow): string {
    if (row.score === null) return "score-badge muted";
    if (row.score >= 85) return "score-badge good";
    if (row.score >= 60) return "score-badge ok";
    return "score-badge low";
  }
</script>

{#if visible}
  <div
    class="panel-backdrop"
    role="presentation"
    onclick={handleBackdropClick}
    onkeydown={handleKeydown}
  >
    <div class="panel" role="dialog" aria-modal="true" aria-labelledby="score-panel-title">
      <div class="panel-header">
        <div class="panel-heading">
          <h2 id="score-panel-title" class="panel-title">{$t('score.title')}</h2>
          <p class="panel-stats">{$t('score.progress', { translated, total, skipped })}</p>
        </div>
        <button onclick={() => (visible = false)} class="panel-close" aria-label={$t('common.close')}>
          <X size={16} />
        </button>
      </div>

      <div class="panel-body">
        {#if loading}
          <div class="panel-status">
            <span class="spinner" aria-hidden="true"></span>
            {$t('score.submitting')}
          </div>
        {/if}

        {#if error}
          <p class="panel-error" role="alert">{error}</p>
        {/if}

        {#if degraded}
          <p class="panel-warn">{$t('score.degraded')}</p>
        {/if}

        {#each rows as row (row.index)}
          <section class="block">
            <div class="block-head">
              <div class="block-title">
                <span class="block-index">{$t('score.paragraph', { n: row.index + 1 })}</span>
                <span class="tag tag-type">{$t(TYPE_LABEL[row.type])}</span>
              </div>
              {#if row.status === "skipped"}
                <span class="tag tag-skipped">{$t('score.skipped')}</span>
              {:else if row.answered}
                <span class={scoreClass(row)}>
                  {row.score === null ? $t('score.noScore') : $t('score.points', { score: row.score })}
                </span>
              {:else}
                <span class="score-badge muted">{$t('score.noScore')}</span>
              {/if}
            </div>

            <div class="line line-original">
              <span class="line-label">{$t('score.original')}</span>
              <p class="line-text">{row.english}</p>
            </div>

            {#if row.status !== "skipped"}
              <div class="line line-mine">
                <span class="line-label">{$t('score.mine')}</span>
                <p class="line-text">{row.chinese}</p>
              </div>

              {#if row.recommended}
                <div class="line line-recommended">
                  <span class="line-label">{$t('score.recommended')}</span>
                  <p class="line-text">{row.recommended}</p>
                </div>
              {/if}

              {#if row.comment}
                <p class="comment">{$t('score.commentLabel')}{row.comment}</p>
              {/if}
            {/if}
          </section>
        {/each}

        {#if !loading && rows.length === 0 && !error}
          <p class="panel-status">{$t('score.empty')}</p>
        {/if}

        {#if degraded && raw}
          <details class="raw">
            <summary>{$t('score.rawResponse')}</summary>
            <pre>{raw}</pre>
          </details>
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .panel-backdrop {
    position: fixed;
    inset: 0;
    z-index: 70;
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding: 6vh 12px 12px;
    background: rgba(0, 0, 0, 0.28);
    backdrop-filter: blur(3px);
    -webkit-backdrop-filter: blur(3px);
  }

  .panel {
    width: min(760px, 100%);
    max-height: 84vh;
    display: flex;
    flex-direction: column;
    background: white;
    border: 1px solid #e5e5ea;
    border-radius: 12px;
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.18), 0 4px 16px rgba(0, 0, 0, 0.08);
    overflow: hidden;
  }

  :global(html.dark) .panel {
    background: #1c1c1e;
    border-color: #3a3a3c;
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
  }

  .panel-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    padding: 14px 16px;
    border-bottom: 1px solid #f2f2f7;
  }

  :global(html.dark) .panel-header {
    border-bottom-color: #3a3a3c;
  }

  .panel-heading {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }

  .panel-title {
    margin: 0;
    font-size: 15px;
    font-weight: 600;
    color: #1c1c1e;
  }

  :global(html.dark) .panel-title {
    color: #e5e5e7;
  }

  .panel-stats {
    margin: 0;
    font-size: 11px;
    color: #8e8e93;
    font-variant-numeric: tabular-nums;
  }

  .panel-close {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border: none;
    background: none;
    color: #aeaeb2;
    border-radius: 6px;
    cursor: pointer;
  }

  .panel-close:hover {
    background: #f2f2f7;
    color: #636366;
  }

  :global(html.dark) .panel-close:hover {
    background: #3a3a3c;
    color: #e5e5e7;
  }

  .panel-body {
    padding: 14px 16px 18px;
    overflow-y: auto;
    overscroll-behavior: contain;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .panel-status {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 4px 0;
    font-size: 12px;
    color: #636366;
  }

  :global(html.dark) .panel-status {
    color: #aeaeb2;
  }

  .spinner {
    width: 12px;
    height: 12px;
    border: 2px solid #e5e5ea;
    border-top-color: #0891b2;
    border-radius: 50%;
    animation: score-spin 0.8s linear infinite;
  }

  @keyframes score-spin {
    to {
      transform: rotate(360deg);
    }
  }

  .panel-error {
    margin: 0;
    padding: 8px 10px;
    border-radius: 7px;
    background: #fff1f0;
    border: 1px solid #ffd0cc;
    color: #d70015;
    font-size: 12px;
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
  }

  :global(html.dark) .panel-error {
    background: #3a1c1c;
    border-color: #7a2a26;
    color: #ff6961;
  }

  .panel-warn {
    margin: 0;
    padding: 7px 10px;
    border-radius: 7px;
    background: #fff7ed;
    border: 1px solid #fed7aa;
    color: #b45309;
    font-size: 11px;
    line-height: 1.5;
  }

  :global(html.dark) .panel-warn {
    background: #3a2a14;
    border-color: #7c4a12;
    color: #fbbf24;
  }

  .block {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding-bottom: 12px;
    border-bottom: 1px solid #f2f2f7;
  }

  :global(html.dark) .block {
    border-bottom-color: #2c2c2e;
  }

  .block:last-of-type {
    border-bottom: none;
    padding-bottom: 0;
  }

  .block-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  .block-index {
    font-size: 11px;
    font-weight: 600;
    color: #636366;
    font-variant-numeric: tabular-nums;
  }

  .block-title {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }

  .tag-type {
    background: transparent;
    border: 1px solid #e5e5ea;
    color: #8e8e93;
    padding: 1px 6px;
  }

  :global(html.dark) .tag-type {
    border-color: #3a3a3c;
    color: #aeaeb2;
  }

  :global(html.dark) .block-index {
    color: #aeaeb2;
  }

  .tag {
    font-size: 10px;
    font-weight: 600;
    padding: 2px 7px;
    border-radius: 999px;
  }

  .tag-skipped {
    background: #f2f2f7;
    color: #8e8e93;
  }

  :global(html.dark) .tag-skipped {
    background: #2c2c2e;
    color: #aeaeb2;
  }

  .score-badge {
    font-size: 11px;
    font-weight: 700;
    padding: 2px 8px;
    border-radius: 999px;
    font-variant-numeric: tabular-nums;
  }

  .score-badge.good {
    background: #e8f7ee;
    color: #12805c;
  }

  .score-badge.ok {
    background: #eef4fd;
    color: #1d63b8;
  }

  .score-badge.low {
    background: #fff1f0;
    color: #d70015;
  }

  .score-badge.muted {
    background: #f2f2f7;
    color: #8e8e93;
  }

  :global(html.dark) .score-badge.good {
    background: #16301f;
    color: #4ade80;
  }

  :global(html.dark) .score-badge.ok {
    background: #172436;
    color: #60a5fa;
  }

  :global(html.dark) .score-badge.low {
    background: #3a1c1c;
    color: #ff6961;
  }

  :global(html.dark) .score-badge.muted {
    background: #2c2c2e;
    color: #aeaeb2;
  }

  .line {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 7px 10px;
    border-radius: 7px;
  }

  .line-label {
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.03em;
    text-transform: uppercase;
  }

  .line-text {
    margin: 0;
    font-size: 12px;
    line-height: 1.6;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .line-original {
    background: #f2f2f7;
  }

  .line-original .line-label {
    color: #8e8e93;
  }

  :global(html.dark) .line-original {
    background: #2c2c2e;
  }

  :global(html.dark) .line-original .line-label {
    color: #8e8e93;
  }

  .line-mine {
    background: #eaf6fb;
  }

  .line-mine .line-label {
    color: #0891b2;
  }

  :global(html.dark) .line-mine {
    background: #0a1e2e;
  }

  :global(html.dark) .line-mine .line-label {
    color: #22d3ee;
  }

  .line-recommended {
    background: #fdf6e9;
  }

  .line-recommended .line-label {
    color: #b45309;
  }

  :global(html.dark) .line-recommended {
    background: #2e2412;
  }

  :global(html.dark) .line-recommended .line-label {
    color: #fbbf24;
  }

  .comment {
    margin: 0;
    font-size: 12px;
    line-height: 1.5;
    color: #636366;
  }

  :global(html.dark) .comment {
    color: #aeaeb2;
  }

  .raw {
    font-size: 11px;
    color: #8e8e93;
  }

  .raw pre {
    margin: 6px 0 0;
    max-height: 220px;
    overflow: auto;
    padding: 8px;
    border-radius: 6px;
    background: #f9f9fb;
    font-size: 11px;
    white-space: pre-wrap;
    word-break: break-word;
  }

  :global(html.dark) .raw pre {
    background: #2c2c2e;
    color: #aeaeb2;
  }

  @media print {
    .panel-backdrop {
      display: none;
    }
  }
</style>
