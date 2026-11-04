import { translate } from "$lib/i18n";
import { showToast } from "$lib/stores/toast";
import { normalizeWord, tokenizeWords, type WordToken } from "$lib/utils/glossary";
import { createGlossCache, type GlossCache } from "./cache";
import { lookupGloss } from "./lookup";

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
 */

const HOVER_NAME = "mdhero-gloss-hover";
const STYLE_ID = "mdhero-gloss-style";
const BUBBLE_CLASS = "mdhero-gloss-bubble";
const WORD_CLASS = "mdhero-gloss-word";
const HOVER_CLASS = "mdhero-gloss-hover";

/** Code and other non-prose elements never get a gloss. */
const EXCLUDED_TAGS = new Set([
  "PRE",
  "CODE",
  "KBD",
  "SAMP",
  "SCRIPT",
  "STYLE",
  "TEXTAREA",
  "SVG",
  "MATH",
  "INPUT",
]);

let memoryHintShown = false;

export interface GlossaryParams {
  /** Mode on, reading pane, and the document is English. */
  enabled: boolean;
  /** Identifies the cache; paste/URL tabs use it for the localStorage key. */
  tabId: string | null;
  filePath: string | null;
}

interface WordHit {
  node: Text;
  token: WordToken;
  range: Range;
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
::highlight(${HOVER_NAME}) { color: #eab308; }
.${WORD_CLASS}.${HOVER_CLASS} { color: #eab308; }
.${BUBBLE_CLASS} {
  position: fixed;
  z-index: 80;
  padding: 2px 6px;
  border-radius: 6px;
  border: 1px solid #e5e5ea;
  background: #fff;
  color: #1c1c1e;
  font-size: 11px;
  line-height: 1.4;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  white-space: nowrap;
  max-width: 280px;
  overflow: hidden;
  text-overflow: ellipsis;
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

function excluded(node: Node, root: HTMLElement): boolean {
  let el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  while (el && el !== root) {
    if (EXCLUDED_TAGS.has(el.tagName)) return true;
    if (el.hasAttribute("data-glossary-exclude")) return true;
    el = el.parentElement;
  }
  return false;
}

function collectTextNodes(root: HTMLElement): Text[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const out: Text[] = [];
  let node = walker.nextNode();
  while (node) {
    const text = node as Text;
    if (text.data.length > 0 && !excluded(text, root)) out.push(text);
    node = walker.nextNode();
  }
  return out;
}

interface CaretHit {
  node: Text;
  offset: number;
}

function caretAtPoint(x: number, y: number): CaretHit | null {
  const doc = document as Document & {
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  };
  let range: Range | null = null;
  if (typeof doc.caretRangeFromPoint === "function") {
    range = doc.caretRangeFromPoint(x, y);
  } else if (typeof doc.caretPositionFromPoint === "function") {
    const position = doc.caretPositionFromPoint(x, y);
    if (position) {
      range = document.createRange();
      range.setStart(position.offsetNode, position.offset);
    }
  }
  if (!range) return null;
  const node = range.startContainer;
  if (node.nodeType !== Node.TEXT_NODE) return null;
  return { node: node as Text, offset: range.startOffset };
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

/** Keep the bubble glued to the word: below it by default, flipped above when
 *  the viewport bottom would clip it, and clamped horizontally. */
function placeBubble(bubble: HTMLElement, range: Range): void {
  const rect = range.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) {
    bubble.style.display = "none";
    return;
  }
  bubble.style.display = "block";
  bubble.style.visibility = "hidden";
  const width = bubble.offsetWidth;
  const height = bubble.offsetHeight;
  let left = rect.left + rect.width / 2 - width / 2;
  let top = rect.bottom + 4;
  if (top + height > window.innerHeight - 6) top = rect.top - height - 4;
  if (top < 4) top = rect.bottom + 4;
  left = Math.max(6, Math.min(left, window.innerWidth - width - 6));
  bubble.style.left = `${left}px`;
  bubble.style.top = `${top}px`;
  bubble.style.visibility = "visible";
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
  let requestToken = 0;
  let rafPending = false;

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

  async function showBubble(node: Text, token: WordToken, range: Range): Promise<void> {
    const raw = token.word;
    const key = normalizeWord(raw);
    if (!key) return;

    // A second click on the same occurrence closes the bubble.
    if (anchorNode === node && anchorStart === token.start) {
      hideBubble();
      return;
    }

    anchorRange = range;
    anchorNode = node;
    anchorStart = token.start;
    bubble.textContent = "…";
    position();

    const request = ++requestToken;
    const cached = cache.get(key);
    if (cached && cached.length > 0) {
      bubble.textContent = cached.join(" / ");
      position();
      return;
    }

    await cache.ready;
    if (destroyed || request !== requestToken) return;
    const late = cache.get(key);
    if (late && late.length > 0) {
      bubble.textContent = late.join(" / ");
      position();
      return;
    }

    const result = await lookupGloss(raw);
    if (destroyed || request !== requestToken) return;
    if (result.ok) {
      bubble.textContent = result.text;
      cache.set(key, result.items);
    } else {
      bubble.textContent = translate("glossary.lookupFailed");
    }
    position();
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
        event.preventDefault();
        event.stopPropagation();
        void showBubble(node, { word: span.dataset.word ?? text, start: 0, end: text.length }, range);
        return;
      }
    }

    const hit = wordHit(event.clientX, event.clientY, article);
    if (hit) {
      event.preventDefault();
      event.stopPropagation();
      void showBubble(hit.node, hit.token, hit.range);
      return;
    }
    // Reading mode blocks link navigation, even between words.
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
  // Capture so scrolls inside the article's own scroll container (which do not
  // bubble to window) still keep the bubble glued to its word.
  window.addEventListener("scroll", schedulePosition, { passive: true, capture: true });
  window.addEventListener("resize", schedulePosition);

  const observer = new MutationObserver(() => {
    clearHover();
    if (anchorRange && !anchorRange.startContainer.isConnected) hideBubble();
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
      window.removeEventListener("scroll", schedulePosition, true);
      window.removeEventListener("resize", schedulePosition);
      if (!useHighlight) {
        if (idleHandle !== null) {
          const w = window as Window & { cancelIdleCallback?: (id: number) => void };
          if (typeof w.cancelIdleCallback === "function") w.cancelIdleCallback(idleHandle);
          else window.clearTimeout(idleHandle);
        }
        unwrapFallbackWords();
      }
      highlightRegistry?.delete(HOVER_NAME);
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
