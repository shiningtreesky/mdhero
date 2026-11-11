import { get } from "svelte/store";
import { translate } from "$lib/i18n";
import { glossarySettings } from "$lib/stores/glossarySettings";
import { LAYOUT_CHANGE_EVENT, PIN_ALL_SENTENCES_EVENT } from "$lib/utils/layout";
import { showToast } from "$lib/stores/toast";
import { speakText } from "$lib/tts/word";
import { collectParagraphs, UNIT_SELECTOR } from "$lib/utils/paragraphs";
import { sentenceKey, tokenizeSentences } from "$lib/utils/sentences";
import { sentenceRanges, skipTextNode, unitText } from "$lib/utils/sentence-dom";
import { looping, startLoop, stopLoop } from "$lib/tts/loop";
import { SENTENCE_FILE_SUFFIX, createGlossCache, type GlossCache } from "./cache";
import { lookupSentence } from "./lookup";
import {
  anchorRect,
  caretAtPoint,
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
/** The sentence that is repeating; a warmer colour than the pinned wash so it
 *  stands out among pinned sentences. */
const LOOP_NAME = "mdhero-sentence-loop";
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
  /** Repeat clicked sentences until clicked again. */
  loop?: boolean;
  /** Bumped by the 句 button: pin and translate every sentence in this pane. */
  pinAll?: number;
}

/** A sentence whose translation stays on screen, like a pinned word. */
interface PinnedSentence {
  entry: SentenceEntry;
  root: HTMLDivElement;
  text: HTMLSpanElement;
  hiddenByUser: boolean;
  /** Guards the async lookup after this sentence is unpinned or destroyed. */
  requestToken: number;
}

/** A sentence bubble: the fixed container that carries the stepped layout, and
 *  the inline span that carries the backing so each wrapped line is covered on
 *  its own. */
interface SentenceBubble {
  root: HTMLDivElement;
  text: HTMLSpanElement;
}

function createSentenceBubble(): SentenceBubble {
  const root = document.createElement("div");
  root.className = BUBBLE_CLASS;
  root.style.display = "none";
  const text = document.createElement("span");
  root.appendChild(text);
  document.body.appendChild(root);
  return { root, text };
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
  setLoop(on: boolean): void;
  /** Pin and translate every sentence of this pane, one at a time. */
  pinAll(): void;
}

function injectStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
::highlight(${HOVER_NAME}) { background-color: rgba(234, 179, 8, 0.18); }
::highlight(${PINNED_NAME}) { background-color: rgba(234, 179, 8, 0.18); }
::highlight(${LOOP_NAME}) { background-color: rgba(245, 158, 11, 0.42); }
.${BUBBLE_CLASS}.playing > span {
  background: #fef3c7;
  border-color: #f59e0b;
  box-shadow: 0 0 0 2px rgba(245, 158, 11, 0.4);
}
html.dark .${BUBBLE_CLASS}.playing > span {
  background: #3a2f12;
  border-color: #b45309;
  box-shadow: 0 0 0 2px rgba(245, 158, 11, 0.35);
}
.${SENTENCE_CLASS}.${HOVER_CLASS} { background-color: rgba(234, 179, 8, 0.18); border-radius: 3px; }
/* The translation is laid out as a "step": the first line starts under the
   sentence, later lines return to the column's left edge. The backing lives on
   the inline span so it covers only the text — a block background would cover
   the empty left part of the first line and hide the words underneath it.
   Type metrics match the 词 bubble exactly. */
