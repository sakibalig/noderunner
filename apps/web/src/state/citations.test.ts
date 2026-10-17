import { describe, expect, it } from "vitest";
import { parts, readable } from "./citations.ts";

const A = "01JQZ8AAAAAAAAAAAAAAAAAAAA";
const B = "01JQZ8BBBBBBBBBBBBBBBBBBBB";

describe("parts", () => {
  it("turns known citations into numbered links and keeps the text around them", () => {
    expect(parts(`3 alerts [s:${A}]. done`, (id) => (id === A ? 2 : null))).toEqual([
      { kind: "text", text: "3 alerts " },
      { kind: "cite", stepId: A, n: 2 },
      { kind: "text", text: ". done" },
    ]);
  });

  it("leaves a citation to a step not in the run as plain text", () => {
    expect(parts(`x [s:${B}]`, () => null)).toEqual([{ kind: "text", text: `x [s:${B}]` }]);
  });
});

describe("readable", () => {
  it("drops the trailing result block", () => {
    expect(readable('Report\n\n```result\n{"mustFix":[]}\n```\n')).toBe("Report");
  });
});
