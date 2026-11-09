import { splitFrontmatter } from "./translation";

/**
 * Helpers behind the toolbar's read-aloud button. Everything here is pure: it
 * turns a Markdown document into the plain sentences sent to Kokoro, without
 * touching the DOM, the stores or the network.
 */

/** The Kokoro-FastAPI server the toolbar talks to. */
export const TTS_BASE_URL = "http://127.0.0.1:8880";
/** Voices picked from the Kokoro voice set: Chinese and English respectively. */
export const TTS_ZH_VOICE = "zf_xiaobei";
export const TTS_EN_VOICE = "af_heart";
export const TTS_MODEL = "kokoro";
/** MP3 decodes natively in every WebView and, unlike WAV, can be stored next
 *  to the document without bloating it (~10x smaller for the same speech). */
export const TTS_RESPONSE_FORMAT = "mp3";

export const TTS_MIN_SPEED = 0.5;
export const TTS_MAX_SPEED = 2.0;
export const TTS_SPEED_STEP = 0.1;
export const TTS_DEFAULT_SPEED = 1.0;

/** Target length of one request. Short enough that the first sentence comes
 *  back quickly, long enough not to pay request overhead per word. */
export const TTS_CHUNK_MAX_CHARS = 220;

export type SpeechLanguage = "zh" | "en";

export interface SpeechChunk {
  text: string;
  language: SpeechLanguage;
}

/** Body of `POST /v1/audio/speech` (OpenAI-compatible schema). */
export interface SpeechRequestBody {
  model: string;
  input: string;
  voice: string;
  response_format: string;
  speed: number;
  stream: boolean;
}

/** Hold a requested speed inside the slider's range and on its 0.1 grid. */
export function clampSpeed(value: number): number {
  if (!Number.isFinite(value)) return TTS_DEFAULT_SPEED;
  const clamped = Math.min(TTS_MAX_SPEED, Math.max(TTS_MIN_SPEED, value));
  return Math.round(clamped * 10) / 10;
}

const HTML_TAG_RE = /<\/?[a-zA-Z][^>]*>/g;
const URL_RE = /(?:https?:\/\/|ftp:\/\/|www\.)\S+/gi;
const IMAGE_RE = /!\[[^\]]*\]\([^)]*\)/g;
const IMAGE_REF_RE = /!\[[^\]]*\]\[[^\]]*\]/g;
const LINK_RE = /\[([^\]]+)\]\([^)]*\)/g;
const LINK_REF_RE = /\[([^\]]+)\]\[[^\]]*\]/g;
const FOOTNOTE_RE = /\[\^[^\]]+\]/g;
const INLINE_CODE_RE = /`+[^`\n]*?`+/g;
const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g;
const ESCAPED_PUNCT_RE = /\\([\\`*_{}[\]()#+\-.!|>])/g;

const FENCE_OPEN_RE = /^\s{0,3}(`{3,}|~{3,})/;
const FENCE_CLOSE_RE = /^\s{0,3}(`{3,}|~{3,})\s*$/;
const HEADING_RE = /^\s{0,3}#{1,6}\s*(.*)$/;
const BLOCKQUOTE_RE = /^\s{0,3}(?:>\s*)+/;
const LIST_MARKER_RE = /^\s*(?:[-*+]|\d{1,9}[.)])\s+/;
const TASK_BOX_RE = /^\[[ xX]\]\s*/;
const DEFINITION_RE = /^\s{0,3}\[[^\]]+\]:\s*\S+/;
const HORIZONTAL_RULE_RE = /^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/;
const SETEXT_UNDERLINE_RE = /^\s{0,3}=+\s*$/;
const HTML_BLOCK_RE = /^\s{0,3}<[a-zA-Z!/]/;

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g;
const LATIN_WORD_RE = /[A-Za-z][A-Za-z'’-]*/g;

/** Turn inline Markdown into words a voice can read: links keep their text,
 *  images/URLs/code/HTML are dropped, emphasis markers disappear. */
export function cleanInlineMarkdown(text: string): string {
  return text
    .replace(ESCAPED_PUNCT_RE, "$1")
    .replace(HTML_COMMENT_RE, " ")
    .replace(IMAGE_RE, " ")
    .replace(IMAGE_REF_RE, " ")
    .replace(LINK_RE, "$1")
    .replace(LINK_REF_RE, "$1")
    .replace(FOOTNOTE_RE, " ")
    .replace(INLINE_CODE_RE, " ")
    .replace(HTML_TAG_RE, " ")
    .replace(URL_RE, " ")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(?=\S)(.+?)(?<=\S)\*/g, "$1")
    .replace(/(?<![\w])__(?=\S)(.+?)(?<=\S)__(?![\w])/g, "$1")
    .replace(/(?<![\w])_(?=\S)(.+?)(?<=\S)_(?![\w])/g, "$1")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function isTableSeparator(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes("-")) return false;
  if (!/^[\s|:-]+$/.test(trimmed)) return false;
  return trimmed.includes("|") || /^:?-{2,}:?$/.test(trimmed);
}