.${BUBBLE_CLASS} {
  position: fixed;
  z-index: 80;
  pointer-events: none;
  /* The container sits on <body>, so without these it would inherit the page's
     larger type metrics and grow taller than the text it holds — a bubble a few
     pixels too tall then covers the line underneath. */
  font-size: 11px;
  line-height: 1.25;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  /* left / top / width / text-indent are written while placing. */
}
.${BUBBLE_CLASS} > span {
  display: inline;
  padding: 1px 2px;
  border-radius: 3px;
  border: 1px solid #e5e5ea;
  background: #fff;
  color: #1c1c1e;
  font-size: 11px;
  line-height: 1.25;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  overflow-wrap: anywhere;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.12);
  box-decoration-break: clone;
  -webkit-box-decoration-break: clone;
  /* Each line sits at the top of its line box, so it lands on the upper edge of
     the gap under the English line rather than floating in the middle. */
  vertical-align: top;
}
html.dark .${BUBBLE_CLASS} > span {
  background: #2c2c2e;
  color: #e5e5e7;
  border-color: #3a3a3c;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.4);
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

  const hoverBubble = createSentenceBubble();

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
  let loopEnabled = params.loop === true;
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
    hoverBubble.root.style.display = "none";
    hoverBubble.text.textContent = "";
  }

  /** The reading column's content box, in viewport coordinates. */
  function readingBox(): { left: number; width: number } {
    const style = getComputedStyle(article);
    const padLeft = parseFloat(style.paddingLeft) || 0;
    const padRight = parseFloat(style.paddingRight) || 0;
    const rect = article.getBoundingClientRect();
    return {
      left: rect.left + padLeft,
      width: Math.max(240, article.clientWidth - padLeft - padRight),
    };
  }

  /**
   * Lay the translation out as a step: the first line starts under the
   * sentence's first word and runs to the column's right edge, and the rest
   * wraps onto the next line at the column's left edge. The backing lives on
   * the inline span, so the empty left part of the first line covers nothing.
   */
  function placeSentenceBubble(
    root: HTMLElement,
    rect: DOMRect,
    occupied: DOMRect[] = [],
  ): void {
    const box = readingBox();
    const indent = Math.max(0, Math.min(rect.left - box.left, box.width - 1));
    // The article's leading, reused as the bubble's line box height: the second
    // translation line then lands in the next gap instead of on the English
    // line below the first one.
    const lineHeight = parseFloat(getComputedStyle(article).lineHeight) || 20;
    root.style.left = `${box.left}px`;
    root.style.width = `${box.width}px`;
    root.style.textIndent = `${indent}px`;
    root.style.lineHeight = `${lineHeight}px`;
    root.style.display = "block";
    root.style.visibility = "hidden";

    const height = root.offsetHeight;
    // No gap: the translation's top edge touches the English line's bottom.
    let top = rect.bottom;
    if (top + height > window.innerHeight - 6) top = rect.top - height;
    if (top < 4) top = 4;

    if (occupied.length > 0) {
      const gap = 3;
      const overlaps = (candidate: number): DOMRect | undefined => {
        const right = box.left + box.width;
        const bottom = candidate + height;
        return occupied.find(
          (other) =>
            box.left < other.right + gap &&
            right > other.left - gap &&
            candidate < other.bottom + gap &&
            bottom > other.top - gap,
        );
      };
      let hit = overlaps(top);
      for (let guard = 0; hit && guard < 20; guard++) {
        const below = hit.bottom + gap;
        const above = hit.top - height - gap;
        if (below + height <= window.innerHeight - 6) top = below;
        else if (above >= 4) top = above;
        else break;
        hit = overlaps(top);
      }
    }

    root.style.top = `${Math.max(4, top)}px`;
    // The inline span carries its own leading, so with `vertical-align: top` it
    // can sit a couple of pixels above the container's top edge. Measure once
    // and pull the container back so the painted text starts exactly at the
    // upper edge of the gap.
    const span = root.firstElementChild as HTMLElement | null;
    if (span) {
      const placed = Math.max(4, top);
      const drift = placed - span.getBoundingClientRect().top;
      if (Math.abs(drift) > 0.5) root.style.top = `${placed + drift}px`;
    }
    root.style.visibility = "visible";
  }

  /** The box of the sentence's *first* line.
   *
   *  Bubbles hang under the line a sentence starts on, not under its last line:
   *  a wrapped sentence would otherwise push its note one line lower for every
   *  line it wraps, so the translation drifts away from the words it explains.
   *  `getClientRects()[0]` is that first line, and its left edge is the first
   *  word — both the anchor and the step's indent come from it. */
  function firstLineRect(range: Range): DOMRect {
    const rects = range.getClientRects();
    return rects.length > 0 ? rects[0] : range.getBoundingClientRect();
  }

  function position(): void {
    if (!anchorRange) return;
    const line = anchorEntry?.range ? firstLineRect(anchorEntry.range) : anchorRect(anchorRange);
    placeSentenceBubble(hoverBubble.root, line);
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
    target: SentenceBubble,
    entry: SentenceEntry,
    isCurrent: () => boolean,
  ): Promise<void> {
    if (!entry.key) return;
    target.root.style.display = "block";
    target.text.textContent = "…";
    const cached = cache.get(entry.key);
    if (cached && cached.length > 0) {
      target.text.textContent = cached.join(" ");
      return;
    }

    await cache.ready;
    if (destroyed || !isCurrent()) return;
    const late = cache.get(entry.key);
    if (late && late.length > 0) {
      target.text.textContent = late.join(" ");
      return;
    }

    const result = await lookupSentence(entry.key);
    if (destroyed || !isCurrent()) return;
    if (result.ok) {
      target.text.textContent = result.text;
      cache.set(entry.key, [result.text]);
    } else {
      target.text.textContent = translate("glossary.sentenceFailed");
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
    hoverBubble.root.style.display = "block";
    hoverBubble.text.textContent = "…";
    position();

    const request = ++requestToken;
    await fillBubble(hoverBubble, entry, () => !destroyed && request === requestToken);
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

  /** The painted rectangles of a bubble, one per text line. A single union rect
   *  would span the whole column as soon as the first line is indented, and
   *  would then collide with neighbours it never actually touches. */
  function bubbleRects(root: HTMLElement): DOMRect[] {
    const span = root.firstElementChild as HTMLElement | null;
    if (!span) return [root.getBoundingClientRect()];
    const rects = span.getClientRects();
    return rects.length > 0 ? Array.from(rects) : [span.getBoundingClientRect()];
  }

  function lineOverlaps(line: DOMRect, placed: DOMRect[], gap = 3): boolean {
    return placed.some(
      (other) =>
        line.left < other.right + gap &&
        line.right > other.left - gap &&
        line.top < other.bottom + gap &&
        line.bottom > other.top - gap,
    );
  }

  /** Keep every pinned bubble glued to its own sentence. A bubble whose text
   *  would land on another bubble's text is nudged down one line at a time. */
  function positionPinned(): void {
    const placed: DOMRect[] = [];
    const lineHeight = parseFloat(getComputedStyle(article).lineHeight) || 20;
    for (const pin of pinnedSentences.values()) {
      if (pin.hiddenByUser || !pin.entry.range) {
        pin.root.style.display = "none";
        continue;
      }
      const line = firstLineRect(pin.entry.range);
      if (
        (line.width === 0 && line.height === 0) ||
        line.bottom < 0 ||
        line.top > window.innerHeight
      ) {
        pin.root.style.display = "none";
        continue;
      }
      placeSentenceBubble(pin.root, line);
      let rects = bubbleRects(pin.root);
      for (let guard = 0; guard < 12 && rects.some((rect) => lineOverlaps(rect, placed)); guard++) {
        const top = parseFloat(pin.root.style.top || "0") + Math.round(lineHeight);
        if (top + pin.root.offsetHeight > window.innerHeight - 4) break;
        pin.root.style.top = `${top}px`;
        rects = bubbleRects(pin.root);
      }
      placed.push(...rects);
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

  /** Create the bubble for a sentence. `fill` is false when the caller wants to
   *  await the translation itself (the 一键钉住 pass below). */
  function pinSentence(entry: SentenceEntry, fill = true): PinnedSentence | null {
    if (!entry.range || !entry.key) return null;
    const existing = pinnedSentences.get(entry.key);
    if (existing) {
      existing.hiddenByUser = false;
      existing.root.style.display = "block";
      positionPinned();
      return existing;
    }

    const target = createSentenceBubble();
    const pin: PinnedSentence = {
      entry,
      root: target.root,
      text: target.text,
      hiddenByUser: false,
      requestToken: 0,
    };
    pinnedSentences.set(entry.key, pin);
    if (fill) {
      const request = ++pin.requestToken;
      void fillBubble(
        target,
        entry,
        () => pinnedSentences.get(entry.key) === pin && pin.requestToken === request,
      ).then(() => positionPinned());
    }
    refreshPinnedRanges();
    positionPinned();
    if (!restoring) persistPins();
    return pin;
  }

  /** 句 button: pin every sentence of this pane, one translation at a time.
   *  Sequential on purpose — a document's sentences go through the endpoint in
   *  reading order instead of a burst of parallel requests. */
  let pinningAll = false;

  async function pinAllSentences(): Promise<void> {
    if (destroyed || pinningAll || !pinned) return;
    pinningAll = true;
    // Batch: `pinSentence` skips the per-sentence file write, one write follows.
    restoring = true;
    try {
      for (const unit of units) {
        for (const entry of sentencesFor(unit.element)) {
          if (destroyed) return;
          if (!entry.range || !entry.key || pinnedSentences.has(entry.key)) continue;
          const pin = pinSentence(entry, false);
          if (!pin) continue;
          await fillBubble(pin, entry, () => pinnedSentences.get(entry.key) === pin);
          if (destroyed) return;
          positionPinned();
        }
      }
    } finally {
      restoring = false;
      pinningAll = false;
      if (!destroyed) persistPins();
    }
  }

  function removePinnedSentence(key: string): void {
    const pin = pinnedSentences.get(key);
    if (!pin) return;
    pin.requestToken++;
    pin.root.remove();
    pinnedSentences.delete(key);
    refreshPinnedRanges();
    persistPins();
  }

  function clearPinnedSentences(): void {
    for (const pin of pinnedSentences.values()) {
      pin.requestToken++;
      pin.root.remove();
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

  /** Paint the repeating sentence — a warm highlight plus its translation
   *  bubble — so it is distinguishable from the pinned wash around it. */
  function syncLoopHighlight(): void {
    const target = get(looping);
    const key = target?.key.startsWith("s:") ? target.key.slice(2) : null;
    let range: Range | null = null;
    if (key) {
      const pin = pinnedSentences.get(key);
      if (pin?.entry.range) range = pin.entry.range;
      else if (anchorEntry?.key === key && anchorEntry.range) range = anchorEntry.range;
    }
    if (useHighlight && highlightRegistry && HighlightCtor) {
      if (range) highlightRegistry.set(LOOP_NAME, new HighlightCtor(range));
      else highlightRegistry.delete(LOOP_NAME);
    }
    for (const pin of pinnedSentences.values()) {
      pin.root.classList.toggle("playing", !!key && pin.entry.key === key);
    }
    hoverBubble.root.classList.toggle("playing", !!key && anchorEntry?.key === key);
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
    if (loopEnabled) {
      const key = `s:${entry.key}`;
      // A second click on the repeating sentence stops it; another sentence
      // takes over the loop.
      if (get(looping)?.key === key) {
        stopLoop();
        syncLoopHighlight();
        return;
      }
      startLoop({ key, text: entry.text });
    }
    if (pinned) {
      // Ctrl/Cmd+click is the only way to unpin one sentence.
      if (event.ctrlKey || event.metaKey) {
        if (pinnedSentences.has(entry.key)) {
          removePinnedSentence(entry.key);
          return;
        }
      }
      if (wantsSpeech(event) && !loopEnabled) speakText(entry.text);
      pinSentence(entry);
      syncLoopHighlight();
      return;
    }
    if (wantsSpeech(event) && !loopEnabled) {
      speakText(entry.text);
      void showBubble(entry, caret, false);
      syncLoopHighlight();
      return;
    }
    void showBubble(entry, caret);
    syncLoopHighlight();
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
    if (event.key !== "Escape" || hoverBubble.root.style.display === "none") return;
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
  // The 句 button: only the pane showing that tab answers.
  function onPinAllRequest(event: Event): void {
    const detail = (event as CustomEvent<{ tabId?: string | null }>).detail;
    if (!params.tabId || detail?.tabId !== params.tabId) return;
    void pinAllSentences();
  }
  window.addEventListener(PIN_ALL_SENTENCES_EVENT, onPinAllRequest);
  const unsubscribeLoop = looping.subscribe(() => syncLoopHighlight());
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
    setLoop(on: boolean) {
      loopEnabled = on;
    },
    pinAll() {
      void pinAllSentences();
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
      window.removeEventListener(PIN_ALL_SENTENCES_EVENT, onPinAllRequest);
      unsubscribeLoop();
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
      highlightRegistry?.delete(LOOP_NAME);
      hoverBubble.root.remove();
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
      const loopChanged = !!next.loop !== !!current.loop;
      const pinAllBumped = (next.pinAll ?? 0) !== (current.pinAll ?? 0);
      current = next;
      if (changed) {
        stop();
        start();
        return;
      }
      if (pinChanged) browser?.setPinned(!!next.pinned);
      if (loopChanged) browser?.setLoop(!!next.loop);
      if (pinAllBumped) browser?.pinAll();
    },
    destroy() {
      stop();
    },
  };
}
