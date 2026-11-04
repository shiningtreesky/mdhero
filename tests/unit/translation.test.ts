import { describe, expect, it } from "vitest";
import {
  appendRawBlock,
  appendTranslatedBlock,
  buildTargetFileName,
  buildTargetPath,
  cleanTranslatedChunk,
  isCodeOnlyChunk,
  isValidBaseUrl,
  isValidSuffix,
  splitFrontmatter,
  splitMarkdownIntoChunks,
} from "../../src/lib/utils/translation";

describe("translation file names", () => {
  it("puts the suffix before the extension", () => {
    expect(buildTargetFileName("技术文档.md", "-hero-cn")).toBe("技术文档-hero-cn.md");
    expect(buildTargetFileName("readme.markdown", "-hero-en")).toBe("readme-hero-en.markdown");
  });

  it("adds .md when the source has no extension", () => {
    expect(buildTargetFileName("notes", "-hero-cn")).toBe("notes-hero-cn.md");
  });

  it("keeps the source directory and its separator", () => {
    expect(buildTargetPath("C:\\docs\\技术文档.md", "-hero-cn")).toBe("C:\\docs\\技术文档-hero-cn.md");
    expect(buildTargetPath("/home/me/doc.md", "-hero-en")).toBe("/home/me/doc-hero-en.md");
  });
});

describe("frontmatter", () => {
  it("keeps the YAML block verbatim, BOM included", () => {
    const source = "\uFEFF---\ntitle: 技术文档\ndescription: not translated\n---\n\n# Hello\n";
    const { frontmatter, body } = splitFrontmatter(source);
    expect(frontmatter).toBe("---\ntitle: 技术文档\ndescription: not translated\n---\n");
    expect(body).toBe("\n# Hello\n");
  });

  it("leaves a document without frontmatter alone", () => {
    expect(splitFrontmatter("# Hello")).toEqual({ frontmatter: "", body: "# Hello" });
  });
});

describe("chunking", () => {
  const prose = (n: number) => `${"word ".repeat(51)}\n\n`.repeat(n);

  it("returns a short document as one chunk", () => {
    expect(splitMarkdownIntoChunks("# Hello\n\nWorld\n")).toEqual(["# Hello\n\nWorld\n"]);
  });

  it("never cuts a fenced code block in half", () => {
    const code = "```js\nconst a = 1;\nconst b = 2;\n```\n";
    const chunks = splitMarkdownIntoChunks(prose(3) + code + prose(3), 900);
    expect(chunks.length).toBeGreaterThan(1);
    const withCode = chunks.filter((c) => c.includes("```"));
    expect(withCode).toHaveLength(1);
    expect(withCode[0]).toContain("const a = 1;\nconst b = 2;");
  });

  it("keeps every source character in order", () => {
    const source = prose(5) + "```md\n# not translated\n```\n" + prose(5);
    const chunks = splitMarkdownIntoChunks(source, 900);
    expect(chunks.join("")).toBe(source);
  });

  it("recognises a code-only chunk", () => {
    expect(isCodeOnlyChunk("```bash\nnpm install\n```\n")).toBe(true);
    expect(isCodeOnlyChunk("Some prose\n\n```bash\nnpm install\n```\n")).toBe(false);
  });
});

describe("assembling the translated document", () => {
  it("unwraps a whole-answer code fence", () => {
    expect(cleanTranslatedChunk("```markdown\n# 标题\n```\n")).toBe("# 标题");
  });

  it("trims blank lines but keeps a nested list's indentation", () => {
    expect(cleanTranslatedChunk("\n\n  - 项目\n\n")).toBe("  - 项目");
  });

  it("separates consecutive blocks with one blank line", () => {
    expect(appendTranslatedBlock("# 标题\n", "- 项目\n")).toBe("# 标题\n\n- 项目\n");
    expect(appendTranslatedBlock("# 标题\n\n", "- 项目\n")).toBe("# 标题\n\n- 项目\n");
  });

  it("appends a copied code block without changing its indentation", () => {
    expect(appendRawBlock("正文\n", "```py\n  x = 1\n```\n")).toBe("正文\n\n```py\n  x = 1\n```\n");
  });
});

describe("settings validation", () => {
  it("accepts both base URL shapes", () => {
    expect(isValidBaseUrl("http://192.168.1.13:1234")).toBe(true);
    expect(isValidBaseUrl("http://192.168.1.13:1234/v1")).toBe(true);
    expect(isValidBaseUrl("https://api.example.com")).toBe(true);
    expect(isValidBaseUrl("ftp://example.com")).toBe(false);
    expect(isValidBaseUrl("not a url")).toBe(false);
  });

  it("rejects suffixes that cannot be part of a file name", () => {
    expect(isValidSuffix("-hero-cn")).toBe(true);
    expect(isValidSuffix("")).toBe(false);
    expect(isValidSuffix("-hero/cn")).toBe(false);
    expect(isValidSuffix("-hero:cn")).toBe(false);
  });
});
