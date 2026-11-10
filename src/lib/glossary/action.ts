import { get } from "svelte/store";
import { translate } from "$lib/i18n";
import { glossarySettings } from "$lib/stores/glossarySettings";
import { LAYOUT_CHANGE_EVENT } from "$lib/utils/layout";
import { showToast } from "$lib/stores/toast";
import { speakText } from "$lib/tts/word";
import {
  formatPhonetic,
  normalizeWord,
  tokenizeWords,
  type Phonetic,
  type WordToken,
} from "$lib/utils/glossary";
import { createGlossCache, type GlossCache } from "./cache";
import { lookupGloss } from "./lookup";
import {
  caretAtPoint,
  collectTextNodes,
  excluded,
  anchorRect,
  placeBubble,
  placeBubbleAt,
  supportsHighlight,
  type CaretHit,
} from "./shared";

/**
 * Svelte action behind the 词 (reading) mode.
 *
 * Layout must not move, so with the CSS Custom Highlight API available nothing
 * in the article's DOM changes: hover paints `::highlight(mdhero-gloss-hover)`
 * over a `Range`, and clicks find the word under the pointer with
 * `caretRangeFromPoint`. Ranges are computed on demand (one text node at a
 * time), so a huge document costs nothing until the pointer moves.
 *
 * WebViews without the Highlight API (very old Chromium) fall back to wrapping
 * each word in an inline `<span>`; the wrapper carries no styling, so whitespace
 * and reflow stay identical, and words are built in idle-time chunks.
 *
 * Clicking a word shows its gloss; Alt+clicking it — or a plain click when the
 * 朗读 option is enabled — speaks the word through the read-aloud backend while
 * showing the same gloss.
 */

const HOVER_NAME = "mdhero-gloss-hover";
const PINNED_NAME = "mdhero-gloss-pinned";
const STYLE_ID = "mdhero-gloss-style";
const BUBBLE_CLASS = "mdhero-gloss-bubble";
const WORD_CLASS = "mdhero-gloss-word";
const HOVER_CLASS = "mdhero-gloss-hover";
const PINNED_CLASS = "mdhero-gloss-pinned";

let memoryHintShown = false;

/** `CSS.highlights` is global, and both reading panes can run a glossary
 *  action at once. Each action contributes its pinned ranges here; the named
 *  highlight is rebuilt whole so one pane cannot clobber the other. */
const pinnedRanges = new Map<object, Range[]>();

function rebuildPinnedHighlight(
  registry: Map<string, unknown> | undefined,
  Ctor: (new (...ranges: Range[]) => unknown) | undefined,
): void {
  if (!registry || !Ctor) return;
  const ranges: Range[] = [];
  for (const list of pinnedRanges.values()) ranges.push(...list);
  if (ranges.length === 0) {
    registry.delete(PINNED_NAME);
    return;
  }
  registry.set(PINNED_NAME, new Ctor(...ranges));
}

export interface GlossaryParams {
  /** Mode on, reading pane, and the document is English. */
  enabled: boolean;
  /** Identifies the cache; paste/URL tabs use it for the localStorage key. */
  tabId: string | null;
  filePath: string | null;
  /** Keep clicked words' glosses on screen instead of replacing one bubble. */
  pinned?: boolean;
  /** Show IPA instead of the Chinese meaning (the 音 view). */
  phoneticView?: boolean;
}

interface WordHit {
  node: Text;
  token: WordToken;
  range: Range;
}

interface PinnedEntry {
  node: Text;
  token: WordToken;
  range: Range;
  /** Which appearance of the word this is in the document, used to restore it. */
  occurrence: number;
  bubble: HTMLDivElement;
  /** ESC hides every pinned bubble but keeps the entry and its highlight. */
  hiddenByUser: boolean;
  /** Guards the async lookup after this occurrence is unpinned or destroyed. */
  requestToken: number;
}

/** One word appearance in the article, in reading order. */
interface WordPosition {
  node: Text;
  token: WordToken;
  range: Range;
  occurrence: number;
}

