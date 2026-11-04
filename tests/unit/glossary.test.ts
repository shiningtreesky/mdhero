import { describe, expect, it } from "vitest";
import {
  cleanGlossText,
  countChineseChars,
  countLatinWords,
  formatGloss,
  isEnglishDocument,
  normalizeWord,
  tokenizeWords,
} from "../../src/lib/utils/glossary";
import {
  createMemoryGlossCache,
  glossaryCachePath,
  parseGlossCache,
} from "../../src/lib/glossary/cache";

describe("word splitting", () => {
  it("keeps apostrophes and hyphens inside words", () => {
    const tokens = tokenizeWords("Don't stop the well-known 42 run.");
    expect(tokens.map((t) => t.word)).toEqual(["Don't", "stop", "the", "well-known", "run"]);
  });

  it("reports offsets into the source string", () => {
    const text = "read the docs";
    const tokens = tokenizeWords(text);
    expect(text.slice(tokens[1].start, tokens[1].end)).toBe("the");
  });

  it("ignores digits, punctuation and CJK", () => {
    expect(tokenizeWords("2024 中文 (test)").map((t) => t.word)).toEqual(["test"]);
  });
});

describe("cache keys", () => {
  it("lower-cases and strips surrounding punctuation", () => {
    expect(normalizeWord("“Word,”")).toBe("word");
    expect(normalizeWord("  Done!  ")).toBe("done");
  });

  it("keeps the inflected form so running and run stay separate", () => {
    expect(normalizeWord("Running")).toBe("running");
    expect(normalizeWord("Run")).toBe("run");
  });
});

describe("document language", () => {
  it("counts CJK characters and Latin words", () => {
    expect(countChineseChars("中文测试")).toBe(4);
    expect(countLatinWords("one two three")).toBe(3);
  });

  it("accepts a plain English article", () => {
    const text = "This document explains how a small model can be used to look up words while reading a long article about language.";
    expect(isEnglishDocument(text)).toBe(true);
  });

  it("rejects a Chinese article that merely contains an English heading", () => {
    const text = "# Getting Started\n\n这是一篇中文文章。它介绍了如何配置接口、如何保存文件，以及在使用过程中需要注意的各种细节问题，内容很长。";
    expect(isEnglishDocument(text)).toBe(false);
  });

  it("rejects a document with too little English", () => {
    expect(isEnglishDocument("hello world")).toBe(false);
  });
});

describe("gloss cleaning", () => {
  it("drops numbering, quotes and a part of speech", () => {
    expect(cleanGlossText("1. “令牌”\n（名词）")).toEqual(["令牌"]);
  });

  it("keeps at most two meanings", () => {
    expect(cleanGlossText("跑 / 经营 / 流淌")).toEqual(["跑", "经营"]);
  });

  it("uses the first meaningful line only", () => {
    expect(cleanGlossText("\n\n象征；标志\n\nExample: a token of love")).toEqual(["象征", "标志"]);
  });

  it("drops English explanations", () => {
    expect(cleanGlossText("token - a piece of metal")).toEqual([]);
  });

  it("removes a trailing explanation after a colon", () => {
    expect(cleanGlossText("令牌：用于身份验证的一段字符串")).toEqual(["令牌"]);
  });

  it("formats one or two meanings", () => {
    expect(formatGloss(["令牌"])).toBe("令牌");
    expect(formatGloss(["跑", "经营"])).toBe("跑 / 经营");
    expect(formatGloss(["跑", "经营", "流淌"])).toBe("跑 / 经营");
  });

  it("cleans actual replies from hy-mt2-1.8b", () => {
    // Raw model replies, transcribed from a live run against the default endpoint.
    expect(formatGloss(cleanGlossText("令牌"))).toBe("令牌");
    expect(formatGloss(cleanGlossText("跑步；运转；奔跑"))).toBe("跑步 / 运转");
    expect(formatGloss(cleanGlossText("记录"))).toBe("记录");
  });
});

describe("gloss cache files", () => {
  it("puts the cache next to the Markdown file", () => {
    expect(glossaryCachePath("C:\\docs\\技术文档.md")).toBe("C:\\docs\\技术文档.words.json");
    expect(glossaryCachePath("/docs/readme.markdown")).toBe("/docs/readme.words.json");
  });

  it("appends the suffix when the source has no extension", () => {
    expect(glossaryCachePath("/docs/notes")).toBe("/docs/notes.words.json");
  });

  it("parses a normal cache file", () => {
    const text = JSON.stringify({ version: 1, glosses: { token: ["令牌"], run: ["跑", "经营"] } });
    expect(parseGlossCache(text)).toEqual({ token: ["令牌"], run: ["跑", "经营"] });
  });

  it("caps entries at two meanings", () => {
    expect(parseGlossCache(JSON.stringify({ glosses: { run: ["跑", "经营", "流淌"] } })).run).toEqual([
      "跑",
      "经营",
    ]);
  });

  it("survives a damaged or missing file", () => {
    expect(parseGlossCache("{ broken")).toEqual({});
    expect(parseGlossCache(null)).toEqual({});
    expect(parseGlossCache(JSON.stringify({ version: 1 }))).toEqual({});
  });

  it("keeps entries in an in-memory cache", async () => {
    const cache = createMemoryGlossCache();
    await cache.ready;
    expect(cache.get("token")).toBeUndefined();
    cache.set("token", ["令牌", "标记", "代币"]);
    expect(cache.get("token")).toEqual(["令牌", "标记"]);
  });
});
