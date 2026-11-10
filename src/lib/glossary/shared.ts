/** DOM helpers shared by the 词 and 句 reading modes.
 *
 *  Both modes decorate the rendered article without touching its layout: a
 *  hover highlight is a `Range` in the CSS Custom Highlight API, and clicks
 *  resolve the caret under the pointer with `caretRangeFromPoint`. Keeping the
 *  hit-testing and bubble placement in one place means the two modes cannot
 *  drift apart.
 */

/** Code and other non-prose elements never get a reading-mode hit. */
export const EXCLUDED_TAGS = new Set([
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

export function supportsHighlight(): boolean {
  return (
    typeof CSS !== "undefined" &&
    "highlights" in CSS &&
    typeof (globalThis as unknown as { Highlight?: unknown }).Highlight === "function"
  );
}

export function excluded(node: Node, root: HTMLElement): boolean {
  let el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  while (el && el !== root) {
    if (EXCLUDED_TAGS.has(el.tagName)) return true;
    if (el.hasAttribute("data-glossary-exclude")) return true;
    el = el.parentElement;
  }
  return false;
}

export function collectTextNodes(root: HTMLElement): Text[] {
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

export interface CaretHit {
  node: Text;
  offset: number;
}

export function caretAtPoint(x: number, y: number): CaretHit | null {
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

/** The range's box, trimmed to the glyphs instead of the line box.
 *
 *  `Range.getBoundingClientRect()` returns the line box, which carries half the
 *  leading above and below the glyphs: at 1.7 line spacing a 17px font leaves
 *  ~6px of empty space under the text, and a bubble glued to that edge floats
 *  visibly below the word. Shortening the box to the glyphs lets "below the
 *  word" mean the line right under the letters. */
export function anchorRect(range: Range): DOMRect {
  const rect = range.getBoundingClientRect();
  const node = range.startContainer;
  const element = node.nodeType === Node.ELEMENT_NODE
    ? (node as Element)
    : node.parentElement;
  if (!element) return rect;
  const style = getComputedStyle(element);
  const lineHeight = parseFloat(style.lineHeight);
  const fontSize = parseFloat(style.fontSize);
  const box = Number.isFinite(lineHeight) && lineHeight > 0
    ? Math.min(lineHeight, rect.height)
    : rect.height;
  const glyph = Number.isFinite(fontSize) && fontSize > 0
    ? Math.min(fontSize, box)
    : box;
  const slack = Math.max(0, (box - glyph) / 2);
  if (slack < 0.5) return rect;
  return new DOMRect(rect.x, rect.y + slack, rect.width, rect.height - slack * 2);
}

/** Keep the bubble glued to the range: one pixel under the glyphs by default,
 *  flipped above when the viewport bottom would clip it, and clamped
 *  horizontally.
 *
 *  `occupied` lists bubbles already on screen (the pinned 词 mode). A bubble
 *  that would overlap one is shifted below it — or above it near the viewport
 *  edge — so neighbouring definitions stay readable. */
export function placeBubbleAt(
  bubble: HTMLElement,
  rect: DOMRect,
  occupied: DOMRect[] = [],
): void {
  if (rect.width === 0 && rect.height === 0) {
    bubble.style.display = "none";
    return;
  }
  bubble.style.display = "block";
  bubble.style.visibility = "hidden";
  const width = bubble.offsetWidth;
  const height = bubble.offsetHeight;
  let left = rect.left + rect.width / 2 - width / 2;
  let top = rect.bottom + 1;
  if (top + height > window.innerHeight - 6) top = rect.top - height - 1;
  if (top < 4) top = rect.bottom + 1;

  if (occupied.length > 0) {
    const gap = 3;
    const overlaps = (candidateTop: number): DOMRect | undefined => {
      const right = left + width;
      const bottom = candidateTop + height;
      return occupied.find(
        (other) =>
          left < other.right + gap &&
          right > other.left - gap &&
          candidateTop < other.bottom + gap &&
          bottom > other.top - gap,
      );
    };
    let hit = overlaps(top);
    // Bounded: pinned bubbles are a handful, and each retry clears one overlap.
    for (let guard = 0; hit && guard < 20; guard++) {
      const below = hit.bottom + gap;
      const above = hit.top - height - gap;
      if (below + height <= window.innerHeight - 6) top = below;
      else if (above >= 4) top = above;
      else break;
      hit = overlaps(top);
    }
  }

  left = Math.max(6, Math.min(left, window.innerWidth - width - 6));
  top = Math.max(4, Math.min(top, window.innerHeight - height - 6));
  bubble.style.left = `${left}px`;
  bubble.style.top = `${top}px`;
  bubble.style.visibility = "visible";
}

export function placeBubble(bubble: HTMLElement, range: Range): void {
  placeBubbleAt(bubble, anchorRect(range));
}
