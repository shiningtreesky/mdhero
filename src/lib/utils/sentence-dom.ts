/**
 * Sentence-level DOM helpers shared by the 句 reading mode and the read-aloud
 * highlight.
 *
 * Sentences are built per prose block from the rendered text, so inline
 * elements (`<em>`, links, inline code) stay inside one sentence instead of
 * splitting it at every text node. Every character keeps the DOM position it
 * came from, which is what lets a sentence be turned back into a `Range` that
 * spans inline elements — the CSS Custom Highlight API can then paint it
 * without touching the DOM.
 */

import { tokenizeSentences } from "./sentences";

/** Elements whose text never belongs to a sentence unit. Inline `code` is
 *  intentionally kept: it is part of the sentence being translated. */
const SKIP_TAGS = new Set(["PRE", "SCRIPT", "STYLE", "TEXTAREA", "SVG", "MATH"]);

export interface UnitTextOptions {
  /** Leave inline `code` out of the text. The 句 mode keeps it (it is part of
   *  the sentence being translated); the read-aloud highlight drops it, because
   *  the speech extractor never sends code to the engine. */
  skipInlineCode?: boolean;
}

export interface UnitText {
  text: string;
  nodes: Text[];
  /** Global offset of each kept node's first character in `text`. */
  starts: number[];
  /** For every character, the DOM position it came from; null for a synthetic
   *  separator inserted where an excluded node was skipped. */
  positions: Array<{ node: Text; offset: number } | null>;
}

export function skipTextNode(
  node: Text,
  root: HTMLElement,
  options: UnitTextOptions = {},
): boolean {
  let el = node.parentElement;
  while (el && el !== root) {
    if (SKIP_TAGS.has(el.tagName)) return true;
    if (options.skipInlineCode && el.tagName === "CODE") return true;
    if (el.hasAttribute("data-glossary-exclude")) return true;
    if (el.hasAttribute("data-paras-ui")) return true;
    el = el.parentElement;
  }
  return false;
}

/** Concatenate a prose block's text nodes while remembering where every
 *  character came from, so a sentence can be turned back into a `Range` that
 *  spans inline elements. */
export function unitText(unit: HTMLElement, options: UnitTextOptions = {}): UnitText {
  const nodes: Text[] = [];
  const starts: number[] = [];
  const positions: UnitText["positions"] = [];
  let text = "";

  const walker = document.createTreeWalker(unit, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    const textNode = node as Text;
    if (textNode.data.length > 0) {
      if (skipTextNode(textNode, unit, options)) {
        // Keep a separator so words on either side of a skipped node do not
        // fuse; the separator itself has no DOM position.
        if (text && !/\s$/.test(text)) {
          text += " ";
          positions.push(null);
        }
      } else {
        starts.push(text.length);
        nodes.push(textNode);
        for (let i = 0; i < textNode.data.length; i++) {
          text += textNode.data[i];
          positions.push({ node: textNode, offset: i });
        }
      }
    }
    node = walker.nextNode();
  }

  return { text, nodes, starts, positions };
}

export function locateStart(
  ut: UnitText,
  offset: number,
): { node: Text; offset: number } | null {
  for (let i = Math.max(0, offset); i < ut.text.length; i++) {
    const position = ut.positions[i];
    if (position) return position;
  }
  return null;
}

export function locateEnd(
  ut: UnitText,
  offset: number,
): { node: Text; offset: number } | null {
  for (let i = Math.min(offset, ut.text.length) - 1; i >= 0; i--) {
    const position = ut.positions[i];
    if (position) return { node: position.node, offset: position.offset + 1 };
  }
  return null;
}

export interface SentenceRange {
  /** The sentence as it appears in the DOM, without outer whitespace. */
  text: string;
  /** Offsets of the sentence inside the unit's concatenated text. */
  start: number;
  end: number;
  range: Range;
}

/** Every sentence of one prose block, in document order, with the `Range` that
 *  covers it. Fragments without any DOM position are skipped. */
export function sentenceRanges(
  unit: HTMLElement,
  options: UnitTextOptions = {},
): SentenceRange[] {
  const ut = unitText(unit, options);
  const out: SentenceRange[] = [];

  for (const token of tokenizeSentences(ut.text)) {
    const start = locateStart(ut, token.start);
    const end = locateEnd(ut, token.end);
    if (!start || !end) continue;
    const range = document.createRange();
    try {
      range.setStart(start.node, start.offset);
      range.setEnd(end.node, end.offset);
    } catch {
      continue;
    }
    out.push({ text: token.text, start: token.start, end: token.end, range });
  }

  return out;
}