function tableCells(line: string): string[] {
  return line
    .replace(/^\s*\|/, "")
    .replace(/\|\s*$/, "")
    .split("|")
    .map((cell) => cleanInlineMarkdown(cell))
    .filter((cell) => cell.length > 0);
}

/** Whether a phonemizer has anything to pronounce. Kokoro rejects requests
 *  whose input has no letters or digits with
 *  `{"error":"validation_error","message":"Input contains no speakable text"}`,
 *  so anything that fails this check must never become a chunk of its own. */
export function hasSpeakableText(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text);
}

/**
 * The document as the list of paragraphs a reader would say: headings without
 * their `#`, table rows as their cell text, list items without bullets. Code
 * fences, inline code, URLs, image paths, HTML tags and frontmatter never reach
 * the backend.
 */
export function extractSpeechParagraphs(markdown: string): string[] {
  const { body } = splitFrontmatter(markdown);
  const paragraphs: string[] = [];
  let current: string[] = [];
  let fenceChar = "";
  let fenceLength = 0;
  let inComment = false;

  const flush = () => {
    const text = current.join(" ").replace(/\s+/g, " ").trim();
    if (text && hasSpeakableText(text)) paragraphs.push(text);
    current = [];
  };

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, "");

    if (fenceChar) {
      const close = line.match(FENCE_CLOSE_RE);
      if (close && close[1][0] === fenceChar && close[1].length >= fenceLength) {
        fenceChar = "";
        fenceLength = 0;
      }
      continue;
    }

    if (inComment) {
      if (line.includes("-->")) inComment = false;
      continue;
    }

    const trimmed = line.trim();
    if (!trimmed) {
      flush();
      continue;
    }

    if (trimmed.startsWith("<!--")) {
      if (!trimmed.includes("-->")) inComment = true;
      continue;
    }

    const fenceOpen = line.match(FENCE_OPEN_RE);
    if (fenceOpen) {
      flush();
      fenceChar = fenceOpen[1][0];
      fenceLength = fenceOpen[1].length;
      continue;
    }

    if (HORIZONTAL_RULE_RE.test(line) || SETEXT_UNDERLINE_RE.test(line)) {
      flush();
      continue;
    }

    if (isTableSeparator(line)) {
      flush();
      continue;
    }

    if (line.includes("|") && !line.includes("```")) {
      const cells = tableCells(line);
      flush();
      if (cells.length > 0) paragraphs.push(cells.join(" "));
      continue;
    }

    const heading = line.match(HEADING_RE);
    if (heading) {
      flush();
      const text = cleanInlineMarkdown(heading[1].replace(/\s+#+\s*$/, ""));
      if (text && hasSpeakableText(text)) paragraphs.push(text);
      continue;
    }

    if (HTML_BLOCK_RE.test(line) || DEFINITION_RE.test(line)) {
      continue;
    }

    const cleaned = cleanInlineMarkdown(
      line.replace(BLOCKQUOTE_RE, "").replace(LIST_MARKER_RE, "").replace(TASK_BOX_RE, ""),
    );
    if (cleaned && hasSpeakableText(cleaned)) current.push(cleaned);
  }
  flush();

  return paragraphs;
}

