import { describe, expect, it } from "vitest";
import { GraphError } from "./errors.ts";
import { json } from "./values.ts";

class Instant {
  toJSON(): string {
    return "2026-10-15";
  }
}

class Opaque {
  readonly secret = 1;
}

describe("json", () => {
  it("keeps scalars, lists, and maps", () => {
    expect(json({ i: 1, f: 1.5, t: true, n: null, s: "x", l: [1, "a"], m: { a: [2] } }, "t.q")).toEqual({
      i: 1,
      f: 1.5,
      t: true,
      n: null,
      s: "x",
      l: [1, "a"],
      m: { a: [2] },
    });
  });

  it("keeps a node in the client's shape", () => {
    const node = { id: 3, labels: ["Install"], properties: { lock_path: "node_modules/qs", dev: false } };
    expect(json(node, "t.q")).toEqual(node);
  });

  it("turns a temporal value into its ISO text", () => {
    expect(json({ d: new Instant() }, "t.q")).toEqual({ d: "2026-10-15" });
  });

  it.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["undefined", undefined],
    ["a function", () => 1],
    ["a class instance without toJSON", new Opaque()],
  ])("rejects %s with graph.row", (_, value) => {
    expect(() => json({ v: value }, "t.q")).toThrow(GraphError);
    try {
      json({ v: value }, "t.q");
    } catch (error) {
      expect(error).toMatchObject({ code: "graph.row", surface: "internal" });
      expect((error as GraphError).message.startsWith("t.q: ")).toBe(true);
    }
  });
});
