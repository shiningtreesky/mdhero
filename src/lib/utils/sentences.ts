/**
 * Pure helpers behind the toolbar's sentence ("句") reading mode: sentence
 * splitting, cache keys, and cleaning a model reply before it reaches the
 * bubble. No DOM, no stores, no network here so the rules stay testable.
 */

export interface SentenceToken {
  /** The sentence exactly as it appears in the text, without outer whitespace. */
  text: string;
  /** Offsets into the source string. */
  start: number;
  end: number;
}

/** Sentence-ending punctuation. Semicolons are included on purpose: they end a
 *  clause the reader can translate on its own, and the read-aloud splitter uses
 *  the same rule. */
const TERMINATORS = new Set(["。", "！", "？", "!", "?", "；", ";", "…"]);

/** Closing quotes/brackets that belong to the sentence before them. */
const CLOSERS = new Set([
  '"',
  "'",
  "”",
  "’",
  "»",
  "」",
  "』",
  "】",
  "）",
  ")",
  "》",
  "〉",
  "〕",
  "〗",
]);

/** `1.` at the start of a fragment is a list marker, not a full stop. */
const NUMBERED_MARKER_RE = /^\s*\d{1,3}$/;

/** Titles are always followed by a name, so their dot never ends a sentence. */
const TITLE_RE = /(?:^|[\s(])(Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St)\.?$/i;

/** Other abbreviations only continue the sentence when the next word is
 *  lowercase (`e.g. this`, `the U.S. government`); before a capital they end it
 *  (`the U.S. It is big`). */
const ABBREVIATION_RE =
  /(?:^|[\s(])(vs|etc|e\.g|i\.e|a\.m|p\.m|U\.S|U\.K)\.?$/i;

function isAbbreviation(text: string, index: number, segmentStart: number): boolean {
  const before = text.slice(segmentStart, index);
  if (TITLE_RE.test(before)) return true;
  if (!ABBREVIATION_RE.test(before)) return false;
  const nextWord = text.slice(index + 1).match(/^\s*(\S)/)?.[1] ?? "";
  return /[a-z0-9]/.test(nextWord);
}

function isTerminal(text: string, index: number, segmentStart: number): boolean {
  const ch = text[index];
  if (ch === ".") {
    // `1. 编码前先思考` is a numbered heading, not two sentences.
    if (NUMBERED_MARKER_RE.test(text.slice(segmentStart, index))) return false;
    if (isAbbreviation(text, index, segmentStart)) return false;
    const next = text[index + 1];
    // A dot is only a full stop before whitespace, a closing quote, or the end.
    return next === undefined || /\s/.test(next) || CLOSERS.has(next);
  }
  return TERMINATORS.has(ch);
}

export function tokenizeSentences(text: string): SentenceToken[] {
  const out: SentenceToken[] = [];
  let segmentStart = 0;
  let i = 0;

  const emit = (from: number, to: number) => {
    let start = from;
    let end = to;
    while (start < end && /\s/.test(text[start])) start++;
    while (end > start && /\s/.test(text[end - 1])) end--;
    if (start >= end) return;
    const piece = text.slice(start, end);
    // Punctuation-only fragments are not worth a request.
    if (!/\p{L}/u.test(piece)) return;
    out.push({ text: piece, start, end });
  };

  while (i < text.length) {
    if (!isTerminal(text, i, segmentStart)) {
      i++;
      continue;
    }
    let end = i + 1;
    // Keep `?!`, `...` and a trailing `”`/`）` with the sentence they close.
    while (end < text.length) {
      const ch = text[end];
      if (TERMINATORS.has(ch) || CLOSERS.has(ch)) end++;
      else break;
    }
    emit(segmentStart, end);
    segmentStart = end;
    i = end;
  }
  emit(segmentStart, text.length);
  return out;
}

/** Cache key for a clicked sentence: whitespace collapses so a re-wrapped
 *  paragraph hits the same entry. Case and punctuation are preserved, because
 *  they can change the translation. */
export function sentenceKey(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

const LABEL_RE = /^(?:译文|翻译|中文|translation|chinese)\s*[:：]\s*/i;
const EDGE_QUOTES_RE = /^[\s"'“”‘’«»]+|[\s"'“”‘’«»]+$/g;

/**
 * A sentence translation is shown as one wrapped paragraph. Models sometimes
 * prefix it with `译文：` or wrap it in quotes; those decorations are removed so
 * the bubble only contains the translation itself.
 */
export function cleanSentenceTranslation(raw: string): string {
  if (!raw) return "";
  return raw
    .replace(/\r?\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(LABEL_RE, "")
    .replace(EDGE_QUOTES_RE, "")
    .trim();
}
