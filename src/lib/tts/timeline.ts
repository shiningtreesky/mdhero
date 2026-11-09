import type { SpeechPlan } from "$lib/utils/tts";

/**
 * Maps the read-aloud audio timeline back to the sentences of the document.
 *
 * The player only knows *document time*; it has one decoded buffer per speech
 * chunk, so a chunk's start and end are exact. Sentences inside a chunk are
 * placed by their share of that chunk's characters: Kokoro reads a chunk at an
 * even pace, so the estimate stays inside the sentence. A cache hit decodes the
 * whole document into a single segment, and then every sentence is placed by
 * its share of the whole text.
 */

/** Document-time span of one synthesized chunk. */
export interface ChunkSpan {
  start: number;
  end: number;
}

export interface SentenceTiming {
  /** The spoken text, used by the reading pane to find the sentence. */
  text: string;
  start: number;
  end: number;
}

/** Empty spans are chunks that have not been synthesized yet. `total` is the
 *  whole-document duration, known only for a cache hit. */
export function sentenceTimings(
  plan: SpeechPlan,
  spans: Array<ChunkSpan | null>,
  total = 0,
): SentenceTiming[] {
  if (plan.chunks.length === 0 || plan.sentences.length === 0) return [];

  const live = spans.some((span) => span !== null && span.end > span.start);
  const timings: SentenceTiming[] = [];

  if (!live) {
    if (!(total > 0)) return [];
    const totalChars = plan.chunks.reduce((sum, chunk) => sum + chunk.text.length, 0);
    if (totalChars === 0) return [];

    const chunkStarts: number[] = [];
    let acc = 0;
    for (const chunk of plan.chunks) {
      chunkStarts.push(acc);
      acc += chunk.text.length;
    }

    for (const sentence of plan.sentences) {
      const offset = chunkStarts[sentence.chunkIndex] ?? 0;
      timings.push({
        text: sentence.text,
        start: ((offset + sentence.start) / totalChars) * total,
        end: ((offset + sentence.end) / totalChars) * total,
      });
    }
    return timings;
  }

  for (const sentence of plan.sentences) {
    const span = spans[sentence.chunkIndex];
    if (!span || span.end <= span.start) continue;
    const length = plan.chunks[sentence.chunkIndex]?.text.length ?? 0;
    if (length === 0) continue;
    const perChar = (span.end - span.start) / length;
    timings.push({
      text: sentence.text,
      start: span.start + sentence.start * perChar,
      end: span.start + sentence.end * perChar,
    });
  }
  return timings;
}

/** Index of the sentence being read at `position`; -1 before the first one. */
export function locateSentence(timings: SentenceTiming[], position: number): number {
  if (timings.length === 0) return -1;
  let low = 0;
  let high = timings.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (timings[mid].start <= position) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found;
}
