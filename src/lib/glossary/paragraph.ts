import { invoke } from "@tauri-apps/api/core";
import { translate } from "$lib/i18n";
import { speakText } from "$lib/tts/word";
import { LAYOUT_CHANGE_EVENT } from "$lib/utils/layout";
import {
  collectParagraphs,
  hashParagraphs,
  PARAGRAPH_SELECTOR,
  type ParagraphEntry,
} from "$lib/utils/paragraphs";
import { parasCachePath } from "$lib/paras/store";
import { isDiskCacheablePath } from "./cache";
import { lookupSentence } from "./lookup";

/**
 * Svelte action behind 段 mode's *reading* workflow (the default; the answer
 * cards live behind the 回答模式 switch).
 *
 * It is the 句 mode one unit up: hovering highlights a whole paragraph, clicking
 * shows that paragraph's translation in a bubble pinned under the paragraph,
 * and Ctrl/Cmd+click unpins it. Because a paragraph translation is long, the
 * bubble may cover the next paragraph — the reader dismisses it (Ctrl/Cmd) or
 * opens the line spacing when they want to read on.
 *
 * Translations and pins are saved in the document's own `.paras.json` under
 * `reading`, beside the answer-mode items, so reopening the document restores
 * the paragraphs that were being studied.
 */

const HOVER_NAME = "mdhero-para-read-hover";
const STYLE_ID = "mdhero-para-read-style";
const BUBBLE_CLASS = "mdhero-para-read-bubble";

export interface ParagraphReadingParams {
  /** Mode on, reading pane, and the document is English. */
  enabled: boolean;
  /** Identifies the localStorage fallback; paste/URL tabs use it. */
  tabId: string | null;
  filePath: string | null;
  /** Click also reads the paragraph aloud. */
  speak?: boolean;
}

interface Browser {
  destroy(): void;
  setSpeak(on: boolean): void;
}

interface PinnedParagraph {
  entry: ParagraphEntry;
  root: HTMLDivElement;
  text: HTMLSpanElement;
  /** ESC hides every bubble but keeps the paragraph pinned. */
  hidden: boolean;
  /** Guards the async translation after this paragraph is unpinned. */
  requestToken: number;
}

