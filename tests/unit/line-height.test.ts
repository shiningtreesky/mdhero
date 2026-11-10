import { describe, expect, it } from "vitest";
import {
  clampLineHeight,
  DEFAULT_LINE_HEIGHT,
  MAX_LINE_HEIGHT,
  MIN_LINE_HEIGHT,
} from "../../src/lib/stores/settings";

describe("reading line spacing", () => {
  it("keeps a value inside the control's bounds", () => {
    expect(clampLineHeight(1.4)).toBe(1.4);
    expect(clampLineHeight("2.6")).toBe(2.6);
  });

  it("clamps beyond the bounds instead of rejecting the value", () => {
    expect(clampLineHeight(0.2)).toBe(MIN_LINE_HEIGHT);
    expect(clampLineHeight(9)).toBe(MAX_LINE_HEIGHT);
  });

  it("rounds to the 0.1 step the two controls show", () => {
    expect(clampLineHeight(1.7000000000000002)).toBe(1.7);
    expect(clampLineHeight(1.789)).toBe(1.8);
  });

  it("falls back to the default for junk", () => {
    expect(clampLineHeight("")).toBe(DEFAULT_LINE_HEIGHT);
    expect(clampLineHeight("  ")).toBe(DEFAULT_LINE_HEIGHT);
    expect(clampLineHeight("abc")).toBe(DEFAULT_LINE_HEIGHT);
    expect(clampLineHeight(null)).toBe(DEFAULT_LINE_HEIGHT);
    expect(clampLineHeight(undefined)).toBe(DEFAULT_LINE_HEIGHT);
    expect(clampLineHeight(NaN)).toBe(DEFAULT_LINE_HEIGHT);
  });
});
