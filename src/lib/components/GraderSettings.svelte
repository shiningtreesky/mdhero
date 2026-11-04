<script lang="ts">
  import { X } from "@lucide/svelte";
  import { t, translate } from "$lib/i18n";
  import {
    DEFAULT_GRADER_SETTINGS,
    graderSettings,
    type GraderSettings,
  } from "$lib/stores/graderSettings";
  import { isValidBaseUrl } from "$lib/utils/translation";

  let { visible = $bindable(false) }: { visible: boolean } = $props();

  let form = $state<GraderSettings>({ ...DEFAULT_GRADER_SETTINGS });
  let error = $state("");
  let wasVisible = false;

  $effect(() => {
    if (visible && !wasVisible) {
      form = { ...$graderSettings };
      error = "";
    }
    wasVisible = visible;
  });

  function handleBackdropClick(e: MouseEvent) {
    if (e.target === e.currentTarget) visible = false;
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.stopPropagation();
      visible = false;
    }
  }

  function restoreDefaults() {
    form = { ...DEFAULT_GRADER_SETTINGS };
    error = "";
  }

  function handleSave() {
    const baseUrl = form.baseUrl.trim();
    if (!isValidBaseUrl(baseUrl)) {
      error = translate("translation.invalidBaseUrl");
      return;
    }
    const model = form.model.trim();
    if (!model) {
      error = translate("translation.modelRequired");
      return;
    }
    graderSettings.set({ baseUrl, apiKey: form.apiKey, model });
    visible = false;
  }
</script>

{#if visible}
  <div
    class="dialog-backdrop"
    role="presentation"
    onclick={handleBackdropClick}
    onkeydown={handleKeydown}
  >
    <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="grader-settings-title">
      <div class="dialog-header">
        <h2 id="grader-settings-title" class="dialog-title">{$t('grader.title')}</h2>
        <button onclick={() => (visible = false)} class="dialog-close" aria-label={$t('common.close')}>
          <X size={16} />
        </button>
      </div>

      <div class="dialog-body">
        <p class="dialog-description">{$t('grader.description')}</p>

        <label class="field">
          <span class="field-label">{$t('grader.baseUrl')}</span>
          <span class="field-hint">{$t('grader.baseUrlHint')}</span>
          <input
            class="text-input mono"
            type="url"
            spellcheck="false"
            autocomplete="off"
            bind:value={form.baseUrl}
            placeholder="https://api.example.com/v1"
          />
        </label>

        <label class="field">
          <span class="field-label">{$t('grader.apiKey')}</span>
          <span class="field-hint">{$t('grader.apiKeyHint')}</span>
          <input
            class="text-input mono"
            type="password"
            spellcheck="false"
            autocomplete="off"
            bind:value={form.apiKey}
            placeholder="sk-…"
          />
        </label>

        <label class="field">
          <span class="field-label">{$t('grader.model')}</span>
          <span class="field-hint">{$t('grader.modelHint')}</span>
          <input
            class="text-input mono"
            type="text"
            spellcheck="false"
            autocomplete="off"
            bind:value={form.model}
            placeholder="mimo-v2.6-flash"
          />
        </label>

        {#if error}
          <p class="form-error" role="alert">{error}</p>
        {/if}
      </div>

      <div class="dialog-footer">
        <button type="button" class="btn btn-reset" onclick={restoreDefaults}>
          {$t('translation.restoreDefaults')}
        </button>
        <div class="footer-actions">
          <button type="button" class="btn btn-cancel" onclick={() => (visible = false)}>
            {$t('common.cancel')}
          </button>
          <button type="button" class="btn btn-save" onclick={handleSave}>
            {$t('common.save')}
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
    width: 560px;
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

  :global(html.dark) .dialog-description {
    color: #aeaeb2;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 3px;
    margin-bottom: 14px;
  }

  .field-label {
    font-size: 13px;
    font-weight: 500;
    color: #1c1c1e;
  }

  :global(html.dark) .field-label {
    color: #e5e5e7;
  }

  .field-hint {
    font-size: 11px;
    line-height: 1.4;
    color: #8e8e93;
  }

  .text-input {
    width: 100%;
    box-sizing: border-box;
    margin-top: 4px;
    padding: 7px 9px;
    font-size: 12px;
    color: #1c1c1e;
    background: #f9f9fb;
    border: 1px solid #e5e5ea;
    border-radius: 7px;
    outline: none;
    transition: border-color 0.12s;
  }

  .text-input:focus {
    border-color: #0891b2;
  }

  :global(html.dark) .text-input {
    background: #1c1c1e;
    border-color: #3a3a3c;
    color: #e5e5e7;
  }

  .mono {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }

  .form-error {
    margin: 4px 0 0;
    font-size: 12px;
    color: #ff3b30;
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

  .btn-reset {
    padding-left: 0;
    background: transparent;
    color: #8e8e93;
  }

  .btn-reset:hover {
    color: #1c1c1e;
  }

  :global(html.dark) .btn-reset:hover {
    color: #e5e5e7;
  }

  .btn-cancel {
    background: #f2f2f7;
    color: #3a3a3c;
  }

  .btn-cancel:hover {
    background: #e5e5ea;
  }

  :global(html.dark) .btn-cancel {
    background: #3a3a3c;
    color: #e5e5e7;
  }

  :global(html.dark) .btn-cancel:hover {
    background: #48484a;
  }

  .btn-save {
    background: #0891b2;
    color: white;
  }

  .btn-save:hover {
    background: #0e7490;
  }

  @media print {
    .dialog-backdrop {
      display: none;
    }
  }
</style>
