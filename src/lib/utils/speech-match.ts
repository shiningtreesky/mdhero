/**
 * Matching the sentence the engine is reading against the rendered article.
 *
 * The read-aloud plan is built from the Markdown source, the highlight has to
 * find the same sentence in the rendered DOM, and the two are not always
 * character-identical: the speech extractor drops inline code, URLs and HTML,
 * and the source/rendered sentence splitters disagree on some abbreviations.
 * The match is therefore exact first, then forgiving, and always in reading
 * order — a plain `includes` over the whole document would land on the wrong
 * sentence whenever a phrase repeats.
 */

export interface TextualSentence {
  text: string;
}

function squashed(text: string): string {
  return text.replace(/[\s\u00a0]+/g, "").toLowerCase();
}

function commonPrefix(a: string, b: string): number {
  const limit = Math.min(a.length, b.length);
  let i = 0;
  while (i < limit && a[i] === b[i]) i++;
  return i;
}

/** Whether the rendered sentence is the one the engine is reading. */
export function sameSentence(rendered: string, spoken: string): boolean {
  if (rendered === spoken) return true;
  const a = squashed(rendered);
  const b = squashed(spoken);
  if (!a || !b) return false;
  if (a === b) return true;
  // One text is often the other with a hole where inline code used to be. A
  // very short text would match half the document, so containment needs some
  // substance.
  if (Math.min(a.length, b.length) < 4) return false;
  if (a.length <= b.length ? b.includes(a) : a.includes(b)) return true;
  // A sentence split differently by the two splitters still starts the same.
  return commonPrefix(a, b) >= Math.min(12, a.length, b.length);
}

export interface SentenceHit<T> {
  entry: T;
  index: number;
  /** Cursor to resume from, i.e. the next entry in reading order. */
  next: number;
}

/**
 * Find `spoken` in document order, starting at `from` and wrapping around once,
 * so a seek backwards still finds its sentence.
 */
export function findSentence<T extends TextualSentence>(
  sentences: T[],
  spoken: string,
  from: number,
): SentenceHit<T> | null {
  const count = sentences.length;
  for (let step = 0; step < count; step++) {
    const index = (from + step) % count;
    if (sameSentence(sentences[index].text, spoken)) {
      return { entry: sentences[index], index, next: index + 1 };
    }
  }
  return null;
}
