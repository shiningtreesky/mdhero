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

/** IPA for the two accents the settings can show. Values never include the
 *  surrounding slashes; an empty string means the model did not provide one. */
export interface Phonetic {
  uk: string;
  us: string;
}

const EMPTY_PHONETIC: Phonetic = { uk: "", us: "" };

/** Keep only the transcription itself: strip labels, slashes, brackets and
 *  anything that is clearly not IPA (Chinese text, "unknown", overlong junk). */
export function cleanPhonetic(value: unknown): string {
  if (typeof value !== "string") return "";
  let text = value
    .trim()
    .replace(/^(?:UK|US|IPA|英式?|美式?)\s*(?:音标)?\s*[:：]\s*/i, "")
    .replace(/^(?:UK|US|IPA|英式?|美式?)\s*(?:音标)?\s*(?=[/\[])/i, "")
    .replace(/\s*\((?:UK|US|英式?|美式?)\)\s*$/i, "")
    .replace(/^[([{/]+/, "")
    .replace(/[)\]}>/]+$/, "")
    .trim();
  if (!text) return "";
  if (/^(?:unknown|n\/?a|none|-+|—+)$/i.test(text)) return "";
  if (CJK_CHAR_RE.test(text)) return "";
  if (text.length > 80) return "";
  return text;
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  const candidates = [text];
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) candidates.push(text.slice(start, end + 1));

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      // Some models wrap the object in a one-element array.
      const value = Array.isArray(parsed) ? parsed[0] : parsed;
      if (value && typeof value === "object" && !Array.isArray(value)) {
        return value as Record<string, unknown>;
      }
    } catch {
      // Try the next candidate (the reply may wrap the JSON in prose).
    }
  }
  return null;
}

export interface PhoneticReply {
  phonetic: Phonetic;
  /** True when the reply actually contained UK/US fields or labels. */
  attempted: boolean;
}

function phoneticFrom(value: unknown): Phonetic {
  // A single transcription with no accent split is shown as-is (the formatter
  // collapses identical UK/US values).
  if (typeof value === "string") {
    const single = cleanPhonetic(value);
    return { uk: single, us: single };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ...EMPTY_PHONETIC };
  }
  const obj = value as Record<string, unknown>;
  const single = obj.ipa ?? obj.transcription;
  return {
    uk: cleanPhonetic(obj.uk ?? obj.UK ?? obj.phonetic_uk ?? obj.phoneticUk ?? single),
    us: cleanPhonetic(obj.us ?? obj.US ?? obj.phonetic_us ?? obj.phoneticUs ?? single),
  };
}

function hasPhoneticFields(obj: Record<string, unknown>): boolean {
  return (
    "uk" in obj ||
    "UK" in obj ||
    "us" in obj ||
    "US" in obj ||
    "phonetic_uk" in obj ||
    "phoneticUk" in obj ||
    "phonetic_us" in obj ||
    "phoneticUs" in obj ||
    "phonetic" in obj ||
    "ipa" in obj ||
    "transcription" in obj
  );
}

const ACCENT_LABELS: Array<[keyof Phonetic, string]> = [
  ["uk", "UK|British(?: English)?|英式?"],
  ["us", "US|American(?: English)?|美式?"],
];

/** Pull labelled transcriptions out of a plain reply, with or without the
 *  surrounding slashes: `UK: /.../  US: /.../` or `UK: ...\nUS: ...`. */
function phoneticFromText(text: string): PhoneticReply {
  const phonetic: Phonetic = { ...EMPTY_PHONETIC };
  let attempted = false;

  for (const [accent, label] of ACCENT_LABELS) {
    const slashed = new RegExp(
      `(?:${label})\\s*(?:音标)?\\s*[:：]?\\s*[/\\[]([^/\\]\\n]{1,80})[/\\]]`,
      "i",
    ).exec(text);
    if (slashed) {
      attempted = true;
      phonetic[accent] = cleanPhonetic(slashed[1]);
      continue;
    }

    const bare = new RegExp(
      `(?:${label})\\s*(?:音标)?\\s*[:：]\\s*([^\\n]{1,60}?)(?=\\s+(?:UK|US|British(?: English)?|American(?: English)?|英式?|美式?)\\s*[:：]|$)`,
      "im",
    ).exec(text);
    if (bare) {
      attempted = true;
      phonetic[accent] = cleanPhonetic(bare[1]);
    }
  }

  if (!attempted) {
    // The model dropped the labels: accept lines that are exactly one /.../
    // value, so a gloss such as "run / operate" cannot be mistaken for IPA.
    const values: string[] = [];
    for (const line of text.split(/\r?\n/)) {
      const match = /^[/\[]([^/\]\n]{1,80})[/\]]$/.exec(line.trim());
      const value = match ? cleanPhonetic(match[1]) : "";
      if (value) values.push(value);
    }
    if (values.length >= 2) {
      return { phonetic: { uk: values[0], us: values[1] }, attempted: true };
    }
    if (values.length === 1) {
      return { phonetic: { uk: values[0], us: values[0] }, attempted: true };
    }

    // `UK: //` / `US: //` still count as an answer ("unknown"), so an empty
    // result can be cached instead of querying the model on every click.
    attempted = /(?:UK|US|British|American|英式|美式)\s*(?:音标)?\s*[:：]/.test(text);
  }
  return { phonetic, attempted };
}

/**
 * Parse the dedicated IPA reply. Accepts the requested `UK: ... / US: ...`
 * lines, a JSON object (`{"uk":"...","us":"..."}` or `{"phonetic":...}`), or a
 * single unlabelled transcription. A reply with no transcription at all is
 * reported as `attempted: false` so the caller can retry later instead of
 * caching a permanent "no IPA" marker.
 */
export function parsePhoneticReply(raw: string): PhoneticReply {
  const text = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  const object = parseJsonObject(text);
  if (object && hasPhoneticFields(object)) {
    return { phonetic: phoneticFrom(object.phonetic ?? object), attempted: true };
  }

  return phoneticFromText(text);
}

/** `英 /.../  美 /.../`, omitting accents the user turned off. Identical
 *  UK/US values collapse to one unlabelled transcription. */
export function formatPhonetic(
  phonetic: Phonetic,
  showUk: boolean,
  showUs: boolean,
  ukLabel = "UK",
  usLabel = "US",
): string {
  const uk = showUk ? phonetic.uk : "";
  const us = showUs ? phonetic.us : "";
  if (uk && us && uk === us) return `/${uk}/`;
  const parts: string[] = [];
  if (uk) parts.push(`${ukLabel} /${uk}/`);
  if (us) parts.push(`${usLabel} /${us}/`);
  return parts.join("  ");
}