interface Browser {
  destroy(): void;
  setPinned(on: boolean): void;
  setPhoneticView(on: boolean): void;
}

function injectStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
::highlight(${HOVER_NAME}) { color: #eab308; }
::highlight(${PINNED_NAME}) { color: #eab308; }
.${WORD_CLASS}.${HOVER_CLASS} { color: #eab308; }
.${WORD_CLASS}.${PINNED_CLASS} { color: #eab308; }
.${BUBBLE_CLASS} {
  position: fixed;
  z-index: 80;
  padding: 1px 2px;
  border-radius: 3px;
  border: 1px solid #e5e5ea;
  background: #fff;
  color: #1c1c1e;
  font-size: 11px;
  line-height: 1.25;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  white-space: normal;
  overflow-wrap: anywhere;
  max-width: min(320px, calc(100vw - 16px));
  box-shadow: 0 3px 10px rgba(0, 0, 0, 0.12);
  pointer-events: none;
}
.${BUBBLE_CLASS}-phonetic {
  margin-bottom: 0;
  color: #636366;
  font-family: "Segoe UI", "Lucida Sans Unicode", "Arial Unicode MS", sans-serif;
  white-space: pre-wrap;
}
html.dark .${BUBBLE_CLASS} {
  background: #2c2c2e;
  color: #e5e5e7;
  border-color: #3a3a3c;
  box-shadow: 0 3px 10px rgba(0, 0, 0, 0.4);
}
html.dark .${BUBBLE_CLASS}-phonetic { color: #aeaeb2; }
`;
  document.head.appendChild(style);
}

function tokenAt(node: Text, offset: number): WordToken | null {
  for (const token of tokenizeWords(node.data)) {
    if (offset >= token.start && offset <= token.end) return token;
  }
  return null;
}

function wordHit(x: number, y: number, root: HTMLElement): WordHit | null {
  const caret = caretAtPoint(x, y);
  if (!caret || excluded(caret.node, root)) return null;
  const token = tokenAt(caret.node, caret.offset);
  if (!token) return null;
  const range = document.createRange();
  range.setStart(caret.node, token.start);
  range.setEnd(caret.node, token.end);
  return { node: caret.node, token, range };
}

export function createGlossaryBrowser(
  container: HTMLElement,
  article: HTMLElement,
  params: GlossaryParams,
): Browser {
  injectStyles();

  const useHighlight = supportsHighlight();
  const cache: GlossCache = createGlossCache({
    filePath: params.filePath,
    memoryKey: params.tabId ?? "untitled",
  });

  if (!cache.persisted && !memoryHintShown) {
    memoryHintShown = true;
    showToast(translate("glossary.memoryOnly"));
  }

  const bubble = document.createElement("div");
  bubble.className = BUBBLE_CLASS;
  bubble.style.display = "none";
  document.body.appendChild(bubble);

  let destroyed = false;
  let hoverKey = "";
  let anchorRange: Range | null = null;
  let anchorNode: Text | null = null;
  let anchorStart = -1;
  /** Last rendered hover bubble contents, so the 音 view can repaint it. */
  let anchorGloss: string | null = null;
  let anchorPhonetic: Phonetic | undefined;
  let requestToken = 0;
  let rafPending = false;
  let pinned = params.pinned === true;
  /** 音 view: bubbles show IPA instead of the gloss. */
  let phoneticView = params.phoneticView === true;
  /** True while restoring saved pins: those are already in the file. */
  let restoring = false;
  const pinnedEntries: PinnedEntry[] = [];
  const pinnedOwner = {};

  const highlightRegistry = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights;
  const HighlightCtor = (globalThis as unknown as { Highlight?: new (range: Range) => unknown }).Highlight;

  function clearHover(): void {
    if (!hoverKey) return;
    hoverKey = "";
    highlightRegistry?.delete(HOVER_NAME);
  }

  function setHover(hit: WordHit): void {
    const key = `${hit.token.start}:${hit.token.end}`;
    if (key === hoverKey) return;
    hoverKey = key;
    if (useHighlight && highlightRegistry && HighlightCtor) {
      highlightRegistry.set(HOVER_NAME, new HighlightCtor(hit.range));
    }
  }

  function hideBubble(): void {
    requestToken++;
    anchorRange = null;
    anchorNode = null;
    anchorStart = -1;
    anchorGloss = null;
    anchorPhonetic = undefined;
    bubble.style.display = "none";
    bubble.textContent = "";
  }

  /** IPA on its own line above the meaning, or on its own in the 音 view. */
  function renderBubbleInto(target: HTMLElement, gloss: string, phonetic?: Phonetic): void {
    target.textContent = "";
    const settings = get(glossarySettings);
    const phoneticLine = phonetic
      ? formatPhonetic(
          phonetic,
          settings.phoneticUk,
          settings.phoneticUs,
          translate("glossary.phoneticUkShort"),
          translate("glossary.phoneticUsShort"),
        )
      : "";
    if (phoneticView) {
      // 音 view: pronunciation only. "…" while the IPA request is in flight.
      if (phoneticLine) {
        const el = document.createElement("div");
        el.className = `${BUBBLE_CLASS}-phonetic`;
        el.textContent = phoneticLine;
        target.appendChild(el);
      } else {
        target.textContent = "…";
      }
      return;
    }
    if (settings.showPhonetic && phoneticLine) {
      const el = document.createElement("div");
      el.className = `${BUBBLE_CLASS}-phonetic`;
      el.textContent = phoneticLine;
      target.appendChild(el);
    }
    const meanings = document.createElement("div");
    meanings.textContent = gloss;
    target.appendChild(meanings);
  }

  function position(): void {
    if (!anchorRange) return;
    placeBubble(bubble, anchorRange);
  }

  /** Publish this pane's ranges into the shared highlight. A handful of ranges
   *  makes a full rebuild cheaper than tracking add/delete calls. */
  function refreshPinnedHighlight(): void {
    if (!useHighlight) return;
    if (pinnedEntries.length === 0) pinnedRanges.delete(pinnedOwner);
    else pinnedRanges.set(pinnedOwner, pinnedEntries.map((entry) => entry.range));
    rebuildPinnedHighlight(highlightRegistry, HighlightCtor);
  }

  function markFallbackPinned(node: Text, on: boolean): void {
    if (useHighlight) return;
    const span = node.parentElement?.closest?.(`.${WORD_CLASS}`) as HTMLElement | null;
    span?.classList.toggle(PINNED_CLASS, on);
  }

  /** Keep every pinned bubble glued to its word. Bubbles that would overlap
   *  are pushed down (or up near the viewport edge) instead of stacking. */
  function positionPinned(): void {
    const occupied: DOMRect[] = [];
    for (const entry of pinnedEntries) {
      if (entry.hiddenByUser) {
        entry.bubble.style.display = "none";
        continue;
      }
      const rect = anchorRect(entry.range);
      if (
        (rect.width === 0 && rect.height === 0) ||
        rect.bottom < 0 ||
        rect.top > window.innerHeight
      ) {
        entry.bubble.style.display = "none";
        continue;
      }
      placeBubbleAt(entry.bubble, rect, occupied);
      occupied.push(entry.bubble.getBoundingClientRect());
    }
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

  async function loadGloss(
    raw: string,
    render: (gloss: string, phonetic?: Phonetic) => void,
    isCurrent: () => boolean,
  ): Promise<void> {
    const key = normalizeWord(raw);
    if (!key) return;
    if (destroyed || !isCurrent()) return;

    // 词 mode always fetches IPA, even when the 音标 option is off: the 音 view
    // must have it ready the moment the reader flips the switch.
    const wantsPhonetic = true;

    const cached = cache.get(key);
    if (cached && cached.length > 0) {
      const cachedPhonetic = cache.getPhonetics(key);
      if (cachedPhonetic !== undefined) {
        render(cached.join(" / "), cachedPhonetic);
        return;
      }
      // A cache written before 音标 was enabled has the gloss but no IPA.
      // Show the gloss immediately and refresh it from the model below.
      render(cached.join(" / "), undefined);
    }

    await cache.ready;
    if (destroyed || !isCurrent()) return;
    const late = cache.get(key);
    const latePhonetic = cache.getPhonetics(key);
    if (late && late.length > 0) {
      if (latePhonetic !== undefined) {
        render(late.join(" / "), latePhonetic);
        return;
      }
      render(late.join(" / "), undefined);
    }

    const result = await lookupGloss(raw, { phonetic: wantsPhonetic });
    if (destroyed || !isCurrent()) return;
    if (result.ok) {
      render(result.text, result.phonetic);
      cache.set(key, result.items, result.phonetic);
    } else if (!late || late.length === 0) {
      render(translate("glossary.lookupFailed"), result.phonetic);
    }
  }

  async function showBubble(
    node: Text,
    token: WordToken,
    range: Range,
    toggle = true,
  ): Promise<void> {
    // A second click on the same occurrence closes the bubble. Alt+click (and
    // the 朗读 option) keeps it open so repeated pronunciation still shows the
    // meaning.
    if (toggle && anchorNode === node && anchorStart === token.start) {
      hideBubble();
      return;
    }

    anchorRange = range;
    anchorNode = node;
    anchorStart = token.start;
    anchorGloss = null;
    anchorPhonetic = undefined;
    bubble.textContent = "…";
    position();

    const request = ++requestToken;
    await loadGloss(
      token.word,
      (gloss, phonetic) => {
        if (request !== requestToken) return;
        anchorGloss = gloss;
        anchorPhonetic = phonetic;
        renderBubbleInto(bubble, gloss, phonetic);
        position();
      },
      () => request === requestToken,
    );
  }

  /** Flip the 音 view and repaint every bubble from the cache. */
  function setPhoneticView(on: boolean): void {
    if (phoneticView === on) return;
    phoneticView = on;
    for (const entry of pinnedEntries) {
      const key = normalizeWord(entry.token.word);
      const gloss = cache.get(key)?.join(" / ") ?? "";
      renderBubbleInto(entry.bubble, gloss || "…", cache.getPhonetics(key));
    }
    if (anchorGloss !== null) {
      renderBubbleInto(bubble, anchorGloss, anchorPhonetic);
    }
    positionPinned();
  }

  function findPinned(node: Text, start: number): PinnedEntry | undefined {
    return pinnedEntries.find((entry) => entry.node === node && entry.token.start === start);
  }

  function removePinned(entry: PinnedEntry): void {
    const index = pinnedEntries.indexOf(entry);
    if (index < 0) return;
    entry.requestToken++;
    pinnedEntries.splice(index, 1);
    entry.bubble.remove();
    markFallbackPinned(entry.node, false);
    refreshPinnedHighlight();
    persistPins();
  }

  function clearPinned(): void {
    for (const entry of pinnedEntries) {
      entry.requestToken++;
      entry.bubble.remove();
      markFallbackPinned(entry.node, false);
    }
    pinnedEntries.length = 0;
    refreshPinnedHighlight();
  }

  async function loadPinned(entry: PinnedEntry): Promise<void> {
    entry.bubble.textContent = "…";
    positionPinned();
    const request = ++entry.requestToken;
    await loadGloss(
      entry.token.word,
      (gloss, phonetic) => {
        if (entry.requestToken !== request) return;
        renderBubbleInto(entry.bubble, gloss, phonetic);
        positionPinned();
      },
      () => entry.requestToken === request && pinnedEntries.includes(entry),
    );
  }

  function pinWord(node: Text, token: WordToken, range: Range, occurrence: number): void {
    const existing = findPinned(node, token.start);
    if (existing) {
      // A plain click after ESC brings the gloss back; it never unpins. Only
      // Ctrl/Cmd+click removes a pinned word.
      existing.hiddenByUser = false;
      positionPinned();
      return;
    }

    const entry: PinnedEntry = {
      node,
      token,
      range,
      occurrence,
      bubble: document.createElement("div"),
      hiddenByUser: false,
      requestToken: 0,
    };
    entry.bubble.className = BUBBLE_CLASS;
    document.body.appendChild(entry.bubble);
    pinnedEntries.push(entry);
    markFallbackPinned(node, true);
    refreshPinnedHighlight();
    void loadPinned(entry);
    if (!restoring) persistPins();
  }

  /** Lazy index of every word appearance, built once per mounted article. */
  let wordIndex: Map<string, WordPosition[]> | null = null;

  function ensureWordIndex(): Map<string, WordPosition[]> {
    if (wordIndex) return wordIndex;
    const index = new Map<string, WordPosition[]>();
    const counts = new Map<string, number>();
    const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node as Text;
      if (!text.data.trim() || excluded(text, article)) continue;
      for (const token of tokenizeWords(text.data)) {
        const key = normalizeWord(token.word);
        if (!key) continue;
        const occurrence = counts.get(key) ?? 0;
        counts.set(key, occurrence + 1);
        const range = document.createRange();
        range.setStart(text, token.start);
        range.setEnd(text, token.end);
        const position: WordPosition = { node: text, token, range, occurrence };
        const list = index.get(key);
        if (list) list.push(position);
        else index.set(key, [position]);
      }
    }
    wordIndex = index;
    return index;
  }

  function occurrenceOf(node: Text, token: WordToken): number {
    const list = ensureWordIndex().get(normalizeWord(token.word)) ?? [];
    const found = list.find(
      (position) => position.node === node && position.token.start === token.start,
    );
    return found?.occurrence ?? 0;
  }

  /** Write the current pins into `.words.json`; unpinning has to be a removal,
   *  so the whole list is replaced. */
  function persistPins(): void {
    cache.setPins(
      pinnedEntries.map((entry) => ({
        word: entry.token.word,
        occurrence: entry.occurrence,
      })),
    );
  }

  /** Re-create the bubbles saved with this document. Only runs while the pin
   *  toggle is on, which is the moment the reader asked for them back. */
  function restorePins(): void {
    if (destroyed || !pinned) return;
    const stored = cache.getPins();
    if (stored.length === 0) return;
    restoring = true;
    try {
      for (const pin of stored) {
        const word = typeof pin.word === "string" ? pin.word : "";
        const occurrence = typeof pin.occurrence === "number" ? pin.occurrence : -1;
        if (!word || occurrence < 0) continue;
        const position = ensureWordIndex().get(normalizeWord(word))?.[occurrence];
        if (!position || findPinned(position.node, position.token.start)) continue;
        pinWord(position.node, position.token, position.range, occurrence);
      }
    } finally {
      restoring = false;
    }
  }

  function setPinned(on: boolean): void {
    if (pinned === on) return;
    pinned = on;
    hideBubble();
    // Closing the mode hides the bubbles but must not erase what was pinned;
    // the file keeps them for the next visit.
    clearPinned();
    if (on) void cache.ready.then(() => restorePins());
  }

  /** Alt+click always speaks; with the 朗读 option on, a plain left-click does too. */
  function wantsSpeech(event: MouseEvent): boolean {
    return event.altKey || get(glossarySettings).speakOnClick;
  }

  function handleWordClick(
    event: MouseEvent,
    node: Text,
    token: WordToken,
    range: Range,
  ): void {
    event.preventDefault();
    event.stopPropagation();

    if (pinned) {
      // Ctrl/Cmd+click is the only way to unpin one occurrence.
      if (event.ctrlKey || event.metaKey) {
        const entry = findPinned(node, token.start);
        if (entry) removePinned(entry);
        return;
      }
      if (wantsSpeech(event)) speakText(token.word);
      pinWord(node, token, range, occurrenceOf(node, token));
      return;
    }

    if (wantsSpeech(event)) {
      // Keep the bubble open on repeated clicks so the definition stays visible
      // while the word is read again.
      speakText(token.word);
      void showBubble(node, token, range, false);
      return;
    }
    void showBubble(node, token, range);
  }

  function onMove(event: MouseEvent): void {
    if (rafPending) return;
    rafPending = true;
    const x = event.clientX;
    const y = event.clientY;
    requestAnimationFrame(() => {
      rafPending = false;
      if (destroyed) return;
      const hit = wordHit(x, y, article);
      if (hit) setHover(hit);
      else clearHover();
    });
  }

  function onLeave(): void {
    clearHover();
  }

  function onClick(event: MouseEvent): void {
    const target = event.target as Element | null;

    // Fallback mode: the word is a wrapper span, so read it from the target.
    if (!useHighlight) {
      const span = target?.closest?.(`.${WORD_CLASS}`) as HTMLElement | null;
      if (span && span.firstChild) {
        const text = span.textContent ?? "";
        const node = span.firstChild as Text;
        const range = document.createRange();
        range.selectNodeContents(span);
        handleWordClick(
          event,
          node,
          { word: span.dataset.word ?? text, start: 0, end: text.length },
          range,
        );
        return;
      }
    }

    const hit = wordHit(event.clientX, event.clientY, article);
    if (hit) {
      handleWordClick(event, hit.node, hit.token, hit.range);
      return;
    }
    // Reading mode blocks link navigation, even between words.
    if (target?.closest?.("a")) {
      event.preventDefault();
      event.stopPropagation();
    }
    // Pinned glosses leave only through Ctrl/Cmd+click or ESC; clicking empty
    // space must not wipe a study session.
    if (!pinned) hideBubble();
  }

  function onDocumentPointerDown(event: MouseEvent): void {
    if (pinned) return;
    const target = event.target as Node | null;
    if (target && container.contains(target)) return;
    hideBubble();
  }

  /** Escape dismisses every open word bubble so it stops covering the text.
   *  Pinned entries stay: their highlights remain and a later click brings the
   *  gloss back. */
  function onKeydown(event: KeyboardEvent): void {
    if (event.key !== "Escape") return;
    const transientVisible = bubble.style.display !== "none";
    const pinnedVisible = pinnedEntries.some((entry) => !entry.hiddenByUser);
    if (!transientVisible && !pinnedVisible) return;
    event.preventDefault();
    event.stopPropagation();
    hideBubble();
    for (const entry of pinnedEntries) {
      entry.hiddenByUser = true;
      entry.bubble.style.display = "none";
    }
  }

  // --- fallback: wrap words in inline spans -------------------------------
  const wrapped: HTMLElement[] = [];
  let idleHandle: number | null = null;

  function wrapTextNode(text: Text): void {
    const tokens = tokenizeWords(text.data);
    if (tokens.length === 0) return;
    const fragment = document.createDocumentFragment();
    let cursor = 0;
    for (const token of tokens) {
      if (token.start > cursor) {
        fragment.appendChild(document.createTextNode(text.data.slice(cursor, token.start)));
      }
      const span = document.createElement("span");
      span.className = WORD_CLASS;
      span.dataset.word = token.word;
      // No styles on the wrapper: it must not change the flow.
      span.textContent = token.word;
      fragment.appendChild(span);
      wrapped.push(span);
      cursor = token.end;
    }
    if (cursor < text.data.length) {
      fragment.appendChild(document.createTextNode(text.data.slice(cursor)));
    }
    text.replaceWith(fragment);
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

  function buildFallbackWords(): void {
    const nodes = collectTextNodes(article);
    let index = 0;
    const step = (): void => {
      idleHandle = null;
      if (destroyed) return;
      const deadline = performance.now() + 10;
      while (index < nodes.length && performance.now() < deadline) {
        wrapTextNode(nodes[index++]);
      }
      if (index < nodes.length) scheduleIdle(step);
    };
    scheduleIdle(step);
  }

  function unwrapFallbackWords(): void {
    for (const span of wrapped) {
      if (!span.isConnected) continue;
      span.replaceWith(...Array.from(span.childNodes));
    }
    wrapped.length = 0;
    article.normalize();
  }

  const fallbackOver = (event: MouseEvent): void => {
    const span = (event.target as Element | null)?.closest?.(`.${WORD_CLASS}`) as HTMLElement | null;
    span?.classList.add(HOVER_CLASS);
  };
  const fallbackOut = (event: MouseEvent): void => {
    const span = (event.target as Element | null)?.closest?.(`.${WORD_CLASS}`) as HTMLElement | null;
    span?.classList.remove(HOVER_CLASS);
  };

  // --- wiring -------------------------------------------------------------
  if (useHighlight) {
    container.addEventListener("mousemove", onMove, { passive: true });
    container.addEventListener("mouseleave", onLeave);
  } else {
    buildFallbackWords();
    container.addEventListener("mouseover", fallbackOver);
    container.addEventListener("mouseout", fallbackOut);
  }
  container.addEventListener("click", onClick, true);
  document.addEventListener("pointerdown", onDocumentPointerDown, true);
  document.addEventListener("keydown", onKeydown, true);
  // Capture so scrolls inside the article's own scroll container (which do not
  // bubble to window) still keep the bubble glued to its word.
  window.addEventListener("scroll", schedulePosition, { passive: true, capture: true });
  window.addEventListener("resize", schedulePosition);
  // Line spacing (and font size) reflow the article without a resize event, and
  // every pinned bubble is positioned from its word's rect: re-glue them.
  window.addEventListener(LAYOUT_CHANGE_EVENT, schedulePosition);
  // Pins saved with this document come back once the file has been read; the
  // toggle may be flipped either before or after `ready` resolves.
  void cache.ready.then(() => restorePins());

  const observer = new MutationObserver(() => {
    clearHover();
    if (anchorRange && !anchorRange.startContainer.isConnected) hideBubble();
    for (let i = pinnedEntries.length - 1; i >= 0; i--) {
      if (!pinnedEntries[i].node.isConnected) removePinned(pinnedEntries[i]);
    }
    schedulePosition();
  });
  observer.observe(article, {
    childList: true,
    subtree: true,
    characterData: true,
    // The article's style attribute carries line spacing and font size: a
    // change there reflows every word, so the pinned bubbles must re-glue.
    attributes: true,
    attributeFilter: ["style"],
  });

  return {
    setPinned(on: boolean) {
      setPinned(on);
    },
    setPhoneticView(on: boolean) {
      setPhoneticView(on);
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
      clearPinned();
      if (!useHighlight) {
        if (idleHandle !== null) {
          const w = window as Window & { cancelIdleCallback?: (id: number) => void };
          if (typeof w.cancelIdleCallback === "function") w.cancelIdleCallback(idleHandle);
          else window.clearTimeout(idleHandle);
        }
        unwrapFallbackWords();
      }
      highlightRegistry?.delete(HOVER_NAME);
      pinnedRanges.delete(pinnedOwner);
      rebuildPinnedHighlight(highlightRegistry, HighlightCtor);
      bubble.remove();
    },
  };
}

/** Svelte action: re-created whenever the mode, tab or file changes. */
export function glossary(node: HTMLElement, params: GlossaryParams) {
  let current = params;
  let browser: Browser | null = null;

  function start(): void {
    if (browser || !current.enabled) return;
    const article = node.querySelector<HTMLElement>("article.md-content");
    if (!article) return;
    browser = createGlossaryBrowser(node, article, current);
  }

  function stop(): void {
    browser?.destroy();
    browser = null;
  }

  start();

  return {
    update(next: GlossaryParams) {
      const changed =
        next.enabled !== current.enabled ||
        next.tabId !== current.tabId ||
        next.filePath !== current.filePath;
      const pinChanged = !!next.pinned !== !!current.pinned;
      const viewChanged = !!next.phoneticView !== !!current.phoneticView;
      current = next;
      if (changed) {
        stop();
        start();
        return;
      }
      if (pinChanged) browser?.setPinned(!!next.pinned);
      if (viewChanged) browser?.setPhoneticView(!!next.phoneticView);
    },
    destroy() {
      stop();
    },
  };
}
