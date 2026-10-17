import { describe, expect, it } from "vitest";
import { score, spread } from "./score.ts";

const L = new Set(["a", "b", "c", "d"]);

describe("score", () => {
  it.each([
    ["an exact match", ["a", "b", "c", "d"], { precision: 1, recall: 1, hits: 4 }],
    ["one false positive", ["a", "b", "c", "d", "x"], { precision: 0.8, recall: 1, hits: 4 }],
    ["one miss", ["a", "b", "c"], { precision: 1, recall: 0.75, hits: 3 }],
    ["an empty mustFix", [], { precision: null, recall: 0, hits: 0 }],
    ["a missing result block", null, { precision: null, recall: 0, hits: 0 }],
    ["duplicates counted once", ["a", "a"], { precision: 1, recall: 0.25, hits: 1 }],
  ])("scores %s", (_, mustFix, want) => {
    expect(score(mustFix, L)).toEqual(want);
  });

  it("has no recall when nothing is labelled reachable", () => {
    expect(score(["a"], new Set()).recall).toBeNull();
  });
});

describe("spread", () => {
  it("takes the median and range of known values", () => {
    expect(spread([3, null, 1, 2])).toEqual({ median: 2, min: 1, max: 3 });
    expect(spread([1, 2, 3, 4])).toEqual({ median: 2.5, min: 1, max: 4 });
    expect(spread([null])).toEqual({ median: null, min: null, max: null });
  });
});
