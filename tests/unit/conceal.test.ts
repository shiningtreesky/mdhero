import { describe, expect, it } from "vitest";
import { pruneConcealed, toggleConcealed } from "../../src/lib/utils/conceal";

describe("column concealment", () => {
  it("toggles each tab independently", () => {
    let state: ReadonlySet<string> = new Set();
    state = toggleConcealed(state, "left-doc");
    state = toggleConcealed(state, "right-doc");
    expect([...state]).toEqual(["left-doc", "right-doc"]);

    state = toggleConcealed(state, "left-doc");
    expect([...state]).toEqual(["right-doc"]);
  });

  it("can cover both columns and restore them one at a time", () => {
    let state: ReadonlySet<string> = new Set();
    state = toggleConcealed(state, "a");
    state = toggleConcealed(state, "b");
    expect(state.size).toBe(2);

    state = toggleConcealed(state, "a");
    expect(state.has("a")).toBe(false);
    expect(state.has("b")).toBe(true);
  });

  it("drops ids whose tabs are gone", () => {
    const state = pruneConcealed(new Set(["a", "b"]), ["b", "c"]);
    expect([...state]).toEqual(["b"]);
  });

  it("returns the same set when nothing was closed", () => {
    const state: ReadonlySet<string> = new Set(["a"]);
    expect(pruneConcealed(state, ["a", "b"])).toBe(state);
  });
});