interface ReadingState {
  glosses: Record<string, string[]>;
  pins: Array<{ index: number; hash: string; text: string }>;
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
.${BUBBLE_CLASS} {
  position: fixed;
  z-index: 80;
  pointer-events: none;
  font-size: 11px;
  line-height: 1.25;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
.${BUBBLE_CLASS} > span {
  display: inline;
  padding: 1px 2px;
  border-radius: 3px;
  border: 1px solid #e5e5ea;
  background: #fff;
  color: #1c1c1e;
  overflow-wrap: anywhere;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.12);
  box-decoration-break: clone;
  -webkit-box-decoration-break: clone;
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

function emptyState(): ReadingState {
  return { glosses: {}, pins: [] };
}

function parseReading(text: string | null): ReadingState {
  if (!text) return emptyState();
  try {
    const parsed = JSON.parse(text) as { reading?: unknown } | null;
    const reading = parsed?.reading as
      | { glosses?: unknown; pins?: unknown }
      | undefined;
    if (!reading || typeof reading !== "object") return emptyState();
    const glosses: Record<string, string[]> = {};
    if (reading.glosses && typeof reading.glosses === "object") {
      for (const [key, value] of Object.entries(reading.glosses as Record<string, unknown>)) {
        if (!Array.isArray(value)) continue;
        const items = value.filter((item): item is string => typeof item === "string" && item.length > 0);
        if (items.length > 0) glosses[key] = items;
      }
    }
    const pins: ReadingState["pins"] = [];
    if (Array.isArray(reading.pins)) {
      for (const raw of reading.pins) {
        if (!raw || typeof raw !== "object") continue;
        const value = raw as Record<string, unknown>;
        if (typeof value.index !== "number" || value.index < 0) continue;
        pins.push({
          index: value.index,
          hash: typeof value.hash === "string" ? value.hash : "",
          text: typeof value.text === "string" ? value.text : "",
        });
      }
    }
    return { glosses, pins };
  } catch {
    return emptyState();
  }
}

export function createParagraphReadingBrowser(
  container: HTMLElement,
  article: HTMLElement,
  params: ParagraphReadingParams,
): Browser {
  injectStyles();

  const diskPath = isDiskCacheablePath(params.filePath) ? parasCachePath(params.filePath!) : null;
  const memoryKey = `mdhero:paras-reading:${params.tabId ?? "untitled"}`;
  const useHighlight = supportsHighlight();
  const highlightRegistry = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights;
  const HighlightCtor = (globalThis as unknown as { Highlight?: new () => unknown }).Highlight as
    | (new (...ranges: Range[]) => { add?: (range: Range) => void })
    | undefined;

  let destroyed = false;
  let speak = params.speak === true;
  let state: ReadingState = emptyState();
  let unitByIndex = new Map<number, ParagraphEntry>();
  let unitByElement = new Map<HTMLElement, ParagraphEntry>();
  let ready = false;
  let rafPending = false;
  let hoverKey = -1;
  const pinned = new Map<number, PinnedParagraph>();

  async function readState(): Promise<ReadingState> {
    if (diskPath) {
      try {
        return parseReading(await invoke<string | null>("paras_read", { path: diskPath }));
      } catch {
        return emptyState();
      }
    }
    try {
      return parseReading(globalThis.localStorage?.getItem(memoryKey) ?? null);
    } catch {
      return emptyState();
    }
  }

  function writeState(): void {
    if (!diskPath) {
      try {
        globalThis.localStorage?.setItem(
          memoryKey,
          JSON.stringify({ version: 1, reading: state }),
        );
      } catch {
        // Storage may be unavailable; the session still works.
      }
      return;
    }
    void invoke("paras_reading_store", { path: diskPath, reading: state }).catch(() => {});
  }

  const stateReady = (async () => {
    state = await readState();
    // Hashes are async; wait for them before matching saved pins.
    const entries = await hashParagraphs(collectParagraphs(article));
    unitByIndex = new Map(entries.map((entry) => [entry.index, entry]));
    unitByElement = new Map(entries.map((entry) => [entry.element, entry]));
    ready = true;
    restore();
  })();

  function restore(): void {
    if (destroyed || !ready) return;
    const byHash = new Map<number, ParagraphEntry>();
    for (const entry of unitByIndex.values()) byHash.set(entry.index, entry);
    for (const pin of state.pins) {
      const entry =
        unitByIndex.get(pin.index) ??
        [...unitByIndex.values()].find((candidate) => pin.hash && candidate.hash === pin.hash);
      if (!entry) continue;
      if (pinned.has(entry.index)) continue;
      pinParagraph(entry, true);
    }
  }

  function paragraphAt(x: number, y: number): ParagraphEntry | null {
    const element = document.elementFromPoint(x, y)?.closest?.(PARAGRAPH_SELECTOR) as
      | HTMLElement
      | null;
    if (!element || !article.contains(element)) return null;
    if (element.closest("[data-paras-ui]")) return null;
    return unitByElement.get(element) ?? null;
  }

  function clearHover(): void {
    if (hoverKey < 0) return;
    hoverKey = -1;
    highlightRegistry?.delete(HOVER_NAME);
  }

  function setHover(entry: ParagraphEntry): void {
    if (entry.index === hoverKey) return;
    hoverKey = entry.index;
    if (!useHighlight || !highlightRegistry || !HighlightCtor) return;
    const range = document.createRange();
    range.selectNodeContents(entry.element);
    highlightRegistry.set(HOVER_NAME, new HighlightCtor(range));
  }

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

  function placeParagraphBubble(root: HTMLElement, entry: ParagraphEntry): void {
    const box = readingBox();
    const rect = entry.element.getBoundingClientRect();
    const lineHeight = parseFloat(getComputedStyle(article).lineHeight) || 20;
    const indent = Math.max(0, Math.min(rect.left - box.left, box.width - 1));
    root.style.left = `${box.left}px`;
    root.style.width = `${box.width}px`;
    root.style.textIndent = `${indent}px`;
    root.style.lineHeight = `${lineHeight}px`;
    root.style.display = "block";
    root.style.visibility = "hidden";

    const height = root.offsetHeight;
    let top = rect.bottom;
    if (top + height > window.innerHeight - 6) top = Math.max(4, rect.top - height);
    root.style.top = `${Math.max(4, top)}px`;

    // The inline span's own leading can lift the painted text a couple of
    // pixels; measure once and pull the container back so the text touches the
    // paragraph's bottom edge.
    const span = root.firstElementChild as HTMLElement | null;
    if (span) {
      const placed = Math.max(4, top);
      const drift = placed - span.getBoundingClientRect().top;
      if (Math.abs(drift) > 0.5) root.style.top = `${placed + drift}px`;
    }
    root.style.visibility = "visible";
  }

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

  function positionPinned(): void {
    const placed: DOMRect[] = [];
    const lineHeight = parseFloat(getComputedStyle(article).lineHeight) || 20;
    for (const pin of pinned.values()) {
      if (pin.hidden) {
        pin.root.style.display = "none";
        continue;
      }
      placeParagraphBubble(pin.root, pin.entry);
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

  function schedulePosition(): void {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      if (!destroyed) positionPinned();
    });
  }

  async function fillBubble(target: PinnedParagraph): Promise<void> {
    const { entry } = target;
    const cached = state.glosses[entry.hash];
    if (cached && cached.length > 0) {
      target.text.textContent = cached.join(" ");
      return;
    }
    target.text.textContent = "…";
    const request = ++target.requestToken;
    const result = await lookupSentence(entry.text);
    if (destroyed || target.requestToken !== request || pinned.get(entry.index) !== target) return;
    if (result.ok) {
      target.text.textContent = result.text;
      state.glosses[entry.hash] = [result.text];
      writeState();
    } else {
      target.text.textContent = translate("glossary.sentenceFailed");
    }
  }

  function pinParagraph(entry: ParagraphEntry, restoring = false): PinnedParagraph {
    const root = document.createElement("div");
    root.className = BUBBLE_CLASS;
    const text = document.createElement("span");
    root.appendChild(text);
    document.body.appendChild(root);
    const pin: PinnedParagraph = { entry, root, text, hidden: false, requestToken: 0 };
    pinned.set(entry.index, pin);
    void fillBubble(pin).then(() => {
      if (!destroyed) positionPinned();
    });
    positionPinned();
    if (!restoring) persistPins();
    return pin;
  }

  function removePinned(index: number): void {
    const pin = pinned.get(index);
    if (!pin) return;
    pin.requestToken++;
    pin.root.remove();
    pinned.delete(index);
    persistPins();
  }

  function togglePinned(index: number): void {
    const pin = pinned.get(index);
    if (!pin) return;
    pin.hidden = !pin.hidden;
    pin.root.style.display = pin.hidden ? "none" : "block";
    if (!pin.hidden) positionPinned();
  }

  function clearPinned(): void {
    for (const pin of pinned.values()) {
      pin.requestToken++;
      pin.root.remove();
    }
    pinned.clear();
  }

  function persistPins(): void {
    state.pins = [...pinned.values()].map(({ entry }) => ({
      index: entry.index,
      hash: entry.hash,
      text: entry.text,
    }));
    writeState();
  }

  function onMove(event: MouseEvent): void {
    if (rafPending) return;
    rafPending = true;
    const x = event.clientX;
    const y = event.clientY;
    requestAnimationFrame(() => {
      rafPending = false;
      if (destroyed) return;
      const entry = paragraphAt(x, y);
      if (entry) setHover(entry);
      else clearHover();
    });
  }

  function onClick(event: MouseEvent): void {
    const entry = paragraphAt(event.clientX, event.clientY);
    if (!entry) return;
    event.preventDefault();
    event.stopPropagation();
    if (pinned.has(entry.index)) {
      if (event.ctrlKey || event.metaKey) removePinned(entry.index);
      else togglePinned(entry.index);
      return;
    }
    pinParagraph(entry);
    if (speak && entry.text) speakText(entry.text);
  }

  function onLeave(): void {
    clearHover();
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key !== "Escape") return;
    const visible = [...pinned.values()].filter((pin) => !pin.hidden);
    if (visible.length === 0) return;
    event.preventDefault();
    event.stopPropagation();
    for (const pin of visible) {
      pin.hidden = true;
      pin.root.style.display = "none";
    }
  }

  container.addEventListener("mousemove", onMove, { passive: true });
  container.addEventListener("mouseleave", onLeave);
  container.addEventListener("click", onClick, true);
  window.document.addEventListener("keydown", onKeydown, true);
  window.addEventListener("resize", schedulePosition);
  window.addEventListener("scroll", schedulePosition, { passive: true, capture: true });
  window.addEventListener(LAYOUT_CHANGE_EVENT, schedulePosition);

  void stateReady;

  return {
    setSpeak(on: boolean) {
      speak = on;
    },
    destroy() {
      destroyed = true;
      clearHover();
      clearPinned();
      highlightRegistry?.delete(HOVER_NAME);
      container.removeEventListener("mousemove", onMove);
      container.removeEventListener("mouseleave", onLeave);
      container.removeEventListener("click", onClick, true);
      window.document.removeEventListener("keydown", onKeydown, true);
      window.removeEventListener("resize", schedulePosition);
      window.removeEventListener("scroll", schedulePosition, true);
      window.removeEventListener(LAYOUT_CHANGE_EVENT, schedulePosition);
    },
  };
}

/** Svelte action: re-created whenever the mode, tab, file or workflow changes. */
export function paragraphReading(node: HTMLElement, params: ParagraphReadingParams) {
  let current = params;
  let browser: Browser | null = null;

  function start(): void {
    if (browser || !current.enabled) return;
    const article = node.querySelector<HTMLElement>("article.md-content");
    if (!article) return;
    browser = createParagraphReadingBrowser(node, article, current);
  }

  function stop(): void {
    browser?.destroy();
    browser = null;
  }

  start();

  return {
    update(next: ParagraphReadingParams) {
      const changed =
        next.enabled !== current.enabled ||
        next.tabId !== current.tabId ||
        next.filePath !== current.filePath;
      const speakChanged = !!next.speak !== !!current.speak;
      current = next;
      if (changed) {
        stop();
        start();
        return;
      }
      if (speakChanged) browser?.setSpeak(!!next.speak);
    },
    destroy() {
      stop();
    },
  };
}