/** Which Kokoro voice should read this piece: the script that dominates wins,
 *  so mixed text is read in its main language. */
export function detectLanguage(text: string): SpeechLanguage {
  const cjk = (text.match(CJK_RE) ?? []).length;
  const latinWords = (text.match(LATIN_WORD_RE) ?? []).length;
  return cjk > 0 && cjk >= latinWords ? "zh" : "en";
}

/**
 * Break a paragraph after sentence-ending punctuation, keeping the mark.
 * A fragment with nothing pronounceable (the closing quote of `……照做。”`,
 * a stray dash) is folded into the sentence it belongs to instead of becoming
 * a sentence of its own — Kokoro answers such a lone `”` with HTTP 400
 * "Input contains no speakable text".
 */
function splitSentences(text: string): string[] {
  const out: string[] = [];
  let buffer = "";
  let leading = "";

  const emit = (raw: string) => {
    const piece = raw.trim();
    if (!piece) return;
    if (hasSpeakableText(piece)) {
      out.push(leading ? `${leading} ${piece}` : piece);
      leading = "";
      return;
    }
    if (out.length > 0) out[out.length - 1] += piece;
    else leading = leading ? `${leading} ${piece}` : piece;
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    buffer += ch;
    // `1. 编码前先思考` is a numbered heading, not two sentences: splitting it
    // would turn the marker alone into a two-character chunk.
    const listNumber = ch === "." && /^\d{1,3}$/.test(buffer.slice(0, -1));
    const endsSentence =
      !listNumber &&
      ("。！？!?；;".includes(ch) ||
        (ch === "." && (i + 1 >= text.length || /\s/.test(text[i + 1]))));
    if (endsSentence) {
      emit(buffer);
      buffer = "";
    }
  }
  emit(buffer);
  return out;
}

