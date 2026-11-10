import { get } from "svelte/store";
import { translate } from "$lib/i18n";
import { glossarySettings } from "$lib/stores/glossarySettings";
import { LAYOUT_CHANGE_EVENT } from "$lib/utils/layout";
import { showToast } from "$lib/stores/toast";
import { speakText } from "$lib/tts/word";
import { collectParagraphs, UNIT_SELECTOR } from "$lib/utils/paragraphs";
import { sentenceKey, tokenizeSentences } from "$lib/utils/sentences";
import { sentenceRanges, skipTextNode, unitText } from "$lib/utils/sentence-dom";
import { SENTENCE_FILE_SUFFIX, createGlossCache, type GlossCache } from "./cache";
import { lookupSentence } from "./lookup";
import {
  caretAtPoint,
  placeBubble,
  supportsHighlight,
  type CaretHit,
} from "./shared";

/**
 * Svelte action behind the sentence ("句") reading mode.
 *
 * It is the 词 mode one granularity up: hovering paints the whole sentence,
 * clicking shows its Chinese translation in a bubble, Alt+click (or the 朗读
 * option) speaks the sentence, and a long press on the toolbar button opens the
 * same endpoint settings as 词.
 *
 * Sentences are built per prose block from the rendered text, so inline
 * elements (`<em>`, links, inline code) stay inside one sentence instead of
 * splitting it at every text node. With the CSS Custom Highlight API available
 * the article's DOM is untouched; old WebViews fall back to wrapping sentence
 * fragments in inline spans, exactly like the word mode.
 */

const HOVER_NAME = "mdhero-sentence-hover";
const STYLE_ID = "mdhero-sentence-style";
const BUBBLE_CLASS = "mdhero-sentence-bubble";
const SENTENCE_CLASS = "mdhero-sentence";
const HOVER_CLASS = "mdhero-sentence-hovered";

let memoryHintShown = false;

export interface SentenceParams {
  /** Mode on, reading pane, and the document is English. */
  enabled: boolean;
  /** Identifies the cache; paste/URL tabs use it for the localStorage key. */
  tabId: string | null;
  filePath: string | null;
}

interface SentenceEntry {
  unit: HTMLElement;
  unitIndex: number;
  index: number;
  /** The sentence as it appears in the DOM, without outer whitespace. */
  text: string;
  /** Whitespace-collapsed form used for the cache and the request. */
  key: string;
  range: Range | null;
}

interface Browser {
  destroy(): void;
}

function injectStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
::highlight(${HOVER_NAME}) { background-color: rgba(234, 179, 8, 0.18); }
.${SENTENCE_CLASS}.${HOVER_CLASS} { background-color: rgba(234, 179, 8, 0.18); border-radius: 3px; }
.${BUBBLE_CLASS} {
  position: fixed;
  z-index: 80;
  padding: 3px 6px;
  border-radius: 6px;
  border: 1px solid #e5e5ea;
  background: #fff;
  color: #1c1c1e;
  font-size: 13px;
  line-height: 1.35;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  white-space: normal;
  overflow-wrap: anywhere;
  max-width: min(420px, calc(100vw - 16px));
  box-shadow: 0 3px 10px rgba(0, 0, 0, 0.12);
  pointer-events: none;
}
html.dark .${BUBBLE_CLASS} {
  background: #2c2c2e;
  color: #e5e5e7;
  border-color: #3a3a3c;
  box-shadow: 0 3px 10px rgba(0, 0, 0, 0.4);
}
`;
  document.head.appendChild(style);
}

function buildSentences(unit: HTMLElement, unitIndex: number): SentenceEntry[] {
  return sentenceRanges(unit).map((sentence, index) => ({
    unit,
    unitIndex,
    index,
    text: sentence.text,
    key: sentenceKey(sentence.text),
    range: sentence.range,
  }));
}

/** A one-character range at the caret, used to glue the bubble to the exact
 *  spot the user clicked instead of the whole (possibly multi-line) sentence. */
function caretAnchorRange(caret: CaretHit): Range {
  const node = caret.node;
  const start = Math.max(0, Math.min(caret.offset, node.data.length - 1));
  const end = Math.min(node.data.length, start + 1);
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  return range;
}

export function createSentenceBrowser(
  container: HTMLElement,
  article: HTMLElement,
  params: SentenceParams,
): Browser {
  injectStyles();

  const useHighlight = supportsHighlight();
  const cache: GlossCache = createGlossCache({
    filePath: params.filePath,
    memoryKey: `sentence:${params.tabId ?? "untitled"}`,
    suffix: SENTENCE_FILE_SUFFIX,
  });

  if (!cache.persisted && !memoryHintShown) {
    memoryHintShown = true;
    showToast(translate("glossary.sentenceMemoryOnly"));
  }

  const bubble = document.createElement("div");
  bubble.className = BUBBLE_CLASS;
  bubble.style.display = "none";
  document.body.appendChild(bubble);

  const units = collectParagraphs(article);
  const unitIndex = new Map<HTMLElement, number>();
  for (const unit of units) unitIndex.set(unit.element, unit.index);

  const sentenceCache = new Map<HTMLElement, SentenceEntry[]>();
  const highlightRegistry = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights;
  const HighlightCtor = (globalThis as unknown as { Highlight?: new (range: Range) => unknown })
    .Highlight;

  let destroyed = false;
  let hoverKey = "";
  let anchorEntry: SentenceEntry | null = null;
  let anchorRange: Range | null = null;
  let anchorNode: Text | null = null;
  let requestToken = 0;
  let rafPending = false;

  // Fallback only: sentence fragments wrapped in spans, grouped by sentence id.
  const fallbackSpans = new Map<string, HTMLElement[]>();
  const wrappedUnits = new Set<HTMLElement>();
  let fallbackHoverId = "";
  let idleHandle: number | null = null;

  function sentencesFor(unit: HTMLElement): SentenceEntry[] {
    let entries = sentenceCache.get(unit);
    if (!entries) {
      entries = buildSentences(unit, unitIndex.get(unit) ?? 0);
      sentenceCache.set(unit, entries);
    }
    return entries;
  }

  function sentenceHit(x: number, y: number): { entry: SentenceEntry; caret: CaretHit } | null {
    const caret = caretAtPoint(x, y);
    if (!caret) return null;
    const el = caret.node.parentElement;
    if (!el) return null;
    const unit = el.closest(UNIT_SELECTOR) as HTMLElement | null;
    if (!unit || !unitIndex.has(unit)) return null;
    if (skipTextNode(caret.node, unit)) return null;

    for (const entry of sentencesFor(unit)) {
      if (!entry.range) continue;
      try {
        if (entry.range.comparePoint(caret.node, caret.offset) === 0) {
          return { entry, caret };
        }
      } catch {
        // A stale range (the article changed under it) is ignored.
      }
    }
    return null;
  }

  function clearHover(): void {
    if (!hoverKey) return;
    hoverKey = "";
    highlightRegistry?.delete(HOVER_NAME);
  }

  function setHover(entry: SentenceEntry): void {
    const key = `${entry.unitIndex}:${entry.index}`;
    if (key === hoverKey) return;
    hoverKey = key;
    if (useHighlight && highlightRegistry && HighlightCtor && entry.range) {
      highlightRegistry.set(HOVER_NAME, new HighlightCtor(entry.range));
    }
  }

  function hideBubble(): void {
    requestToken++;
    anchorEntry = null;
    anchorRange = null;
    anchorNode = null;
    bubble.style.display = "none";
    bubble.textContent = "";
  }

  function position(): void {
    if (!anchorRange) return;
    placeBubble(bubble, anchorRange);
  }

  function schedulePosition(): void {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      position();
    });
  }

  async function showBubble(
    entry: SentenceEntry,
    caret: CaretHit,
    toggle = true,
  ): Promise<void> {
    if (!entry.key) return;

    // A second click on the same sentence closes the bubble. Alt+click (and
    // the 朗读 option) keeps it open so repeated pronunciation still shows the
    // translation.
    if (toggle && anchorEntry === entry) {
      hideBubble();
      return;
    }

    anchorEntry = entry;
    anchorRange = caretAnchorRange(caret);
    anchorNode = caret.node;
    bubble.textContent = "…";
    position();

    const request = ++requestToken;
    const cached = cache.get(entry.key);
    if (cached && cached.length > 0) {
      bubble.textContent = cached.join(" ");
      position();
      return;
    }

    await cache.ready;
    if (destroyed || request !== requestToken) return;
    const late = cache.get(entry.key);
    if (late && late.length > 0) {
      bubble.textContent = late.join(" ");
      position();
      return;
    }

    const result = await lookupSentence(entry.key);
    if (destroyed || request !== requestToken) return;
    if (result.ok) {
      bubble.textContent = result.text;
      cache.set(entry.key, [result.text]);
    } else {
      bubble.textContent = translate("glossary.sentenceFailed");
    }
    position();
  }

  /** Alt+click always speaks; with the 朗读 option on, a plain left-click does too. */
  function wantsSpeech(event: MouseEvent): boolean {
    return event.altKey || get(glossarySettings).speakOnClick;
  }

  function handleSentenceClick(
    event: MouseEvent,
    entry: SentenceEntry,
    caret: CaretHit,
  ): void {
    event.preventDefault();
    event.stopPropagation();
    if (wantsSpeech(event)) {
      speakText(entry.text);
      void showBubble(entry, caret, false);
      return;
    }
    void showBubble(entry, caret);
  }

  function onMove(event: MouseEvent): void {
    if (rafPending) return;
    rafPending = true;
    const x = event.clientX;
    const y = event.clientY;
    requestAnimationFrame(() => {
      rafPending = false;
      if (destroyed) return;
      const hit = sentenceHit(x, y);
      if (hit) setHover(hit.entry);
      else clearHover();
    });
  }

  function onLeave(): void {
    clearHover();
  }

  function onClick(event: MouseEvent): void {
    const target = event.target as Element | null;
    const hit = sentenceHit(event.clientX, event.clientY);
    if (hit) {
      handleSentenceClick(event, hit.entry, hit.caret);
      return;
    }
    // Reading mode blocks link navigation, even outside a sentence.
    if (target?.closest?.("a")) {
      event.preventDefault();
      event.stopPropagation();
    }
    hideBubble();
  }

  function onDocumentPointerDown(event: MouseEvent): void {
    const target = event.target as Node | null;
    if (target && container.contains(target)) return;
    hideBubble();
  }

  /** Escape dismisses the open sentence bubble so it stops covering the text. */
  function onKeydown(event: KeyboardEvent): void {
    if (event.key !== "Escape" || bubble.style.display === "none") return;
    event.preventDefault();
    event.stopPropagation();
    hideBubble();
  }

  // --- fallback: wrap sentence fragments in inline spans -------------------
  function clearFallbackHover(): void {
    if (!fallbackHoverId) return;
    for (const span of fallbackSpans.get(fallbackHoverId) ?? []) {
      span.classList.remove(HOVER_CLASS);
    }
    fallbackHoverId = "";
  }

  function fallbackOver(event: MouseEvent): void {
    const span = (event.target as Element | null)?.closest?.(
      `.${SENTENCE_CLASS}`,
    ) as HTMLElement | null;
    const id = span?.dataset.sentenceId;
    if (!id || id === fallbackHoverId) return;
    clearFallbackHover();
    fallbackHoverId = id;
    for (const el of fallbackSpans.get(id) ?? []) el.classList.add(HOVER_CLASS);
  }

  function fallbackOut(event: MouseEvent): void {
    const span = (event.target as Element | null)?.closest?.(
      `.${SENTENCE_CLASS}`,
    ) as HTMLElement | null;
    if (span?.dataset.sentenceId === fallbackHoverId) clearFallbackHover();
  }

  function wrapUnit(unit: HTMLElement, index: number): void {
    const ut = unitText(unit);
    const tokens = tokenizeSentences(ut.text);
    if (tokens.length === 0) return;

    // Which sentence each character belongs to; -1 is inter-sentence space.
    const sentenceAt = new Array<number>(ut.text.length).fill(-1);
    for (let t = 0; t < tokens.length; t++) {
      for (let i = tokens[t].start; i < tokens[t].end; i++) sentenceAt[i] = t;
    }

    for (let n = 0; n < ut.nodes.length; n++) {
      const node = ut.nodes[n];
      const globalStart = ut.starts[n];
      const fragment = document.createDocumentFragment();
      let cursor = 0;
      while (cursor < node.data.length) {
        const id = sentenceAt[globalStart + cursor] ?? -1;
        let end = cursor + 1;
        while (end < node.data.length && (sentenceAt[globalStart + end] ?? -1) === id) {
          end++;
        }
        const piece = node.data.slice(cursor, end);
        if (id < 0) {
          fragment.appendChild(document.createTextNode(piece));
        } else {
          const span = document.createElement("span");
          span.className = SENTENCE_CLASS;
          span.dataset.sentenceId = `${index}:${id}`;
          span.textContent = piece;
          fragment.appendChild(span);
          let list = fallbackSpans.get(`${index}:${id}`);
          if (!list) {
            list = [];
            fallbackSpans.set(`${index}:${id}`, list);
          }
          list.push(span);
        }
        cursor = end;
      }
      node.replaceWith(fragment);
    }

    wrappedUnits.add(unit);
    // Ranges built before the wrapping point at removed text nodes.
    sentenceCache.delete(unit);
  }

  function scheduleIdle(cb: () => void): void {
    const w = window as Window & {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
    };
    if (typeof w.requestIdleCallback === "function") {
      idleHandle = w.requestIdleCallback(cb, { timeout: 300 });
    } else {
      idleHandle = window.setTimeout(cb, 1);
    }
  }

  function buildFallbackSentences(): void {
    let index = 0;
    const step = (): void => {
      idleHandle = null;
      if (destroyed) return;
      const deadline = performance.now() + 10;
      while (index < units.length && performance.now() < deadline) {
        const unit = units[index];
        wrapUnit(unit.element, unit.index);
        index++;
      }
      if (index < units.length) scheduleIdle(step);
    };
    scheduleIdle(step);
  }

  function unwrapFallbackSentences(): void {
    for (const spans of fallbackSpans.values()) {
      for (const span of spans) {
        if (span.isConnected) span.replaceWith(...Array.from(span.childNodes));
      }
    }
    fallbackSpans.clear();
    for (const unit of wrappedUnits) unit.normalize();
    wrappedUnits.clear();
  }

  // --- wiring -------------------------------------------------------------
  if (useHighlight) {
    container.addEventListener("mousemove", onMove, { passive: true });
    container.addEventListener("mouseleave", onLeave);
  } else {
    buildFallbackSentences();
    container.addEventListener("mouseover", fallbackOver);
    container.addEventListener("mouseout", fallbackOut);
  }
  container.addEventListener("click", onClick, true);
  document.addEventListener("pointerdown", onDocumentPointerDown, true);
  document.addEventListener("keydown", onKeydown, true);
  // Capture so scrolls inside the article's own scroll container (which do not
  // bubble to window) still keep the bubble glued to its sentence.
  window.addEventListener("scroll", schedulePosition, { passive: true, capture: true });
  window.addEventListener("resize", schedulePosition);
  // A line-spacing change reflows the article without a resize event; the
  // bubble is positioned from its sentence's rect, so re-glue it.
  window.addEventListener(LAYOUT_CHANGE_EVENT, schedulePosition);

  const observer = new MutationObserver(() => {
    clearHover();
    clearFallbackHover();
    sentenceCache.clear();
    if (anchorNode && !anchorNode.isConnected) hideBubble();
    schedulePosition();
  });
  observer.observe(article, { childList: true, subtree: true, characterData: true });

  return {
    destroy() {
      destroyed = true;
      observer.disconnect();
      container.removeEventListener("mousemove", onMove);
      container.removeEventListener("mouseleave", onLeave);
      container.removeEventListener("mouseover", fallbackOver);
      container.removeEventListener("mouseout", fallbackOut);
      container.removeEventListener("click", onClick, true);
      document.removeEventListener("pointerdown", onDocumentPointerDown, true);
      document.removeEventListener("keydown", onKeydown, true);
      window.removeEventListener("scroll", schedulePosition, true);
      window.removeEventListener("resize", schedulePosition);
      window.removeEventListener(LAYOUT_CHANGE_EVENT, schedulePosition);
      if (!useHighlight) {
        if (idleHandle !== null) {
          const w = window as Window & { cancelIdleCallback?: (id: number) => void };
          if (typeof w.cancelIdleCallback === "function") w.cancelIdleCallback(idleHandle);
          else window.clearTimeout(idleHandle);
        }
        unwrapFallbackSentences();
      }
      highlightRegistry?.delete(HOVER_NAME);
      bubble.remove();
    },
  };
}

/** Svelte action: re-created whenever the mode, tab or file changes. */
export function sentence(node: HTMLElement, params: SentenceParams) {
  let current = params;
  let browser: Browser | null = null;

  function start(): void {
    if (browser || !current.enabled) return;
    const article = node.querySelector<HTMLElement>("article.md-content");
    if (!article) return;
    browser = createSentenceBrowser(node, article, current);
  }

  function stop(): void {
    browser?.destroy();
    browser = null;
  }

  start();

  return {
    update(next: SentenceParams) {
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
