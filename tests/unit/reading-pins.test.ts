import { describe, expect, it } from "vitest";
import {
  createMemoryGlossCache,
  parseGlossCacheDocument,
} from "../../src/lib/glossary/cache";

describe("pins stored beside the glosses", () => {
  it("loads the pinned words and sentences with their glosses", () => {
    const text = JSON.stringify({
      version: 2,
      glosses: { mysterious: ["神秘"] },
      pins: [
        { word: "mysterious", occurrence: 1 },
        { key: "another sentence.", text: "Another sentence.", unitIndex: 2, index: 0 },
      ],
    });
    const parsed = parseGlossCacheDocument(text);
    expect(parsed.glosses.mysterious).toEqual(["神秘"]);
    expect(parsed.pins).toHaveLength(2);
    expect(parsed.pins[0]).toEqual({ word: "mysterious", occurrence: 1 });
    expect(parsed.pins[1].key).toBe("another sentence.");
  });

  it("reads older files that never had pins", () => {
    const parsed = parseGlossCacheDocument('{"version":1,"glosses":{"run":["跑"]}}');
    expect(parsed.glosses.run).toEqual(["跑"]);
    expect(parsed.pins).toEqual([]);
  });

  it("drops entries that are not records", () => {
    const parsed = parseGlossCacheDocument(
      '{"version":2,"glosses":{},"pins":[{"word":"a","occurrence":0},3,"x",null,[1]]}',
    );
    expect(parsed.pins).toEqual([{ word: "a", occurrence: 0 }]);
  });

  it("survives a damaged file", () => {
    expect(parseGlossCacheDocument("{ broken").pins).toEqual([]);
    expect(parseGlossCacheDocument(null).pins).toEqual([]);
  });
});

describe("the in-memory cache", () => {
  it("hands pins back and replaces them as a whole", () => {
    const cache = createMemoryGlossCache({}, {}, [{ word: "a", occurrence: 0 }]);
    expect(cache.getPins()).toEqual([{ word: "a", occurrence: 0 }]);
    cache.setPins([{ word: "b", occurrence: 2 }]);
    expect(cache.getPins()).toEqual([{ word: "b", occurrence: 2 }]);
    cache.setPins([]);
    expect(cache.getPins()).toEqual([]);
  });
});
