<script lang="ts">
  import { X } from "@lucide/svelte";
  import { t } from "$lib/i18n";
  import {
    restoreDefaultShortcuts,
    setPlayPauseShortcut,
    shortcuts,
  } from "$lib/stores/shortcuts";
  import { DEFAULT_PLAY_PAUSE_SHORTCUT, codeFromEvent, shortcutLabel } from "$lib/utils/shortcut";

  let { visible = $bindable(false) }: { visible: boolean } = $props();

  let recording = $state(false);

  function close() {
    recording = false;
    visible = false;
  }

  function handleBackdropClick(e: MouseEvent) {
    if (e.target === e.currentTarget) close();
  }

  // Captures the next key while recording. Modifier combinations and repeats
  // are ignored by codeFromEvent, so Ctrl+W can never become a reading key.
  function handleKeydown(e: KeyboardEvent) {
    if (!visible) return;
    if (e.key === "Escape") {
      e.stopPropagation();
      if (recording) recording = false;
      else close();
      return;
    }
    if (!recording) return;
    const code = codeFromEvent(e);
    if (!code) return;
    e.preventDefault();
    e.stopPropagation();
    setPlayPauseShortcut(code);
    recording = false;
  }

  function startRecording() {
    recording = true;
  }

  function restoreDefault() {
    recording = false;
    restoreDefaultShortcuts();
  }
</script>

<svelte:window onkeydown={handleKeydown} />

{#if visible}
  <div
    class="dialog-backdrop"
    role="presentation"
    onclick={handleBackdropClick}
    onkeydown={handleKeydown}
  >
    <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="shortcut-settings-title">
      <div class="dialog-header">
        <h2 id="shortcut-settings-title" class="dialog-title">{$t('shortcuts.title')}</h2>
        <button onclick={close} class="dialog-close" aria-label={$t('common.close')}>
          <X size={16} />
        </button>
      </div>

      <div class="dialog-body">
        <p class="dialog-description">{$t('shortcuts.description')}</p>

        <div class="row">
          <span class="field-label">{$t('shortcuts.playPause')}</span>
          <div class="row-actions">
            <kbd class="key" class:recording>
              {recording ? $t('shortcuts.recording') : shortcutLabel($shortcuts.playPause)}
            </kbd>
            <button
              type="button"
              class="btn btn-cancel"
              disabled={recording}
              onclick={startRecording}
            >
              {$t('shortcuts.change')}
            </button>
          </div>
        </div>

        <p class="dialog-description hint">{$t('shortcuts.hint')}</p>
      </div>

      <div class="dialog-footer">
        <button
          type="button"
          class="btn btn-reset"
          disabled={$shortcuts.playPause === DEFAULT_PLAY_PAUSE_SHORTCUT}
          onclick={restoreDefault}
        >
          {$t('shortcuts.restoreDefault')}
        </button>
        <div class="footer-actions">
          <button type="button" class="btn btn-save" onclick={close}>
            {$t('common.close')}
          </button>
        </div>
      </div>
    </div>
  </div>
{/if}

<style>
  .dialog-backdrop {
    position: fixed;
    inset: 0;
    z-index: 60;
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding-top: 10vh;
    background: rgba(0, 0, 0, 0.25);
    backdrop-filter: blur(3px);
    -webkit-backdrop-filter: blur(3px);
  }

  .dialog {
    width: 480px;
    max-height: 78vh;
    background: white;
    border: 1px solid #e5e5ea;
    border-radius: 12px;
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.15), 0 4px 16px rgba(0, 0, 0, 0.08);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  :global(html.dark) .dialog {
    background: #2c2c2e;
    border-color: #3a3a3c;
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.4);
  }

  .dialog-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 16px;
    border-bottom: 1px solid #f2f2f7;
  }

  :global(html.dark) .dialog-header {
    border-bottom-color: #3a3a3c;
  }

  .dialog-title {
    font-size: 15px;
    font-weight: 600;
    color: #1c1c1e;
    margin: 0;
  }

  :global(html.dark) .dialog-title {
    color: #e5e5e7;
  }

  .dialog-close {
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
    transition: background 0.12s;
  }

  .dialog-close:hover {
    background: #f2f2f7;
    color: #636366;
  }

  :global(html.dark) .dialog-close:hover {
    background: #3a3a3c;
    color: #e5e5e7;
  }

  .dialog-body {
    padding: 16px;
    overflow-y: auto;
    overscroll-behavior: contain;
  }

  .dialog-description {
    margin: 0 0 16px;
    font-size: 12px;
    line-height: 1.5;
    color: #636366;
  }

  .dialog-description.hint {
    margin: 4px 0 0;
    color: #8e8e93;
  }

  :global(html.dark) .dialog-description {
    color: #aeaeb2;
  }

  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 10px 12px;
    border: 1px solid #f2f2f7;
    border-radius: 8px;
  }

  :global(html.dark) .row {
    border-color: #3a3a3c;
  }

  .row-actions {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .field-label {
    font-size: 13px;
    font-weight: 500;
    color: #1c1c1e;
  }

  :global(html.dark) .field-label {
    color: #e5e5e7;
  }

  .key {
    min-width: 38px;
    padding: 4px 10px;
    text-align: center;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 12px;
    color: #1c1c1e;
    background: #f9f9fb;
    border: 1px solid #e5e5ea;
    border-radius: 6px;
  }

  :global(html.dark) .key {
    background: #1c1c1e;
    border-color: #3a3a3c;
    color: #e5e5e7;
  }

  .key.recording {
    color: #0891b2;
    border-color: #0891b2;
  }

  .dialog-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 12px 16px;
    border-top: 1px solid #f2f2f7;
  }

  :global(html.dark) .dialog-footer {
    border-top-color: #3a3a3c;
  }

  .footer-actions {
    display: flex;
    gap: 8px;
  }

  .btn {
    border: none;
    border-radius: 7px;
    padding: 6px 14px;
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    transition: background 0.12s, color 0.12s;
  }

  .btn:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .btn-reset {
    padding-left: 0;
    background: transparent;
    color: #8e8e93;
  }

  .btn-reset:hover:not(:disabled) {
    color: #1c1c1e;
  }

  :global(html.dark) .btn-reset:hover:not(:disabled) {
    color: #e5e5e7;
  }

  .btn-cancel {
    background: #f2f2f7;
    color: #3a3a3c;
  }

  .btn-cancel:hover:not(:disabled) {
    background: #e5e5ea;
  }

  :global(html.dark) .btn-cancel {
    background: #3a3a3c;
    color: #e5e5e7;
  }

  :global(html.dark) .btn-cancel:hover:not(:disabled) {
    background: #48484a;
  }

  .btn-save {
    background: #0891b2;
    color: white;
  }

  .btn-save:hover:not(:disabled) {
    background: #0e7490;
  }

  @media print {
    .dialog-backdrop {
      display: none;
    }
  }
</style>
