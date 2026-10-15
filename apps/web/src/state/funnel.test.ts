import { describe, expect, it } from "vitest";
import { widths } from "./funnel.ts";

describe("widths", () => {
  it("draws each bar as a share of all alerts", () => {
    expect(widths({ total: 3, production: 2, reachable: 1, open: 0 })).toEqual([100, 66.7, 33.3, 0]);
  });

  it("draws empty bars for a repository with no alerts", () => {
    expect(widths({ total: 0, production: 0, reachable: 0, open: 0 })).toEqual([0, 0, 0, 0]);
  });
});