/** Hard-split a sentence that is longer than one request, preferring a space. */
function wrapLongSentence(sentence: string, maxChars: number): string[] {
  if (sentence.length <= maxChars) return [sentence];
  const out: string[] = [];
  let rest = sentence;
  while (rest.length > maxChars) {
    let cut = rest.lastIndexOf(" ", maxChars);
    if (cut < Math.floor(maxChars / 2)) cut = maxChars;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

/** One spoken sentence (or one piece of a sentence too long for a request),
 *  located inside the chunk it was packed into. The read-aloud highlight uses
 *  the character range to place the sentence on the audio timeline. */
export interface SpeechSentence {
  text: string;
  /** Index into `SpeechPlan.chunks`. */
  chunkIndex: number;
  /** Offsets inside that chunk's text. */
  start: number;
  end: number;
}

export interface SpeechPlan {
  chunks: SpeechChunk[];
  /** Every chunk's sentences, in reading order. */
  sentences: SpeechSentence[];
}

/**
 * The document as ordered speech chunks, each with the voice language it should
 * be read in, plus the sentence → chunk mapping. Adjacent sentences of the same
 * language are packed together so a short paragraph is not one request per
 * sentence; a sentence longer than one request is split and contributes one
 * entry per piece.
 */
export function buildSpeechPlan(
  markdown: string,
  maxChars = TTS_CHUNK_MAX_CHARS,
): SpeechPlan {
  const chunks: SpeechChunk[] = [];
  const sentences: SpeechSentence[] = [];
  let current: SpeechChunk | null = null;
  /** Index `current` will have once it is pushed. */
  let currentIndex = 0;

  const push = (piece: string) => {
    // Punctuation and whitespace alone are not speech: they would be answered
    // with HTTP 400 "Input contains no speakable text" and, before this guard,
    // abort the whole document.
    if (!piece || !hasSpeakableText(piece)) return;
    const language = detectLanguage(piece);
    if (
      current &&
      current.language === language &&
      current.text.length + 1 + piece.length <= maxChars
    ) {
      const start = current.text.length + 1;
      current.text = `${current.text} ${piece}`;
      sentences.push({ text: piece, chunkIndex: currentIndex, start, end: start + piece.length });
      return;
    }
    if (current) chunks.push(current);
    current = { text: piece, language };
    currentIndex = chunks.length;
    sentences.push({ text: piece, chunkIndex: currentIndex, start: 0, end: piece.length });
  };

  for (const paragraph of extractSpeechParagraphs(markdown)) {
    for (const sentence of splitSentences(paragraph)) {
      for (const piece of wrapLongSentence(sentence, maxChars)) push(piece);
    }
  }
  if (current) chunks.push(current);

  return { chunks, sentences };
}

/** The document as ordered speech chunks, each with the voice language it should
 *  be read in. */
export function splitSpeechChunks(
  markdown: string,
  maxChars = TTS_CHUNK_MAX_CHARS,
): SpeechChunk[] {
  return buildSpeechPlan(markdown, maxChars).chunks;
}

const CLAUSE_BREAK_RE = /(?<=[。！？!?；;，,、：:])\s*/u;

/**
 * Secondary split for a chunk whose request failed: break after clause
 * punctuation so each piece can be retried on its own. Returns an empty list
 * when the text has no internal break, which tells the caller to give up on
 * this chunk (and keep reading the rest of the document).
 */
export function resplitSpeechChunk(chunk: SpeechChunk): SpeechChunk[] {
  const pieces = chunk.text
    .split(CLAUSE_BREAK_RE)
    .map((piece) => piece.trim())
    .filter((piece) => hasSpeakableText(piece));
  if (pieces.length < 2) return [];
  return pieces.map((piece) => ({ text: piece, language: detectLanguage(piece) }));
}

/** Synthesizes one chunk; injected so retry logic stays testable without HTTP. */
export type ChunkSynthesizer = (chunk: SpeechChunk) => Promise<ArrayBuffer>;

export interface ChunkSynthesis {
  /** Audio buffers for this chunk, in order; empty when it had to be dropped. */
  buffers: ArrayBuffer[];
  /** True when some or all of the chunk could not be spoken. */
  skipped: boolean;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A network-level failure means the backend is gone; retrying every chunk
 *  would only delay the one message the user needs. */
export function isBackendFailure(error: unknown): boolean {
  return (
    error instanceof TypeError ||
    /failed to fetch|networkerror|network error|load failed|econnrefused|connection refused|aborted/i.test(
      errorMessage(error),
    )
  );
}

/**
 * One chunk must never kill the whole document. A rejected request is retried
 * once; if that fails too the chunk is split at clause punctuation and its
 * pieces are synthesized separately; only pieces that still fail are dropped.
 * Backend-level failures (no server, aborted request) rethrow so the user gets
 * one real error instead of a silently skipped document.
 */
export async function synthesizeChunkWithFallback(
  chunk: SpeechChunk,
  synthesize: ChunkSynthesizer,
  isAborted: () => boolean = () => false,
): Promise<ChunkSynthesis> {
  try {
    return { buffers: [await synthesize(chunk)], skipped: false };
  } catch (first) {
    if (isAborted() || isBackendFailure(first)) throw first;

    try {
      return { buffers: [await synthesize(chunk)], skipped: false };
    } catch (second) {
      if (isAborted() || isBackendFailure(second)) throw second;

      const pieces = resplitSpeechChunk(chunk);
      const buffers: ArrayBuffer[] = [];
      for (const piece of pieces) {
        try {
          buffers.push(await synthesize(piece));
        } catch (error) {
          if (isAborted()) throw second;
          if (isBackendFailure(error)) throw error;
        }
      }
      if (buffers.length > 0) return { buffers, skipped: buffers.length < pieces.length };
      return { buffers: [], skipped: true };
    }
  }
}

/** The OpenAI-compatible request body for one chunk at the chosen speed. */
export function buildSpeechRequest(chunk: SpeechChunk, speed: number): SpeechRequestBody {
  return {
    model: TTS_MODEL,
    input: chunk.text,
    voice: chunk.language === "zh" ? TTS_ZH_VOICE : TTS_EN_VOICE,
    response_format: TTS_RESPONSE_FORMAT,
    speed: clampSpeed(speed),
    stream: false,
  };
}
