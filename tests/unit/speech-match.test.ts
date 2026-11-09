import { describe, expect, it } from "vitest";
import { findSentence, sameSentence } from "../../src/lib/utils/speech-match";

describe("matching a spoken sentence to the rendered one", () => {
  it("accepts identical text", () => {
    expect(sameSentence("This is a sentence.", "This is a sentence.")).toBe(true);
  });

  it("ignores whitespace and case", () => {
    expect(sameSentence("This   is a\nsentence.", "this is a sentence.")).toBe(true);
  });

  it("accepts the text left after inline code is dropped", () => {
    // The speech extractor removes `inline`, the rendered text does not; here
    // the rendered side drops code too, so the two agree.
    expect(sameSentence("这段 文本。", "这段 文本。")).toBe(true);
  });

  it("accepts one text containing the other", () => {
    expect(sameSentence("It is a long sentence.", "a long sentence")).toBe(true);
  });

  it("rejects a very short text that would match everywhere", () => {
    expect(sameSentence("Hi.", "Hi. There.")).toBe(false);
  });

  it("accepts sentences split differently but starting the same", () => {
    expect(
      sameSentence(
        "The U.S. government announced the change today.",
        "The U.S. government announced the change.",
      ),
    ).toBe(true);
  });

  it("rejects unrelated sentences", () => {
    expect(sameSentence("The first sentence.", "完全不同的另一句话。")).toBe(false);
  });
});

describe("finding the sentence in reading order", () => {
  const sentences = [
    { text: "第一句。" },
    { text: "第二句。" },
    { text: "第一句。" },
  ];

  it("starts at the cursor so repeats resolve in order", () => {
    expect(findSentence(sentences, "第一句。", 0)?.next).toBe(1);
    expect(findSentence(sentences, "第一句。", 1)?.next).toBe(3);
  });

  it("wraps around so a seek backwards still finds its sentence", () => {
    expect(findSentence(sentences, "第二句。", 2)?.entry).toBe(sentences[1]);
  });

  it("returns null when nothing matches", () => {
    expect(findSentence(sentences, "没有这句话。", 0)).toBeNull();
    expect(findSentence([], "任何句子。", 0)).toBeNull();
  });
});
