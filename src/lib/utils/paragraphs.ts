/** Unit model for the reading ("段") mode.
 *
 *  A translatable unit is a prose block of the rendered article: `<p>`, list
 *  items, quotes, headings (`h1`–`h6`) and table cells (`th`/`td`). Code
 *  blocks, frontmatter and media-only blocks never become units.
 *
 *  Each unit is identified by its ordinal in document order plus a hash of its
 *  source text. The ordinal keeps the mapping stable across a reload; the hash
 *  lets the mode re-attach saved translations when the ordinal moves (a new
 *  heading shifts every later unit) and flags a unit whose source changed.
 */

export type UnitKind = "heading" | "paragraph" | "list" | "quote" | "cell";

/** Block elements that can host a unit, in document order. */
export const UNIT_SELECTOR = "p, li, blockquote, h1, h2, h3, h4, h5, h6, th, td";

/** Kept for the existing call sites; both selectors are the same set. */
export const PARAGRAPH_SELECTOR = UNIT_SELECTOR;

/** Elements whose contents are never units. `table` is allowed now: its cells
 *  are units, but a paragraph nested inside a cell still wins (see
 *  `hasNestedParagraph`). */
const EXCLUDED_ANCESTORS = "pre, code, script, style, svg, .frontmatter";

export interface ParagraphEntry {
  index: number;
  element: HTMLElement;
  text: string;
  hash: string;
  kind: UnitKind;
}

/** Whitespace collapses to single spaces so the hash ignores re-wrapping. */
export function normalizeParagraphText(text: string): string {
  return text.replace(/[\s\u00a0]+/g, " ").trim();
}

/** SHA-256 (first 16 hex chars), async because WebCrypto is. Falls back to a
 *  deterministic FNV-1a digest in environments without `crypto.subtle`. */
export async function paragraphHash(text: string): Promise<string> {
  const normalized = normalizeParagraphText(text);
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    const bytes = new TextEncoder().encode(normalized);
    const digest = await subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest))
      .slice(0, 8)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }
  let hash = 0x811c9dc5;
  for (let i = 0; i < normalized.length; i++) {
    hash ^= normalized.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0").repeat(2);
}

/** Text of a unit as the reader sees it. The mode's own UI (the bubble icon
 *  appended to a unit) carries `data-paras-ui` and is stripped first, so a
 *  saved hash never depends on decorations we added ourselves. */
export function paragraphText(element: HTMLElement): string {
  if (!element.querySelector("[data-paras-ui]")) {
    return normalizeParagraphText(element.textContent ?? "");
  }
  const clone = element.cloneNode(true) as HTMLElement;
  clone.querySelectorAll("[data-paras-ui]").forEach((node) => node.remove());
  return normalizeParagraphText(clone.textContent ?? "");
}

/** A cell holding only numbers, currency/math symbols or punctuation has
 *  nothing to translate. */
export function hasTranslatableText(text: string): boolean {
  return /\p{L}/u.test(text);
}

export function unitKind(element: HTMLElement): UnitKind {
  const tag = element.tagName.toLowerCase();
  if (tag === "th" || tag === "td") return "cell";
  if (tag === "li") return "list";
  if (tag === "blockquote") return "quote";
  if (tag === "h1" || tag === "h2" || tag === "h3" || tag === "h4" || tag === "h5" || tag === "h6") {
    return "heading";
  }
  return "paragraph";
}

/** The decisions `collectParagraphs` makes, split out so they can be unit
 *  tested without a DOM. */
export interface ParagraphShape {
  text: string;
  /** Inside `pre`, `code`, frontmatter, … */
  excluded: boolean;
  /** A list item or cell that only wraps a `<p>`: the inner block is the unit. */
  hasNestedParagraph: boolean;
  /** An image, or a link and nothing else. */
  mediaOnly: boolean;
}

export function acceptsParagraph(shape: ParagraphShape): boolean {
  return (
    !shape.excluded &&
    !shape.hasNestedParagraph &&
    !shape.mediaOnly &&
    shape.text.trim().length > 0
  );
}

/** True for blocks that carry no prose: an image, or a link with no other text. */
export function isMediaOnlyParagraph(element: HTMLElement): boolean {
  if (element.querySelector("img, picture, video, audio") && paragraphText(element) === "") {
    return true;
  }
  if (!element.querySelector("a")) return false;
  const clone = element.cloneNode(true) as HTMLElement;
  clone.querySelectorAll("a").forEach((link) => link.remove());
  return normalizeParagraphText(clone.textContent ?? "") === "";
}

function isExcluded(element: HTMLElement, root: HTMLElement): boolean {
  let node: HTMLElement | null = element;
  while (node && node !== root) {
    if (node.matches(EXCLUDED_ANCESTORS)) return true;
    node = node.parentElement;
  }
  return false;
}

/** Units in document order (headings, paragraphs, list items, quotes and table
 *  cells share one numbering space). A container that only wraps another unit
 *  contributes the inner unit, never both. */
export function collectParagraphs(root: HTMLElement): ParagraphEntry[] {
  const blocks = Array.from(root.querySelectorAll<HTMLElement>(UNIT_SELECTOR)).filter(
    (element) => {
      const text = paragraphText(element);
      const kind = unitKind(element);
      // Table cells with only numbers/symbols are not worth translating.
      if (kind === "cell" && !hasTranslatableText(text)) return false;
      return acceptsParagraph({
        text,
        excluded: isExcluded(element, root),
        hasNestedParagraph: element.querySelector(UNIT_SELECTOR) !== null,
        // Headings and cells are prose even when a link wraps their text; a
        // cell with only numbers or symbols was already dropped above.
        mediaOnly:
          kind === "heading" || kind === "cell" ? false : isMediaOnlyParagraph(element),
      });
    },
  );

  return blocks.map((element, index) => ({
    index,
    element,
    text: paragraphText(element),
    hash: "",
    kind: unitKind(element),
  }));
}

/** Fill in the hashes without blocking the main thread. */
export async function hashParagraphs(
  entries: ParagraphEntry[],
  isAborted: () => boolean = () => false,
): Promise<ParagraphEntry[]> {
  const out: ParagraphEntry[] = [];
  for (let i = 0; i < entries.length; i++) {
    if (isAborted()) return out;
    out.push({ ...entries[i], hash: await paragraphHash(entries[i].text) });
    // Yield every so often so scrolling stays smooth on long documents.
    if (i % 12 === 11) await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return out;
}
