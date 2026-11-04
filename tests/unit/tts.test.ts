import { describe, expect, it } from "vitest";
import {
  TTS_CHUNK_MAX_CHARS,
  TTS_EN_VOICE,
  TTS_ZH_VOICE,
  buildSpeechRequest,
  clampSpeed,
  detectLanguage,
  extractSpeechParagraphs,
  hasSpeakableText,
  resplitSpeechChunk,
  splitSpeechChunks,
  synthesizeChunkWithFallback,
} from "../../src/lib/utils/tts";

const document = `---
title: 不应朗读
draft: true
---

# 标题文字

这是一段 \`inline\` 文本，链接是 [官网](https://example.com)，图片 ![截图](./shot.png) 不念。

\`\`\`js
const secret = 1;
\`\`\`

| 名称 | 数量 |
| --- | --- |
| 苹果 | 3 |

- 第一项
- 第二项

<p>HTML 标签</p>
`;

describe("what read-aloud skips", () => {
  const paragraphs = extractSpeechParagraphs(document);

  it("drops frontmatter, code and HTML blocks", () => {
    expect(paragraphs).toContain("标题文字");
    expect(paragraphs.join(" ")).not.toContain("不应朗读");
    expect(paragraphs.join(" ")).not.toContain("secret");
    expect(paragraphs.join(" ")).not.toContain("HTML 标签");
  });

  it("reads headings without hashes and list items without bullets", () => {
    expect(paragraphs).toContain("标题文字");
    expect(paragraphs).toContain("第一项 第二项");
    expect(paragraphs.join(" ")).not.toContain("#");
  });

  it("keeps link text but not URLs, image paths or inline code", () => {
    expect(paragraphs).toContain("这是一段 文本，链接是 官网，图片 不念。");
    expect(paragraphs.join(" ")).not.toContain("https://example.com");
    expect(paragraphs.join(" ")).not.toContain("shot.png");
    expect(paragraphs.join(" ")).not.toContain("inline");
  });

  it("reads a table row as its cell text", () => {
    expect(paragraphs).toContain("名称 数量");
    expect(paragraphs).toContain("苹果 3");
    expect(paragraphs.join(" ")).not.toContain("|");
  });

  it("returns nothing for a document with only code", () => {
    expect(extractSpeechParagraphs("```js\nconst a = 1;\n```\n")).toEqual([]);
    expect(extractSpeechParagraphs("---\ntitle: x\n---\n")).toEqual([]);
  });
});

describe("speech chunks", () => {
  it("packs paragraphs into ordered chunks no longer than the limit", () => {
    const source = `${"Hello world. ".repeat(40)}\n\n${"这是中文句子。".repeat(30)}`;
    const chunks = splitSpeechChunks(source, 40);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.text.length).toBeLessThanOrEqual(40);
    expect(chunks.map((chunk) => chunk.text).join(" ")).toContain("Hello world.");
  });

  it("stays inside the default limit for a long document", () => {
    const source = "# Title\n\n" + "word ".repeat(400);
    const chunks = splitSpeechChunks(source);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(TTS_CHUNK_MAX_CHARS);
    }
    expect(chunks[0].text).toBe("Title");
  });

  it("uses one language per chunk", () => {
    const chunks = splitSpeechChunks("这是中文。\n\nThis is English.");
    expect(chunks.map((chunk) => chunk.language)).toEqual(["zh", "en"]);
  });

  it("is empty when there is nothing to say", () => {
    expect(splitSpeechChunks("")).toEqual([]);
    expect(splitSpeechChunks("```python\nprint(1)\n```")).toEqual([]);
  });
});

