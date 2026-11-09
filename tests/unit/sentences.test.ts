import { describe, expect, it } from "vitest";
import {
  cleanSentenceTranslation,
  sentenceKey,
  tokenizeSentences,
} from "../../src/lib/utils/sentences";
import {
  SENTENCE_FILE_SUFFIX,
  glossaryCachePath,
} from "../../src/lib/glossary/cache";

describe("sentence splitting", () => {
  it("breaks after English sentence punctuation", () => {
    const text = "First sentence. Second sentence! Third?";
    expect(tokenizeSentences(text).map((token) => token.text)).toEqual([
      "First sentence.",
      "Second sentence!",
      "Third?",
    ]);
  });

  it("reports offsets that slice back to the sentence", () => {
    const text = "One. Two! Three?";
    for (const token of tokenizeSentences(text)) {
      expect(text.slice(token.start, token.end)).toBe(token.text);
    }
  });

  it("keeps a numbered marker with its heading", () => {
    const text = "1. 编码前先思考。2. 再写代码。";
    expect(tokenizeSentences(text).map((token) => token.text)).toEqual([
      "1. 编码前先思考。",
      "2. 再写代码。",
    ]);
  });

  it("does not split decimals or common abbreviations", () => {
    const text = "The value is 3.14. Dr. Smith arrived. It cost $2.50.";
    expect(tokenizeSentences(text).map((token) => token.text)).toEqual([
      "The value is 3.14.",
      "Dr. Smith arrived.",
      "It cost $2.50.",
    ]);
  });

  it("still splits after an abbreviation that ends a sentence", () => {
    expect(tokenizeSentences("I live in the U.S. It is big.").map((token) => token.text)).toEqual([
      "I live in the U.S.",
      "It is big.",
    ]);
  });

  it("keeps a closing quote with the sentence it ends", () => {
    const text = "He said, “Hello.” Then he left.";
    expect(tokenizeSentences(text).map((token) => token.text)).toEqual([
      "He said, “Hello.”",
      "Then he left.",
    ]);
  });

  it("splits Chinese punctuation and semicolons", () => {
    const text = "第一句。第二句！第三句？第四句；第五句。";
    expect(tokenizeSentences(text).map((token) => token.text)).toEqual([
      "第一句。",
      "第二句！",
      "第三句？",
      "第四句；",
      "第五句。",
    ]);
  });

  it("handles an ellipsis as a sentence end", () => {
    expect(tokenizeSentences("Wait… What happened?").map((token) => token.text)).toEqual([
      "Wait…",
      "What happened?",
    ]);
  });

  it("trims outer whitespace and skips punctuation-only fragments", () => {
    expect(tokenizeSentences("  Hi there.   ...   Next one.  ").map((token) => token.text)).toEqual([
      "Hi there.",
      "Next one.",
    ]);
  });

  it("returns one sentence when there is no terminator", () => {
    expect(tokenizeSentences("No punctuation here").map((token) => token.text)).toEqual([
      "No punctuation here",
    ]);
  });
});

describe("sentence cache keys and cleaning", () => {
  it("collapses whitespace so re-wrapped text hits the same entry", () => {
    expect(sentenceKey("  Hello \n world.  ")).toBe("Hello world.");
  });

  it("removes a translation label, quotes and line breaks", () => {
    expect(cleanSentenceTranslation("译文：“你好世界。”")).toBe("你好世界。");
    expect(cleanSentenceTranslation("Translation: Hello world.")).toBe("Hello world.");
    expect(cleanSentenceTranslation("你好，\n世界。")).toBe("你好， 世界。");
  });

  it("leaves an empty reply empty", () => {
    expect(cleanSentenceTranslation("")).toBe("");
  });

  it("puts the sentence cache next to the Markdown file", () => {
    expect(glossaryCachePath("/docs/notes.md", SENTENCE_FILE_SUFFIX)).toBe(
      "/docs/notes.sentences.json",
    );
    expect(SENTENCE_FILE_SUFFIX).toBe(".sentences.json");
  });
});
