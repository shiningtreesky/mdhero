/**
 * Prompt and response handling for 对比提交 (the paragraph grader).
 *
 * One request carries the whole article — the user asked for no batching — so
 * the payload is a JSON array of every processed paragraph. Skipped paragraphs
 * are sent explicitly with a note so the model knows the user gave up on them
 * instead of assuming they were forgotten.
 *
 * Responses are parsed defensively: models wrap JSON in code fences, prepend a
 * sentence, or return a bare array. Anything unreadable degrades to an error
 * flag so the panel can show the raw text instead of crashing.
 */

export type ScoreParagraphStatus = "translated" | "skipped";

/** Type of the source unit, so the model knows a heading or a table cell is
 *  short by nature and should not be judged as an incomplete paragraph. */
export type ScoreUnitType = "heading" | "paragraph" | "list" | "quote" | "cell";

export interface ScoreParagraphInput {
  index: number;
  english: string;
  chinese: string;
  status: ScoreParagraphStatus;
  type: ScoreUnitType;
}

export interface ScoreEntry {
  index: number;
  score: number | null;
  comment: string;
  recommended: string;
}

export interface ParsedScore {
  entries: ScoreEntry[];
  /** False when the model answered with something that was not usable JSON. */
  ok: boolean;
  raw: string;
}

/** One paragraph as the result panel shows it: the request plus the model's
 *  answer, merged by index. */
export interface ScoreRow extends ScoreParagraphInput {
  score: number | null;
  comment: string;
  recommended: string;
  /** False when the model returned no usable entry for this paragraph. */
  answered: boolean;
}

export interface ScoreMessage {
  role: "system" | "user";
  content: string;
}

const SYSTEM_PROMPT = [
  "You are an English writing tutor grading a Chinese reader's unit-by-unit translations.",
  "The input is a JSON array of units from one article, in document order. Each item has: index (number), type (\"heading\", \"paragraph\", \"list\", \"quote\" or \"cell\"), english (the original text of the unit), chinese (the reader's translation, empty when skipped), status (\"translated\" or \"skipped\").",
  "Headings and table cells are short by nature: judge them on their own, do not call them incomplete or ask for more context.",
  "For every item with status \"translated\": compare the Chinese translation with the English original. Score 0-100 for fidelity, completeness and natural Chinese. Write a SHORT comment in Simplified Chinese (at most two sentences, point out the main problem or strength). Also give \"recommended\": a more idiomatic English rendering of the unit (natural, faithful English — not a Chinese sentence, not a rewrite of the topic).",
  "For every item with status \"skipped\": the reader explicitly gave up translating that unit and it must NOT be scored or commented. Echo it back as {\"index\": n, \"skipped\": true}.",
  "Answer with JSON only, no prose and no code fences, in exactly this shape:",
  "{\"items\":[{\"index\":0,\"score\":85,\"comment\":\"…\",\"recommended\":\"…\"},{\"index\":1,\"skipped\":true}]}",
].join("\n");

export function buildScoreMessages(inputs: ScoreParagraphInput[]): ScoreMessage[] {
  const payload = inputs.map((item) =>
    item.status === "skipped"
      ? {
          index: item.index,
          type: item.type,
          english: item.english,
          status: "skipped",
          note: "The user gave up translating this unit; it does not take part in the scoring.",
        }
      : {
          index: item.index,
          type: item.type,
          english: item.english,
          chinese: item.chinese,
          status: "translated",
        },
  );
  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: JSON.stringify(payload, null, 1) },
  ];
}

/** Pull the first balanced JSON object/array out of a model answer that may
 *  contain prose or code fences around it. */
function extractJson(raw: string): unknown {
  const withoutFences = raw.replace(/```(?:json)?/gi, "").replace(/```/g, "").trim();
  for (const candidate of [withoutFences, raw]) {
    try {
      return JSON.parse(candidate);
    } catch {
      // fall through to the scanner
    }
    const start = candidate.search(/[[{]/);
    if (start === -1) continue;
    const open = candidate[start];
    const close = open === "{" ? "}" : "]";
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < candidate.length; i++) {
      const ch = candidate[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === open) depth++;
      else if (ch === close) {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(candidate.slice(start, i + 1));
          } catch {
            return undefined;
          }
        }
      }
    }
  }
  return undefined;
}

function pickArray(parsed: unknown): unknown[] {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === "object") {
    const record = parsed as Record<string, unknown>;
    for (const key of ["items", "results", "paragraphs", "data"]) {
      if (Array.isArray(record[key])) return record[key] as unknown[];
    }
    // A single paragraph object is still usable.
    if ("index" in record) return [record];
  }
  return [];
}

function clampScore(value: unknown): number | null {
  const score = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(score)) return null;
  return Math.max(0, Math.min(100, Math.round(score)));
}

/** Parse the model's answer into one entry per paragraph. Unknown or unusable
 *  answers come back as `ok: false` with the raw text, never as an exception. */
export function parseScoreResponse(raw: string): ParsedScore {
  const text = (raw ?? "").trim();
  if (!text) return { entries: [], ok: false, raw: text };
  const parsed = extractJson(text);
  if (parsed === undefined) return { entries: [], ok: false, raw: text };

  const byIndex = new Map<number, ScoreEntry>();
  for (const rawItem of pickArray(parsed)) {
    if (!rawItem || typeof rawItem !== "object") continue;
    const item = rawItem as Record<string, unknown>;
    const index = typeof item.index === "number" ? item.index : Number(item.index);
    if (!Number.isInteger(index) || index < 0) continue;
    if (item.skipped === true) {
      byIndex.set(index, { index, score: null, comment: "", recommended: "" });
      continue;
    }
    byIndex.set(index, {
      index,
      score: clampScore(item.score),
      comment: typeof item.comment === "string" ? item.comment.trim() : "",
      recommended: typeof item.recommended === "string" ? item.recommended.trim() : "",
    });
  }
  return { entries: Array.from(byIndex.values()), ok: byIndex.size > 0, raw: text };
}
