/** Paragraph model for the reading ("段") mode.
 *
 *  Paragraphs are the prose blocks of the rendered article: ordinary `<p>`,
 *  list items and quotes. Headings, code blocks, tables and media-only blocks
 *  (an image, or a link and nothing else) are not translatable units, so they
 *  never become paragraphs.
 *
 *  Each paragraph is identified by its ordinal in the document plus a hash of
 *  its source text. The ordinal keeps the mapping stable across a reload, and
 *  the hash tells the UI when the English source changed under a saved
 *  translation.
 */

/** Block elements that can host a paragraph. */
export const PARAGRAPH_SELECTOR = "p, li, blockquote";

/** Elements whose contents are never paragraphs. */
const EXCLUDED_ANCESTORS = "pre, code, table, script, style, svg, .frontmatter";

export interface ParagraphEntry {
  index: number;
  element: HTMLElement;
  text: string;
  hash: string;
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

/** Text of a paragraph as the reader sees it. The mode's own UI (the bubble
 *  icon appended to a paragraph) carries `data-paras-ui` and is stripped first,
 *  so a saved hash never depends on decorations we added ourselves. */
export function paragraphText(element: HTMLElement): string {
  if (!element.querySelector("[data-paras-ui]")) {
    return normalizeParagraphText(element.textContent ?? "");
  }
  const clone = element.cloneNode(true) as HTMLElement;
  clone.querySelectorAll("[data-paras-ui]").forEach((node) => node.remove());
  return normalizeParagraphText(clone.textContent ?? "");
}

/** The decisions `collectParagraphs` makes, split out so they can be unit
 *  tested without a DOM. */
export interface ParagraphShape {
  text: string;
  /** Inside `pre`, `code`, `table`, frontmatter, … */
  excluded: boolean;
  /** A list item that only wraps a `<p>`: the inner block is the paragraph. */
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

/** Paragraph blocks in document order, innermost first (a list item that only
 *  wraps a `<p>` contributes its `<p>`, not both). */
export function collectParagraphs(root: HTMLElement): ParagraphEntry[] {
  const blocks = Array.from(root.querySelectorAll<HTMLElement>(PARAGRAPH_SELECTOR)).filter(
    (element) => {
      const text = paragraphText(element);
      return acceptsParagraph({
        text,
        excluded: isExcluded(element, root),
        hasNestedParagraph: element.querySelector(PARAGRAPH_SELECTOR) !== null,
        mediaOnly: isMediaOnlyParagraph(element),
      });
    },
  );

  return blocks.map((element, index) => ({
    index,
    element,
    text: paragraphText(element),
    hash: "",
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
