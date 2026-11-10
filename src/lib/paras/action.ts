import { get } from "svelte/store";
import { translate } from "$lib/i18n";
import { glossarySettings } from "$lib/stores/glossarySettings";
import { speakText, stopTextSpeech } from "$lib/tts/word";
import { LAYOUT_CHANGE_EVENT } from "$lib/utils/layout";
import { splitSpeechChunks } from "$lib/utils/tts";
import {
  collectParagraphs,
  hashParagraphs,
  PARAGRAPH_SELECTOR,
  type ParagraphEntry,
} from "$lib/utils/paragraphs";
import {
  getParasSession,
  publishParasDocument,
  removeParasDocument,
  type ParasSession,
} from "./store";

/**
 * Svelte action behind the paragraph reading ("段") mode.
 *
 * Hover highlights a whole paragraph through the CSS Custom Highlight API, so
 * the article's DOM and layout are untouched. Clicking a paragraph opens a
 * floating card below it; confirming stores the translation and leaves a small
 * white bubble icon at the paragraph's end. Bubbles are absolutely positioned
 * inside the paragraph: they occupy no space, keep the line breaks identical,
 * and follow the paragraph while the page scrolls without a scroll listener.
 *
 * Alt+clicking a paragraph (or the speaker button on its card) reads the English
 * original aloud through the same Kokoro backend as the 词/句 modes. When the
 * "朗读" option is enabled, opening the card starts reading automatically.
 *
 * Paragraph identity is the ordinal plus a hash of the source text, so a saved
 * translation that no longer matches is flagged instead of silently shown.
 */

const HOVER_NAME = "mdhero-para-hover";
const STYLE_ID = "mdhero-paras-style";
const CARD_CLASS = "mdhero-paras-card";
const BUBBLE_CLASS = "mdhero-paras-bubble";
const HOVER_CLASS = "mdhero-paras-hovered";
const UI_ATTR = "data-paras-ui";
const BUBBLE_ATTR = "data-paras-bubble";

export interface ParasParams {
  /** Mode on, reading pane, and the document is English. */
  enabled: boolean;
  /** Identifies the session/draft keys; paste/URL tabs use it. */
  tabId: string | null;
  filePath: string | null;
  /** Called when the edit card opens/closes, so page-level shortcuts can pause. */
  onCardState?: (open: boolean) => void;
}

interface Browser {
  destroy(): void;
}

function supportsHighlight(): boolean {
  return (
    typeof CSS !== "undefined" &&
    "highlights" in CSS &&
    typeof (globalThis as unknown as { Highlight?: unknown }).Highlight === "function"
  );
}

function injectStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
::highlight(${HOVER_NAME}) { background-color: rgba(234, 179, 8, 0.16); }
.${HOVER_CLASS} { background-color: rgba(234, 179, 8, 0.16); border-radius: 3px; }
.${BUBBLE_CLASS} {
  position: absolute;
  z-index: 4;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  padding: 0;
  border: 1px solid #d1d1d6;
  border-radius: 50%;
  background: #fff;
  color: #3a3a3c;
  cursor: pointer;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.10);
  line-height: 0;
  transition: border-color 0.12s, box-shadow 0.12s;
}
.${BUBBLE_CLASS}:hover {
  border-color: #0891b2;
  color: #0891b2;
}
.${BUBBLE_CLASS}.is-skipped {
  border-style: dashed;
  border-color: #c7c7cc;
  background: transparent;
  color: #8e8e93;
  box-shadow: none;
}
.${BUBBLE_CLASS}.is-changed {
  border-color: #f59e0b;
  color: #b45309;
  box-shadow: 0 0 0 2px rgba(245, 158, 11, 0.22);
}
html.dark .${BUBBLE_CLASS} {
  background: #2c2c2e;
  border-color: #48484a;
  color: #d1d1d6;
}
html.dark .${BUBBLE_CLASS}.is-skipped {
  background: transparent;
  border-color: #48484a;
  color: #8e8e93;
}
html.dark .${BUBBLE_CLASS}.is-changed {
  border-color: #f59e0b;
  color: #fbbf24;
}
.${CARD_CLASS} {
  position: fixed;
  z-index: 90;
  width: min(360px, calc(100vw - 24px));
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  background: #fff;
  border: 1px solid #e5e5ea;
  border-radius: 10px;
  box-shadow: 0 12px 34px rgba(0, 0, 0, 0.16), 0 2px 8px rgba(0, 0, 0, 0.08);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  color: #1c1c1e;
}
html.dark .${CARD_CLASS} {
  background: #2c2c2e;
  border-color: #3a3a3c;
  color: #e5e5e7;
  box-shadow: 0 12px 34px rgba(0, 0, 0, 0.45);
}
.${CARD_CLASS}-head {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  font-weight: 600;
  color: #636366;
}
.${CARD_CLASS}-hint {
  margin-right: auto;
  font-weight: 400;
  color: #8e8e93;
}
.${CARD_CLASS}-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  margin: -3px -4px -3px 0;
  padding: 0;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: #8e8e93;
  cursor: pointer;
  line-height: 0;
}
.${CARD_CLASS}-close:hover {
  background: rgba(0, 0, 0, 0.08);
  color: #1c1c1e;
}
.${CARD_CLASS}-speak {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  margin: -3px 0;
  padding: 0;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: #8e8e93;
  cursor: pointer;
  line-height: 0;
}
.${CARD_CLASS}-speak:hover {
  background: rgba(0, 0, 0, 0.08);
  color: #1c1c1e;
}
.${CARD_CLASS}-speak.is-speaking {
  color: #0891b2;
}
.${CARD_CLASS}-speak.is-speaking:hover {
  background: rgba(8, 145, 178, 0.12);
  color: #0e7490;
}
html.dark .${CARD_CLASS}-speak { color: #8e8e93; }
html.dark .${CARD_CLASS}-speak:hover {
  background: rgba(255, 255, 255, 0.14);
  color: #e5e5e7;
}
html.dark .${CARD_CLASS}-speak.is-speaking { color: #22d3ee; }
html.dark .${CARD_CLASS}-speak.is-speaking:hover {
  background: rgba(34, 211, 238, 0.16);
  color: #67e8f9;
}
html.dark .${CARD_CLASS}-close { color: #8e8e93; }
html.dark .${CARD_CLASS}-close:hover {
  background: rgba(255, 255, 255, 0.14);
  color: #e5e5e7;
}
html.dark .${CARD_CLASS}-head { color: #aeaeb2; }
.${CARD_CLASS}-source {
  max-height: 78px;
  overflow-y: auto;
  margin: 0;
  padding: 6px 8px;
  border-radius: 6px;
  background: #f2f2f7;
  font-size: 11px;
  line-height: 1.5;
  color: #3a3a3c;
  white-space: pre-wrap;
  word-break: break-word;
}
html.dark .${CARD_CLASS}-source {
  background: #1c1c1e;
  color: #aeaeb2;
}
.${CARD_CLASS}-warn {
  margin: 0;
  padding: 5px 8px;
  border-radius: 6px;
  background: #fff7ed;
  border: 1px solid #fed7aa;
  color: #b45309;
  font-size: 11px;
  line-height: 1.4;
}
html.dark .${CARD_CLASS}-warn {
  background: #3a2a14;
  border-color: #7c4a12;
  color: #fbbf24;
}
.${CARD_CLASS}-input {
  width: 100%;
  box-sizing: border-box;
  min-height: 84px;
  padding: 7px 9px;
  font-size: 12px;
  line-height: 1.5;
  color: #1c1c1e;
  background: #f9f9fb;
  border: 1px solid #e5e5ea;
  border-radius: 7px;
  outline: none;
  resize: vertical;
  font-family: inherit;
}
.${CARD_CLASS}-input:focus { border-color: #0891b2; }
html.dark .${CARD_CLASS}-input {
  background: #1c1c1e;
  border-color: #3a3a3c;
  color: #e5e5e7;
}
.${CARD_CLASS}-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.${CARD_CLASS}-btn {
  border: none;
  border-radius: 7px;
  padding: 5px 12px;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
}
.${CARD_CLASS}-skip {
  padding-left: 0;
  background: transparent;
  color: #8e8e93;
}
.${CARD_CLASS}-skip:hover { color: #ff3b30; }
html.dark .${CARD_CLASS}-skip:hover { color: #ff6b61; }
.${CARD_CLASS}-confirm {
  background: #0891b2;
  color: #fff;
}
.${CARD_CLASS}-confirm:hover:not(:disabled) { background: #0e7490; }
.${CARD_CLASS}-confirm:disabled { opacity: 0.4; cursor: not-allowed; }
`;
  document.head.appendChild(style);
}

function bubbleIcon(): string {
  return '<svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" aria-hidden="true"><path d="M2 2.5h8a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1H5.4L3 10.5V8.5H2a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1z"/></svg>';
}

function closeIcon(): string {
  return '<svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><path d="M3 3l6 6M9 3l-6 6"/></svg>';
}

function speakerIcon(): string {
  return '<svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 4.5h1.4L5.8 2.4v7.2L3.4 7.5H2a.5.5 0 0 1-.5-.5V5a.5.5 0 0 1 .5-.5z"/><path d="M7.8 4.2a2.3 2.3 0 0 1 0 3.6"/><path d="M9.3 2.7a4.1 4.1 0 0 1 0 6.6"/></svg>';
}

function stopIcon(): string {
  return '<svg width="11" height="11" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true"><rect x="3" y="3" width="6" height="6" rx="1"/></svg>';
}

export function createParasBrowser(
  container: HTMLElement,
  article: HTMLElement,
  params: ParasParams,
): Browser {
  injectStyles();

  const session: ParasSession = getParasSession(params.tabId, params.filePath);
  const useHighlight = supportsHighlight();
  const highlightRegistry = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights;
  const HighlightCtor = (globalThis as unknown as { Highlight?: new (range: Range) => unknown }).Highlight;

  let destroyed = false;
  let entries: ParagraphEntry[] = [];
  const entryMap = new Map<HTMLElement, ParagraphEntry>();
  const bubbles = new Map<number, HTMLButtonElement>();
  const positioned = new Map<HTMLElement, string>();
  let hovered: HTMLElement | null = null;
  let card: HTMLElement | null = null;
  let cardEntry: ParagraphEntry | null = null;
  let cardInput: HTMLTextAreaElement | null = null;
  let cardConfirm: HTMLButtonElement | null = null;
  let cardSpeak: HTMLButtonElement | null = null;
  let speakingIndex: number | null = null;
  let speechToken = 0;
  let rafPending = false;
  let rebuildToken = 0;
  let rebuildTimer: ReturnType<typeof setTimeout> | undefined;

  // --- observer guard -----------------------------------------------------
  // Bubbles and inline `position: relative` are our own DOM writes. The
  // observer is disconnected around them so they cannot trigger a rebuild.
  let observer: MutationObserver | null = null;

  function guardUi<T>(fn: () => T): T {
    observer?.disconnect();
    try {
      return fn();
    } finally {
      if (!destroyed) {
        observer?.observe(article, { childList: true, subtree: true, characterData: true });
      }
    }
  }

  // --- hover highlight ----------------------------------------------------
  function clearHover(): void {
    if (!hovered) return;
    if (useHighlight) highlightRegistry?.delete(HOVER_NAME);
    hovered.classList.remove(HOVER_CLASS);
    hovered = null;
  }

  function setHover(entry: ParagraphEntry): void {
    if (hovered === entry.element) return;
    clearHover();
    hovered = entry.element;
    // A heading is one line and a cell is one box: the reader expects the whole
    // line/cell painted, while the Highlight API only covers the glyphs.
    const wholeBox = entry.kind === "heading" || entry.kind === "cell";
    if (!wholeBox && useHighlight && highlightRegistry && HighlightCtor) {
      const range = document.createRange();
      range.selectNodeContents(entry.element);
      highlightRegistry.set(HOVER_NAME, new HighlightCtor(range));
    } else {
      entry.element.classList.add(HOVER_CLASS);
    }
  }

  function entryAtPoint(x: number, y: number): ParagraphEntry | null {
    const target = document.elementFromPoint(x, y);
    if (!target || !article.contains(target)) return null;
    const block = (target as Element).closest?.(PARAGRAPH_SELECTOR) as HTMLElement | null;
    if (!block) return null;
    return entryMap.get(block) ?? null;
  }

  function onMove(event: MouseEvent): void {
    if (rafPending) return;
    rafPending = true;
    const x = event.clientX;
    const y = event.clientY;
    requestAnimationFrame(() => {
      rafPending = false;
      if (destroyed || card) return;
      const entry = entryAtPoint(x, y);
      if (entry) setHover(entry);
      else clearHover();
    });
  }

  // --- bubbles ------------------------------------------------------------
  function ensurePositioned(element: HTMLElement): void {
    if (positioned.has(element)) return;
    positioned.set(element, element.style.position);
    if (getComputedStyle(element).position === "static") element.style.position = "relative";
  }

  function caretRect(element: HTMLElement): DOMRect | null {
    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(false);
    const rect = range.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return null;
    return rect;
  }

  function placeBubble(entry: ParagraphEntry, bubble: HTMLButtonElement): void {
    const elementRect = entry.element.getBoundingClientRect();
    const rect = caretRect(entry.element);
    const size = 16;
    let left: number;
    let top: number;
    if (!rect) {
      left = Math.max(0, elementRect.width - size);
      top = Math.max(0, elementRect.height - size);
    } else {
      left = rect.right - elementRect.left + 2;
      top = rect.top - elementRect.top + (rect.height - size) / 2;
    }
    if (entry.kind === "cell") {
      // Cells are narrow: when the end of the text is too close to the column
      // edge, pin the bubble inside the top-right corner instead of letting the
      // clamp push it over the neighbouring column.
      const maxLeft = Math.max(0, elementRect.width - size - 2);
      if (left > maxLeft) {
        left = maxLeft;
        top = 2;
      }
    }
    left = Math.max(0, Math.min(left, elementRect.width - size));
    top = Math.max(0, Math.min(top, elementRect.height - size));
    bubble.style.left = `${Math.round(left)}px`;
    bubble.style.top = `${Math.round(top)}px`;
  }

  function createBubble(entry: ParagraphEntry, skipped: boolean, changed: boolean): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = BUBBLE_CLASS;
    button.setAttribute(UI_ATTR, "1");
    button.setAttribute(BUBBLE_ATTR, String(entry.index));
    button.innerHTML = bubbleIcon();
    if (skipped) button.classList.add("is-skipped");
    if (changed) button.classList.add("is-changed");
    button.title = skipped
      ? translate("paras.skippedTooltip")
      : changed
        ? translate("paras.changedTooltip")
        : translate("paras.openTooltip");
    button.setAttribute("aria-label", button.title);
    return button;
  }

  function renderBubbles(): void {
    guardUi(() => {
      for (const bubble of bubbles.values()) bubble.remove();
      bubbles.clear();
      const state = get(session.state);
      for (const entry of entries) {
        const item = state.items[entry.index];
        if (!item) continue;
        if (item.status !== "skipped" && item.text.trim().length === 0) continue;
        const changed = item.hash !== entry.hash;
        ensurePositioned(entry.element);
        const bubble = createBubble(entry, item.status === "skipped", changed);
        placeBubble(entry, bubble);
        entry.element.appendChild(bubble);
        bubbles.set(entry.index, bubble);
      }
    });
  }

  // --- edit card ----------------------------------------------------------
  function updateCardSpeakButton(): void {
    if (!cardSpeak || !cardEntry) return;
    const playing = speakingIndex === cardEntry.index;
    cardSpeak.innerHTML = playing ? stopIcon() : speakerIcon();
    const label = translate(playing ? "paras.stopReading" : "paras.readAloud");
    cardSpeak.title = label;
    cardSpeak.setAttribute("aria-label", label);
    cardSpeak.setAttribute("aria-pressed", playing ? "true" : "false");
    cardSpeak.classList.toggle("is-speaking", playing);
  }

  function stopParagraphSpeech(): void {
    speechToken++;
    speakingIndex = null;
    stopTextSpeech();
    updateCardSpeakButton();
  }

  /** Read a paragraph's English original in Kokoro-sized chunks, so a long
   *  paragraph starts quickly and the stop button takes effect between chunks. */
  function speakParagraph(entry: ParagraphEntry): void {
    const chunks = splitSpeechChunks(entry.text);
    if (chunks.length === 0) return;

    const token = ++speechToken;
    speakingIndex = entry.index;
    updateCardSpeakButton();

    const play = (index: number): void => {
      if (token !== speechToken) return;
      if (index >= chunks.length) {
        speakingIndex = null;
        updateCardSpeakButton();
        return;
      }
      speakText(chunks[index].text, {
        onEnd: (completed) => {
          if (token !== speechToken) return;
          if (!completed) {
            speechToken++;
            speakingIndex = null;
            updateCardSpeakButton();
            return;
          }
          play(index + 1);
        },
      });
    };

    play(0);
  }

  function toggleParagraphSpeech(entry: ParagraphEntry): void {
    if (speakingIndex === entry.index) {
      stopParagraphSpeech();
      return;
    }
    speakParagraph(entry);
  }

  function closeCard(): void {
    if (!card) return;
    const element = card;
    const entry = cardEntry;
    card = null;
    cardEntry = null;
    cardInput = null;
    cardConfirm = null;
    cardSpeak = null;
    element.remove();
    params.onCardState?.(false);
    if (entry && speakingIndex === entry.index) stopParagraphSpeech();
  }

  function label(text: string, className: string): HTMLElement {
    const span = document.createElement("span");
    span.className = className;
    span.textContent = text;
    return span;
  }

  function openCard(entry: ParagraphEntry): void {
    closeCard();
    clearHover();

    const item = session.getItem(entry.index);
    const draft = session.getDraft(entry.index);
    const value = draft ?? (item?.status === "translated" ? item.text : "");
    const changed = item !== undefined && item.hash !== entry.hash;

    const element = document.createElement("div");
    element.className = CARD_CLASS;
    element.setAttribute(UI_ATTR, "1");

    const head = document.createElement("div");
    head.className = `${CARD_CLASS}-head`;
    head.appendChild(label(translate("paras.cardTitle", { n: entry.index + 1 }), `${CARD_CLASS}-title`));
    head.appendChild(label(translate("paras.original"), `${CARD_CLASS}-hint`));
    const speak = document.createElement("button");
    speak.type = "button";
    speak.className = `${CARD_CLASS}-speak`;
    speak.innerHTML = speakerIcon();
    speak.title = translate("paras.readAloud");
    speak.setAttribute("aria-label", speak.title);
    speak.setAttribute("aria-pressed", "false");
    speak.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      toggleParagraphSpeech(entry);
    });
    head.appendChild(speak);
    const close = document.createElement("button");
    close.type = "button";
    close.className = `${CARD_CLASS}-close`;
    close.innerHTML = closeIcon();
    close.title = translate("common.close");
    close.setAttribute("aria-label", close.title);
    close.addEventListener("click", () => closeCard());
    head.appendChild(close);
    element.appendChild(head);

    const source = document.createElement("p");
    source.className = `${CARD_CLASS}-source`;
    source.textContent = entry.text;
    element.appendChild(source);

    if (changed) {
      const warn = document.createElement("p");
      warn.className = `${CARD_CLASS}-warn`;
      warn.textContent = translate("paras.changedWarning");
      element.appendChild(warn);
    }

    const input = document.createElement("textarea");
    input.className = `${CARD_CLASS}-input`;
    input.setAttribute(UI_ATTR, "1");
    input.value = value;
    input.placeholder = translate("paras.placeholder");
    input.spellcheck = false;
    element.appendChild(input);

    const foot = document.createElement("div");
    foot.className = `${CARD_CLASS}-foot`;
    const skip = document.createElement("button");
    skip.type = "button";
    skip.className = `${CARD_CLASS}-btn ${CARD_CLASS}-skip`;
    skip.textContent = translate("paras.skip");
    const confirm = document.createElement("button");
    confirm.type = "button";
    confirm.className = `${CARD_CLASS}-btn ${CARD_CLASS}-confirm`;
    confirm.textContent = translate("paras.confirm");
    confirm.disabled = input.value.trim().length === 0;
    foot.appendChild(skip);
    foot.appendChild(confirm);
    element.appendChild(foot);

    document.body.appendChild(element);
    card = element;
    cardEntry = entry;
    cardInput = input;
    cardConfirm = confirm;
    cardSpeak = speak;
    updateCardSpeakButton();
    params.onCardState?.(true);
    placeCard();

    if (get(glossarySettings).speakOnClick && speakingIndex !== entry.index) {
      speakParagraph(entry);
    }

    input.addEventListener("input", () => {
      session.setDraft(entry.index, input.value);
      confirm.disabled = input.value.trim().length === 0;
    });

    input.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeCard();
      }
    });

    confirm.addEventListener("click", () => {
      const text = input.value.trim();
      if (text.length === 0) return;
      session.setItem({
        index: entry.index,
        hash: entry.hash,
        text,
        status: "translated",
        updatedAt: Date.now(),
      });
      closeCard();
      renderBubbles();
    });

    skip.addEventListener("click", () => {
      session.setItem({
        index: entry.index,
        hash: entry.hash,
        text: "",
        status: "skipped",
        updatedAt: Date.now(),
      });
      closeCard();
      renderBubbles();
    });

    // Focus without scrolling the paragraph out of view.
    input.focus({ preventScroll: true });
  }

  /** Below the paragraph; flip above when the viewport bottom would clip it.
   *  Never covers the paragraph being edited: when neither side fits, the page
   *  scrolls so the card fits underneath. */
  function placeCard(): void {
    if (!card || !cardEntry) return;
    const rect = cardEntry.element.getBoundingClientRect();
    const gap = 8;
    const height = card.offsetHeight;
    const width = card.offsetWidth;
    let top = rect.bottom + gap;

    if (top + height > window.innerHeight - 8) {
      const above = rect.top - gap - height;
      if (above >= 8) {
        top = above;
      } else {
        const need = Math.round(top + height - (window.innerHeight - 8));
        window.scrollBy(0, need);
        top = cardEntry.element.getBoundingClientRect().bottom + gap;
      }
    }
    top = Math.max(8, Math.min(top, window.innerHeight - height - 8));
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
    card.style.left = `${Math.round(left)}px`;
    card.style.top = `${Math.round(top)}px`;
  }

  function scheduleCardPosition(): void {
    if (!card || rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      placeCard();
    });
  }

  // --- rebuild ------------------------------------------------------------
  function clearUi(): void {
    for (const bubble of bubbles.values()) bubble.remove();
    bubbles.clear();
    for (const [element, previous] of positioned) {
      element.style.position = previous;
    }
    positioned.clear();
  }

  function publish(): void {
    if (!params.tabId) return;
    publishParasDocument(params.tabId, {
      total: entries.length,
      entries: entries.map((entry) => ({
        index: entry.index,
        text: entry.text,
        hash: entry.hash,
        kind: entry.kind,
      })),
    });
  }

  async function rebuild(): Promise<void> {
    const token = ++rebuildToken;
    closeCard();
    clearHover();
    guardUi(clearUi);

    const collected = collectParagraphs(article);
    const hashed = await hashParagraphs(
      collected,
      () => destroyed || token !== rebuildToken,
    );
    if (destroyed || token !== rebuildToken) return;

    entries = hashed;
    entryMap.clear();
    for (const entry of entries) entryMap.set(entry.element, entry);
    // Units may have shifted (a new heading renumbers everything after it):
    // re-attach saved translations by hash before drawing bubbles.
    session.reconcile(entries.map((entry) => ({ index: entry.index, hash: entry.hash })));
    publish();
    renderBubbles();
  }

  function scheduleRebuild(): void {
    clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(() => {
      void rebuild();
    }, 160);
  }

  // --- click --------------------------------------------------------------
  function onClick(event: MouseEvent): void {
    const target = event.target as Element | null;

    const bubble = target?.closest?.(`[${BUBBLE_ATTR}]`) as HTMLElement | null;
    if (bubble) {
      const index = Number(bubble.getAttribute(BUBBLE_ATTR));
      const entry = entries.find((candidate) => candidate.index === index);
      event.preventDefault();
      event.stopPropagation();
      if (!entry) return;
      if (event.altKey) speakParagraph(entry);
      else openCard(entry);
      return;
    }

    const block = target?.closest?.(PARAGRAPH_SELECTOR) as HTMLElement | null;
    if (!block || !article.contains(block)) return;
    const entry = entryMap.get(block);
    if (!entry) return;
    // Links inside a paragraph open the card, not the browser: the paragraph
    // is the unit being edited here.
    event.preventDefault();
    event.stopPropagation();
    // Alt+click is the read-aloud gesture from the 词/句 modes; it must not also
    // open the edit card.
    if (event.altKey) speakParagraph(entry);
    else openCard(entry);
  }

  function onDocumentPointerDown(event: MouseEvent): void {
    if (!card) return;
    const target = event.target as Node | null;
    if (target && card.contains(target)) return;
    closeCard();
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key !== "Escape" || !card) return;
    event.preventDefault();
    event.stopPropagation();
    closeCard();
  }

  function onScroll(): void {
    if (card) scheduleCardPosition();
  }

  function onResize(): void {
    if (card) scheduleCardPosition();
  }

  // --- wiring -------------------------------------------------------------
  container.addEventListener("mousemove", onMove, { passive: true });
  container.addEventListener("mouseleave", clearHover);
  container.addEventListener("click", onClick, true);
  document.addEventListener("pointerdown", onDocumentPointerDown, true);
  document.addEventListener("keydown", onKeydown, true);
  window.addEventListener("scroll", onScroll, { passive: true, capture: true });
  window.addEventListener("resize", onResize);

  observer = new MutationObserver(() => {
    clearHover();
    scheduleRebuild();
  });
  observer.observe(article, { childList: true, subtree: true, characterData: true });

  const unsubscribe = session.state.subscribe(() => {
    if (!destroyed && entries.length > 0 && !card) renderBubbles();
  });

  // Line spacing (and font size) reflow the article without a resize event;
  // the open card is placed from its paragraph's rect, so re-glue it.
  window.addEventListener(LAYOUT_CHANGE_EVENT, onResize);

  void session.ready.then(() => {
    if (!destroyed) void rebuild();
  });

  return {
    destroy() {
      destroyed = true;
      rebuildToken++;
      clearTimeout(rebuildTimer);
      unsubscribe();
      window.removeEventListener(LAYOUT_CHANGE_EVENT, onResize);
      observer?.disconnect();
      observer = null;
      closeCard();
      clearHover();
      guardUi(clearUi);
      container.removeEventListener("mousemove", onMove);
      container.removeEventListener("mouseleave", clearHover);
      container.removeEventListener("click", onClick, true);
      document.removeEventListener("pointerdown", onDocumentPointerDown, true);
      document.removeEventListener("keydown", onKeydown, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
      highlightRegistry?.delete(HOVER_NAME);
      if (params.tabId) removeParasDocument(params.tabId);
    },
  };
}

/** Svelte action: re-created whenever the mode, tab or file changes. */
export function paras(node: HTMLElement, params: ParasParams) {
  let current = params;
  let browser: Browser | null = null;

  function start(): void {
    if (browser || !current.enabled) return;
    const article = node.querySelector<HTMLElement>("article.md-content");
    if (!article) return;
    browser = createParasBrowser(node, article, current);
  }

  function stop(): void {
    browser?.destroy();
    browser = null;
  }

  start();

  return {
    update(next: ParasParams) {
      const changed =
        next.enabled !== current.enabled ||
        next.tabId !== current.tabId ||
        next.filePath !== current.filePath;
      current = next;
      if (!changed) return;
      stop();
      start();
    },
    destroy() {
      stop();
    },
  };
}
