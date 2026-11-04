/**
 * Pure helpers behind the toolbar's reading ("词") mode: word splitting, cache
 * key normalisation, and turning a model reply into one or two Chinese glosses.
 * No DOM, no stores, no network here so the rules stay testable.
 */

/** Words the highlighter marks: ASCII letters plus internal apostrophes and
 *  hyphens (`don't`, `well-known`). Digits are not words. */
export const ENGLISH_WORD_RE = /[A-Za-z][A-Za-z'’-]*/g;

export interface WordToken {
  /** The word exactly as it appears in the text. */
  word: string;
  /** Offsets into the source string. */
  start: number;
  end: number;
}

export function tokenizeWords(text: string): WordToken[] {
  const tokens: WordToken[] = [];
  for (const match of text.matchAll(ENGLISH_WORD_RE)) {
    tokens.push({
      word: match[0],
      start: match.index ?? 0,
      end: (match.index ?? 0) + match[0].length,
    });
  }
  return tokens;
}

/**
 * Cache key for a clicked word: lower-cased and stripped of surrounding
 * punctuation/quotes (`“Word,”` → `word`). The word form itself is kept
 * (no lemmatisation), so `running` and `run` are separate entries — a small
 * model gives more accurate glosses for the form actually on screen.
 */
export function normalizeWord(word: string): string {
  return word
    .trim()
    .toLowerCase()
    .replace(/^[^a-z0-9]+/, "")
    .replace(/[^a-z0-9]+$/, "");
}

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g;
const LATIN_WORD_RE = /[A-Za-z][A-Za-z'’-]*/g;

export function countChineseChars(text: string): number {
  return (text.match(CJK_RE) ?? []).length;
}

export function countLatinWords(text: string): number {
  return (text.match(LATIN_WORD_RE) ?? []).length;
}

/**
 * Whether a document should offer the reading mode. Follows the read-aloud
 * language rule (CJK characters vs Latin words) but also demands a real amount
 * of English, so one English heading in a Chinese article does not enable it.
 */
export function isEnglishDocument(markdown: string): boolean {
  const latin = countLatinWords(markdown);
  const cjk = countChineseChars(markdown);
  return latin >= 20 && cjk < latin * 0.25;
}

const LIST_PREFIX_RE = /^\s*(?:[-*•]|\d{1,2}[.)、]|\[\d+\])\s*/;
const MARKDOWN_MARKS_RE = /[*_`#>~]/g;
const EDGE_PUNCT_RE = /^[\s"'“”‘’«»()（）[\]{}<>《》，。、；;：:!?！？.\-…]+|[\s"'“”‘’«»()（）[\]{}<>《》，。、；;：:!?！？.\-…]+$/g;
const CJK_CHAR_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

/**
 * Turn a model reply into at most two gloss strings. Models often add quotes,
 * numbering, a part of speech or an English explanation; everything that is not
 * a short Chinese meaning is dropped rather than shown.
 */
export function cleanGlossText(raw: string): string[] {
  if (!raw) return [];
  const line = raw
    .split(/\r?\n/)
    .map((part) => part.trim())
    .find((part) => part.length > 0) ?? "";
  const stripped = line
    .replace(LIST_PREFIX_RE, "")
    .replace(MARKDOWN_MARKS_RE, "")
    .trim();

  const items = stripped
    .split(/[\/｜|；;、]/)
    .map((item) =>
      item
        .replace(EDGE_PUNCT_RE, "")
        // An explanation after the meaning ("（动词）", "used to ...") is noise.
        .replace(/（[^）]*）/g, "")
        .replace(/\([^)]*\)/g, "")
        .replace(/：.*$/, "")
        .trim(),
    )
    .filter((item) => CJK_CHAR_RE.test(item) && !/[A-Za-z]{2,}/.test(item))
    .slice(0, 2);

  return items;
}

/** The string shown inside the bubble. */
export function formatGloss(items: string[]): string {
  return items.slice(0, 2).join(" / ");
}