describe("unpronounceable fragments", () => {
  it("never sends punctuation or symbols as a chunk of their own", () => {
    const source = "他说：“照做。”\n\n—— …\n\n下一段。";
    const chunks = splitSpeechChunks(source, 60);
    expect(chunks[0].text.startsWith("他说：“照做。”")).toBe(true);
    for (const chunk of chunks) expect(hasSpeakableText(chunk.text)).toBe(true);
    expect(splitSpeechChunks("—— … ⚠ ****")).toEqual([]);
  });

  it("folds a closing quote into the sentence it closes", () => {
    // Kokoro answers a lone `”` with HTTP 400 "Input contains no speakable text".
    expect(splitSpeechChunks("他说：“照做。”", 30).map((chunk) => chunk.text)).toEqual([
      "他说：“照做。”",
    ]);
  });

  it("keeps a numbered heading together instead of a two-character chunk", () => {
    expect(splitSpeechChunks("### 1. 编码前先思考").map((chunk) => chunk.text)).toEqual([
      "1. 编码前先思考",
    ]);
  });

  it("splits a failed chunk at clause punctuation for a retry", () => {
    const pieces = resplitSpeechChunk({ text: "第一句。第二句。第三句。", language: "zh" });
    expect(pieces.map((piece) => piece.text)).toEqual(["第一句。", "第二句。", "第三句。"]);
    expect(resplitSpeechChunk({ text: "没有可切分的标点", language: "zh" })).toEqual([]);
  });
});

describe("single-chunk failure recovery", () => {
  const failing = (text: string) => new Error(`HTTP 400: ${text}`);

  it("retries once, then reads the chunk in smaller pieces", async () => {
    const chunk = { text: "第一句。第二句。", language: "zh" as const };
    const requested: string[] = [];
    const outcome = await synthesizeChunkWithFallback(chunk, async (piece) => {
      requested.push(piece.text);
      if (piece.text === chunk.text) throw failing("whole chunk rejected");
      return new ArrayBuffer(8);
    });

    // Both pieces were read, so nothing was actually lost.
    expect(outcome.skipped).toBe(false);
    expect(outcome.buffers).toHaveLength(2);
    expect(requested).toEqual([chunk.text, chunk.text, "第一句。", "第二句。"]);
  });

  it("drops a chunk that cannot be split and keeps the rest readable", async () => {
    const outcome = await synthesizeChunkWithFallback(
      { text: "嗯", language: "zh" },
      async () => {
        throw failing("Input contains no speakable text");
      },
    );
    expect(outcome).toEqual({ buffers: [], skipped: true });
  });

  it("still reports a backend that is actually down", async () => {
    await expect(
      synthesizeChunkWithFallback({ text: "第一句。第二句。", language: "zh" }, async () => {
        throw new TypeError("Failed to fetch");
      }),
    ).rejects.toThrow("Failed to fetch");
  });

  it("stops retrying as soon as the run is aborted", async () => {
    const chunk = { text: "第一句。第二句。", language: "zh" as const };
    let calls = 0;
    await expect(
      synthesizeChunkWithFallback(
        chunk,
        async () => {
          calls++;
          throw failing("aborted");
        },
        () => calls >= 1,
      ),
    ).rejects.toThrow("aborted");
    expect(calls).toBe(1);
  });
});

describe("language detection", () => {
  it("picks the script that dominates the text", () => {
    expect(detectLanguage("这是中文文本")).toBe("zh");
    expect(detectLanguage("This is an English sentence.")).toBe("en");
    expect(detectLanguage("使用 iPhone 打开")).toBe("zh");
    expect(detectLanguage("12345")).toBe("en");
  });
});

describe("speech request", () => {
  it("maps Chinese and English to their Kokoro voices", () => {
    expect(buildSpeechRequest({ text: "你好", language: "zh" }, 1)).toMatchObject({
      model: "kokoro",
      input: "你好",
      voice: TTS_ZH_VOICE,
      response_format: "mp3",
      stream: false,
    });
    expect(buildSpeechRequest({ text: "Hello", language: "en" }, 1).voice).toBe(TTS_EN_VOICE);
  });

  it("passes the speech rate through, clamped to 0.5–2.0", () => {
    expect(buildSpeechRequest({ text: "Hi", language: "en" }, 1.7).speed).toBe(1.7);
    expect(buildSpeechRequest({ text: "Hi", language: "en" }, 5).speed).toBe(2);
    expect(buildSpeechRequest({ text: "Hi", language: "en" }, 0.1).speed).toBe(0.5);
    expect(clampSpeed(Number.NaN)).toBe(1);
    expect(clampSpeed(1.24)).toBe(1.2);
  });
});
