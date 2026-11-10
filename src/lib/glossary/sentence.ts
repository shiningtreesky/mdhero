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
  anchorRect,
  caretAtPoint,
  placeBubble,
  placeBubbleAt,
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
const PINNED_NAME = "mdhero-sentence-pinned";
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
  /** Keep every clicked sentence's translation on screen (the 钉住 toggle). */
  pinned?: boolean;
}

/** A sentence whose translation stays on screen, like a pinned word. */
interface PinnedSentence {
  entry: SentenceEntry;
  bubble: HTMLDivElement;
  hiddenByUser: boolean;
  /** Guards the async lookup after this sentence is unpinned or destroyed. */
  requestToken: number;
}

/** Pinned ranges of every mounted pane, keyed by owner, so one pane rebuilding
 *  the shared highlight cannot drop the other's sentences. */
const pinnedRanges = new Map<object, Range[]>();

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
  setPinned(on: boolean): void;
}

function injectStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
::highlight(${HOVER_NAME}) { background-color: rgba(234, 179, 8, 0.18); }
::highlight(${PINNED_NAME}) { background-color: rgba(234, 179, 8, 0.18); }
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
  const HighlightCtor = (
    globalThis as unknown as { Highlight?: new (...ranges: Range[]) => unknown }
  ).Highlight;

  let destroyed = false;
  let hoverKey = "";
  let anchorEntry: SentenceEntry | null = null;
  let anchorRange: Range | null = null;
  let anchorNode: Text | null = null;
  let requestToken = 0;
  let rafPending = false;

  let pinned = params.pinned === true;
  /** True while restoring saved pins: those are already in the file. */
  let restoring = false;
  const pinnedSentences = new Map<string, PinnedSentence>();
  const pinnedOwner = {};

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
      positionPinned();
    });
  }

  /** Fill a bubble with the sentence's translation, cache first, model second.
   *  Shared by the hover bubble and every pinned one. */
  async function fillBubble(
    target: HTMLElement,
    entry: SentenceEntry,
    isCurrent: () => boolean,
  ): Promise<void> {
    if (!entry.key) return;
    const cached = cache.get(entry.key);
    if (cached && cached.length > 0) {
      target.textContent = cached.join(" ");
      return;
    }

    await cache.ready;
    if (destroyed || !isCurrent()) return;
    const late = cache.get(entry.key);
    if (late && late.length > 0) {
      target.textContent = late.join(" ");
      return;
    }

    const result = await lookupSentence(entry.key);
    if (destroyed || !isCurrent()) return;
    if (result.ok) {
      target.textContent = result.text;
      cache.set(entry.key, [result.text]);
    } else {
      target.textContent = translate("glossary.sentenceFailed");
    }
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
    await fillBubble(bubble, entry, () => !destroyed && request === requestToken);
    if (destroyed || request !== requestToken) return;
    position();
  }

  // --- pinned sentences ----------------------------------------------------
  function rebuildPinnedHighlight(): void {
    if (!useHighlight || !highlightRegistry || !HighlightCtor) return;
    const ranges: Range[] = [];
    for (const list of pinnedRanges.values()) ranges.push(...list);
    if (ranges.length === 0) {
      highlightRegistry.delete(PINNED_NAME);
      return;
    }
    highlightRegistry.set(PINNED_NAME, new HighlightCtor(...ranges));
  }

  function refreshPinnedRanges(): void {
    if (!useHighlight) return;
    const ranges: Range[] = [];
    for (const pin of pinnedSentences.values()) {
      if (pin.entry.range) ranges.push(pin.entry.range);
    }
    if (ranges.length === 0) pinnedRanges.delete(pinnedOwner);
    else pinnedRanges.set(pinnedOwner, ranges);
    rebuildPinnedHighlight();
  }

  /** Keep every pinned bubble glued to its sentence, avoiding overlaps. */
  function positionPinned(): void {
    const occupied: DOMRect[] = [];
    for (const pin of pinnedSentences.values()) {
      if (pin.hiddenByUser || !pin.entry.range) {
        pin.bubble.style.display = "none";
        continue;
      }
      const rect = anchorRect(pin.entry.range);
      if (
        (rect.width === 0 && rect.height === 0) ||
        rect.bottom < 0 ||
        rect.top > window.innerHeight
      ) {
        pin.bubble.style.display = "none";
        continue;
      }
      placeBubbleAt(pin.bubble, rect, occupied);
      occupied.push(pin.bubble.getBoundingClientRect());
    }
  }

  /** Write the current pins into `.sentences.json`; unpinning is a removal, so
   *  the whole list is replaced. */
  function persistPins(): void {
    cache.setPins(
      [...pinnedSentences.values()].map(({ entry }) => ({
        key: entry.key,
        text: entry.text,
        unitIndex: entry.unitIndex,
        index: entry.index,
      })),
    );
  }

  function pinSentence(entry: SentenceEntry): void {
    if (!entry.range || !entry.key) return;
    const existing = pinnedSentences.get(entry.key);
    if (existing) {
      existing.hiddenByUser = false;
      existing.bubble.style.display = "block";
      positionPinned();
      return;
    }

    const target = document.createElement("div");
    target.className = BUBBLE_CLASS;
    document.body.appendChild(target);
    const pin: PinnedSentence = {
      entry,
      bubble: target,
      hiddenByUser: false,
      requestToken: 0,
    };
    pinnedSentences.set(entry.key, pin);
    const request = ++pin.requestToken;
    void fillBubble(
      target,
      entry,
      () => pinnedSentences.get(entry.key) === pin && pin.requestToken === request,
    ).then(() => positionPinned());
    refreshPinnedRanges();
    positionPinned();
    if (!restoring) persistPins();
  }

  function removePinnedSentence(key: string): void {
    const pin = pinnedSentences.get(key);
    if (!pin) return;
    pin.requestToken++;
    pin.bubble.remove();
    pinnedSentences.delete(key);
    refreshPinnedRanges();
    persistPins();
  }

  function clearPinnedSentences(): void {
    for (const pin of pinnedSentences.values()) {
      pin.requestToken++;
      pin.bubble.remove();
    }
    pinnedSentences.clear();
    refreshPinnedRanges();
  }

  /** Find the sentence a stored pin refers to: same text, preferring the block
   *  it was read in. */
  function findPinnedTarget(key: string, preferredUnit: number): SentenceEntry | null {
    const ordered = [...units].sort((a, b) => {
      if (a.index === preferredUnit) return -1;
      if (b.index === preferredUnit) return 1;
      return 0;
    });
    for (const unit of ordered) {
      for (const entry of sentencesFor(unit.element)) {
        if (entry.key === key) return entry;
      }
    }
    return null;
  }

  /** Re-create the bubbles saved with this document, once the mode is on. */
  function restorePins(): void {
    if (destroyed || !pinned) return;
    const stored = cache.getPins();
    if (stored.length === 0) return;
    restoring = true;
    try {
      for (const pin of stored) {
        const key = typeof pin.key === "string" ? pin.key : "";
        if (!key || pinnedSentences.has(key)) continue;
        const preferredUnit = typeof pin.unitIndex === "number" ? pin.unitIndex : -1;
        const entry = findPinnedTarget(key, preferredUnit);
        if (entry) pinSentence(entry);
      }
    } finally {
      restoring = false;
    }
  }

  function setPinned(on: boolean): void {
    if (pinned === on) return;
    pinned = on;
    hideBubble();
    // Closing the mode hides the bubbles but keeps the file's pins.
    clearPinnedSentences();
    if (on) void cache.ready.then(() => restorePins());
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
    if (pinned) {
      // Ctrl/Cmd+click is the only way to unpin one sentence.
      if (event.ctrlKey || event.metaKey) {
        if (pinnedSentences.has(entry.key)) {
          removePinnedSentence(entry.key);
          return;
        }
      }
      if (wantsSpeech(event)) speakText(entry.text);
      pinSentence(entry);
      return;
    }
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
  // Pins saved with this document come back once the file has been read; the
  // toggle may be flipped either before or after `ready` resolves.
  void cache.ready.then(() => restorePins());

  const observer = new MutationObserver(() => {
    clearHover();
    clearFallbackHover();
    sentenceCache.clear();
    if (anchorNode && !anchorNode.isConnected) hideBubble();
    schedulePosition();
  });
  observer.observe(article, { childList: true, subtree: true, characterData: true });

  return {
    setPinned(on: boolean) {
      setPinned(on);
    },
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
      clearPinnedSentences();
      pinnedRanges.delete(pinnedOwner);
      rebuildPinnedHighlight();
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
      const pinChanged = !!next.pinned !== !!current.pinned;
      current = next;
      if (changed) {
        stop();
        start();
        return;
      }
      if (pinChanged) browser?.setPinned(!!next.pinned);
    },
    destroy() {
      stop();
    },
  };
}
