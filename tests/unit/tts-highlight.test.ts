import { describe, expect, it } from "vitest";
import { buildSpeechPlan, splitSpeechChunks } from "../../src/lib/utils/tts";
import { locateSentence, sentenceTimings } from "../../src/lib/tts/timeline";

const markdown = `第一句。第二句。第三句。

Hello there. Another sentence.`;

describe("the speech plan", () => {
  const plan = buildSpeechPlan(markdown);

  it("keeps the chunk list identical to splitSpeechChunks", () => {
    expect(plan.chunks).toEqual(splitSpeechChunks(markdown));
  });

  it("locates every spoken sentence inside its chunk", () => {
    expect(plan.sentences.length).toBe(5);
    for (const sentence of plan.sentences) {
      const chunk = plan.chunks[sentence.chunkIndex];
      expect(chunk.text.slice(sentence.start, sentence.end)).toBe(sentence.text);
    }
  });

  it("covers each chunk with its sentences", () => {
    for (let i = 0; i < plan.chunks.length; i++) {
      const text = plan.sentences
        .filter((sentence) => sentence.chunkIndex === i)
        .map((sentence) => sentence.text)
        .join(" ");
      expect(text).toBe(plan.chunks[i].text);
    }
  });

  it("gives every piece of a wrapped sentence its own entry", () => {
    const long = "a".repeat(30);
    const wrapped = buildSpeechPlan(`${long}`, 12);
    expect(wrapped.chunks.length).toBeGreaterThan(1);
    for (const sentence of wrapped.sentences) {
      const chunk = wrapped.chunks[sentence.chunkIndex];
      expect(chunk.text.slice(sentence.start, sentence.end)).toBe(sentence.text);
    }
  });
});

describe("sentence timings on the audio timeline", () => {
  const plan = buildSpeechPlan("一。二。");

  it("places sentences by their share of a cached document", () => {
    const timings = sentenceTimings(plan, [], 10);
    expect(timings).toHaveLength(2);
    expect(timings[0].start).toBe(0);
    expect(timings[1].start).toBeGreaterThan(timings[0].end);
    expect(timings[timings.length - 1].end).toBeCloseTo(10, 5);
  });

  it("places sentences by their share of a generated chunk", () => {
    const timings = sentenceTimings(plan, [{ start: 0, end: 4 }]);
    expect(timings).toHaveLength(2);
    expect(timings[0].start).toBe(0);
    expect(timings[0].end).toBeLessThan(2);
    expect(timings[1].start).toBeGreaterThan(2);
    expect(timings[1].end).toBeCloseTo(4, 5);
  });

  it("skips chunks that have not been synthesized yet", () => {
    const two = buildSpeechPlan("第一句话。第二句话。", 6);
    expect(two.chunks).toHaveLength(2);
    const timings = sentenceTimings(two, [{ start: 0, end: 2 }, null]);
    expect(timings).toHaveLength(1);
    expect(timings[0].text).toBe("第一句话。");
  });

  it("has no timings without audio", () => {
    expect(sentenceTimings(plan, [], 0)).toEqual([]);
  });
});

describe("locating the sentence being read", () => {
  const plan = buildSpeechPlan("一。二。");
  const timings = sentenceTimings(plan, [], 10);

  it("returns the sentence that contains the position", () => {
    expect(locateSentence(timings, 0)).toBe(0);
    expect(locateSentence(timings, timings[1].start + 0.1)).toBe(1);
  });

  it("returns -1 before the first sentence and the last one after the end", () => {
    expect(locateSentence([], 0)).toBe(-1);
    expect(locateSentence(timings, -1)).toBe(-1);
    expect(locateSentence(timings, 99)).toBe(1);
  });
});
