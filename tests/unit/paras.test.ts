import { describe, expect, it } from "vitest";
import {
  acceptsParagraph,
  normalizeParagraphText,
  paragraphHash,
} from "../../src/lib/utils/paragraphs";
import {
  parasItemsToDocument,
  parseParasDocument,
  parseParasDrafts,
  type ParaItem,
} from "../../src/lib/paras/store";
import { buildScoreMessages, parseScoreResponse } from "../../src/lib/utils/parasScore";

describe("paragraph model", () => {
  it("collapses whitespace and trims the source text", () => {
    expect(normalizeParagraphText("  a   b \n\t c  ")).toBe("a b c");
    expect(normalizeParagraphText("\n\n")).toBe("");
  });

  it("accepts normal, list and quote blocks and rejects excluded ones", () => {
    const shape = (overrides: Partial<Parameters<typeof acceptsParagraph>[0]>) => ({
      text: "A normal paragraph.",
      excluded: false,
      hasNestedParagraph: false,
      mediaOnly: false,
      ...overrides,
    });
    expect(acceptsParagraph(shape({}))).toBe(true);
    expect(acceptsParagraph(shape({ text: "" }))).toBe(false);
    expect(acceptsParagraph(shape({ text: "   " }))).toBe(false);
    expect(acceptsParagraph(shape({ excluded: true }))).toBe(false);
    expect(acceptsParagraph(shape({ mediaOnly: true }))).toBe(false);
    // A list item that only wraps a <p>: the inner block is the paragraph.
    expect(acceptsParagraph(shape({ hasNestedParagraph: true }))).toBe(false);
  });

  it("hashes the text deterministically and changes when the text changes", async () => {
    const a = await paragraphHash("The quick brown fox.");
    const b = await paragraphHash("The quick brown fox.");
    const c = await paragraphHash("The quick brown fox jumps.");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("paras.json parsing", () => {
  const valid = JSON.stringify({
    version: 1,
    items: [
      { index: 3, hash: "abcd1234", text: "第三段", status: "translated", updatedAt: 1 },
      { index: 1, hash: "aaaa1111", text: "", status: "skipped", updatedAt: 2 },
    ],
  });

  it("sorts by paragraph index", () => {
    expect(parseParasDocument(valid).map((item) => item.index)).toEqual([1, 3]);
  });

  it("returns nothing for damaged or missing files", () => {
    expect(parseParasDocument(null)).toEqual([]);
    expect(parseParasDocument("{oops")).toEqual([]);
    expect(parseParasDocument(JSON.stringify({ items: "nope" }))).toEqual([]);
  });

  it("drops entries without a valid index and lets later duplicates win", () => {
    const items = parseParasDocument(
      JSON.stringify({
        items: [
          { index: 2, hash: "h1", text: "第一版", status: "translated", updatedAt: 1 },
          { index: 2, hash: "h2", text: "第二版", status: "translated", updatedAt: 2 },
          { nope: true },
          { index: -1, text: "x" },
        ],
      }),
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ index: 2, text: "第二版", hash: "h2" });
  });

  it("coerces unknown statuses to translated and keeps a stable document", () => {
    const parsed = parseParasDocument(
      JSON.stringify({ items: [{ index: 0, text: "译文", status: "done" }] }),
    );
    expect(parsed[0].status).toBe("translated");
    const items: ParaItem[] = [
      { index: 5, hash: "h", text: "x", status: "skipped", updatedAt: 7 },
      { index: 2, hash: "h", text: "y", status: "translated", updatedAt: 8 },
    ];
    const document = JSON.parse(parasItemsToDocument(items));
    expect(document.version).toBe(1);
    expect(document.items.map((item: ParaItem) => item.index)).toEqual([2, 5]);
  });

  it("parses drafts and ignores empty values", () => {
    expect(
      parseParasDrafts(JSON.stringify({ version: 1, drafts: { "4": "草稿", "7": "", x: "n" } })),
    ).toEqual({ 4: "草稿" });
    expect(parseParasDrafts("junk")).toEqual({});
  });
});

describe("grading payload", () => {
  const inputs = [
    { index: 0, english: "First paragraph.", chinese: "第一段译文。", status: "translated" as const },
    { index: 1, english: "Second paragraph.", chinese: "", status: "skipped" as const },
    { index: 2, english: "Third paragraph.", chinese: "第三段译文。", status: "translated" as const },
  ];

  it("sends every paragraph in one request and marks skipped ones explicitly", () => {
    const messages = buildScoreMessages(inputs);
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toContain("skipped");
    const payload = JSON.parse(messages[1].content) as Array<Record<string, unknown>>;
    expect(payload).toHaveLength(3);
    expect(payload[0]).toMatchObject({ index: 0, status: "translated", chinese: "第一段译文。" });
    expect(payload[1]).toMatchObject({ index: 1, status: "skipped" });
    expect(payload[1].note).toContain("does not take part");
    expect(payload[2]).toMatchObject({ index: 2, status: "translated" });
  });
});

describe("grading response parsing", () => {
  it("reads JSON wrapped in code fences", () => {
    const raw = '```json\n{"items":[{"index":0,"score":88,"comment":"不错","recommended":"A fine paragraph."}]}\n```';
    const parsed = parseScoreResponse(raw);
    expect(parsed.ok).toBe(true);
    expect(parsed.entries).toEqual([
      { index: 0, score: 88, comment: "不错", recommended: "A fine paragraph." },
    ]);
  });

  it("reads JSON surrounded by prose and accepts a bare array", () => {
    const raw =
      'Sure! Here is the result: [{"index":2,"score":72,"comment":"漏译了半句","recommended":"..."}] Hope it helps.';
    const parsed = parseScoreResponse(raw);
    expect(parsed.ok).toBe(true);
    expect(parsed.entries[0]).toMatchObject({ index: 2, score: 72 });
  });

  it("clamps scores and keeps skipped echoes out of the score set", () => {
    const raw = JSON.stringify({
      items: [
        { index: 0, score: 120, comment: "高", recommended: "A" },
        { index: 1, score: -5, comment: "低", recommended: "B" },
        { index: 2, skipped: true },
      ],
    });
    const parsed = parseScoreResponse(raw);
    expect(parsed.entries.find((entry) => entry.index === 0)?.score).toBe(100);
    expect(parsed.entries.find((entry) => entry.index === 1)?.score).toBe(0);
    expect(parsed.entries.find((entry) => entry.index === 2)).toMatchObject({
      index: 2,
      score: null,
    });
  });

  it("degrades instead of throwing when the answer is not JSON", () => {
    const parsed = parseScoreResponse("I cannot grade this article.");
    expect(parsed.ok).toBe(false);
    expect(parsed.entries).toEqual([]);
    expect(parsed.raw).toBe("I cannot grade this article.");
    expect(parseScoreResponse("").ok).toBe(false);
  });
});
