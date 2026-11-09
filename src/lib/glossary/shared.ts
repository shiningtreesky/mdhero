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

/** Keep the bubble glued to the range: below it by default, flipped above when
 *  the viewport bottom would clip it, and clamped horizontally. */
export function placeBubbleAt(bubble: HTMLElement, rect: DOMRect): void {
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

export function placeBubble(bubble: HTMLElement, range: Range): void {
  placeBubbleAt(bubble, range.getBoundingClientRect());
}
