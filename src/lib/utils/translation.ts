/**
 * Pure helpers for the translation feature.
 *
 * The network and tab orchestration live elsewhere; everything here is
 * deterministic and unit tested: how a target file is named, how a document is
 * cut into model-sized chunks without slicing through a fenced code block, and
 * how the model's answer is cleaned before it reaches the tab.
 */

export type TranslationDirection = "cn" | "en";

/** Characters sent per model call. hy-mt2 is a small local model; keeping
 *  chunks well below its context also keeps streaming previews responsive. */
export const TRANSLATION_MAX_CHUNK_CHARS = 6000;

const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/;

/**
 * The new file name: the suffix goes immediately before the extension.
 * `技术文档.md` + `-hero-cn` → `技术文档-hero-cn.md`. A file with no extension
 * gets `.md`, because the target of a translation is always a markdown file.
 */
export function buildTargetFileName(fileName: string, suffix: string): string {
  const dot = fileName.lastIndexOf(".");
  if (dot <= 0) return `${fileName}${suffix}.md`;
  return `${fileName.slice(0, dot)}${suffix}${fileName.slice(dot)}`;
}

/** Join the target file name back onto the source file's directory, preserving
 *  the platform's separator. */
export function buildTargetPath(filePath: string, suffix: string): string {
  const cut = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  const dir = cut >= 0 ? filePath.slice(0, cut + 1) : "";
  const name = cut >= 0 ? filePath.slice(cut + 1) : filePath;
  return dir + buildTargetFileName(name, suffix);
}

/**
 * Split a leading YAML frontmatter block from the body. The block is copied to
 * the translated file verbatim — the user asked for frontmatter to stay as-is.
 */
export function splitFrontmatter(markdown: string): { frontmatter: string; body: string } {
  const source = markdown.charCodeAt(0) === 0xfeff ? markdown.slice(1) : markdown;
  const match = source.match(FRONTMATTER_RE);
  if (!match) return { frontmatter: "", body: source };
  return { frontmatter: match[0], body: source.slice(match[0].length) };
}

/**
 * Cut markdown into chunks at blank lines outside fenced code blocks. A chunk
 * that is only a fenced code block is returned whole and skipped by the
 * translator, so code is never sent to the model or broken at an arbitrary
 * line. Oversized prose is split at a line boundary as a fallback.
 */
export function splitMarkdownIntoChunks(
  markdown: string,
  maxChars = TRANSLATION_MAX_CHUNK_CHARS,
): string[] {
  if (!markdown.trim()) return [];
  if (markdown.length <= maxChars) return [markdown];

  // Keep line endings attached to their line so a chunk can be concatenated
  // back without normalising CRLF files.
  const lines = markdown.split(/(?<=\n)/);
  const chunks: string[] = [];
  let current = "";
  let inFence = false;
  let fenceMarker = "";

  const push = () => {
    if (current.trim()) chunks.push(current);
    current = "";
  };

  for (const line of lines) {
    const opening = line.match(/^[ \t]{0,3}(`{3,}|~{3,})/);
    const wasInFence = inFence;
    if (opening) {
      const marker = opening[1][0];
      if (!inFence) {
        inFence = true;
        fenceMarker = marker;
      } else if (marker === fenceMarker) {
        inFence = false;
        fenceMarker = "";
      }
    }

    current += line;

    if (!inFence) {
      const atParagraph = line.trim() === "";
      const justClosedFence = wasInFence && !inFence;
      if (
        (atParagraph && current.length >= maxChars * 0.6) ||
        justClosedFence ||
        current.length >= maxChars * 1.5
      ) {
        push();
      }
    }
  }

  push();
  return chunks;
}

/**
 * Whether a chunk contains any prose at all. A fenced code block (including a
 * huge one) is copied through unchanged instead of being sent to the model.
 */
export function isCodeOnlyChunk(chunk: string): boolean {
  let inFence = false;
  let fenceMarker = "";
  let hasText = false;

  for (const line of chunk.split(/\r?\n/)) {
    const trimmed = line.trim();
    const opening = trimmed.match(/^(`{3,}|~{3,})/);
    if (opening) {
      const marker = opening[1][0];
      if (!inFence) {
        inFence = true;
        fenceMarker = marker;
      } else if (marker === fenceMarker) {
        inFence = false;
        fenceMarker = "";
      }
      continue;
    }
    if (!inFence && trimmed) hasText = true;
  }

  return !hasText;
}

/** The instructions sent with every chunk. Kept in English because that is
 *  what small local translation models follow most reliably. */
export function buildTranslationPrompt(direction: TranslationDirection): string {
  const language = direction === "cn" ? "Simplified Chinese (zh-CN)" : "English";
  return [
    `You are a professional Markdown translator. Translate the user's Markdown into ${language}.`,
    "Keep the Markdown structure exactly: headings, lists, blockquotes, tables, links, images, and blank lines.",
    "Do not translate or modify fenced code blocks, inline code, URLs, link targets, image paths, HTML tags, or math formulas.",
    "Translate link text and image alt text.",
    "Do not add explanations, notes, or a code fence around the whole answer.",
    "Output only the translated Markdown.",
  ].join("\n");
}

/** Remove wrappers some models add around a whole answer. Only blank lines are
 *  trimmed from the edges: a chunk can legitimately start mid-list, and the
 *  indentation of a nested item is part of the Markdown structure. */
export function cleanTranslatedChunk(text: string): string {
  let result = text.replace(/^\r?\n+/, "").replace(/\s+$/, "");
  const fenced = result.match(/^```(?:markdown|md)\s*\r?\n([\s\S]*?)\r?\n```$/i);
  if (fenced) result = fenced[1].replace(/^\r?\n+/, "").replace(/\s+$/, "");
  result = result.replace(/^<translation>\s*/i, "").replace(/\s*<\/translation>$/i, "");
  return result;
}

/** Append a translated chunk, normalising the blank line between blocks. */
export function appendTranslatedBlock(base: string, block: string): string {
  if (!base) return block;
  const next = block.replace(/^[\r\n]+/, "");
  if (!next) return base;
  if (base.endsWith("\n\n")) return base + next;
  if (base.endsWith("\n")) return base + "\n" + next;
  return base + "\n\n" + next;
}

/** Append a code block without touching its indentation. */
export function appendRawBlock(base: string, block: string): string {
  if (!base) return block;
  if (base.endsWith("\n\n")) return base + block;
  if (base.endsWith("\n")) return base + "\n" + block;
  return base + "\n\n" + block;
}

/** Validate the endpoint in the settings dialog. */
export function isValidBaseUrl(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return (url.protocol === "http:" || url.protocol === "https:") && !!url.host;
  } catch {
    return false;
  }
}

/** A suffix must be usable as part of a file name on Windows, macOS and Linux. */
export function isValidSuffix(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed.length > 0 &&
    !/[\\/:*?"<>|\r\n]/.test(trimmed)
  );
}

/** The final document: frontmatter, translated chunks and copied code blocks. */
export function ensureTrailingNewline(markdown: string): string {
  return markdown.endsWith("\n") ? markdown : `${markdown}\n`;
}
