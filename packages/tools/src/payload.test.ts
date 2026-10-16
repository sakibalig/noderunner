import { limits, type StepId } from "@noderunner/core";
import { describe, expect, it } from "vitest";
import { Collector, cap } from "./evidence.ts";
import { forModel } from "./payload.ts";
import { available, createTools } from "./registry.ts";

const stepId = "01JQZ8ABCDEFGHJKMNPQRSTVWX" as StepId;
const empty = { nodes: [], edges: [], cypher: [] };

describe("forModel", () => {
  it("never includes evidence", () => {
    const text = forModel("reachability", {
      ok: true,
      data: { a: 1 },
      summary: "s",
      evidence: { nodes: [{ id: 1, key: "k", label: "L", name: "n" }], edges: [], cypher: ["MATCH"] },
      stepId,
    });
    expect(JSON.parse(text)).toEqual({ tool: "reachability", ok: true, summary: "s", data: { a: 1 } });
  });

  it("trims a 9,000-character result to valid JSON within the limit and counts what it left out", () => {
    const data = { rows: Array.from({ length: 300 }, (_, i) => ({ key: `GHSA-${i}|pkg-${i}`, n: i })) };
    const before = JSON.stringify(data).length;
    const text = forModel("list_alerts", { ok: true, data, summary: "s", evidence: empty, stepId });
    const parsed = JSON.parse(text);
    expect(before).toBeGreaterThan(9_000);
    expect(text.length).toBeLessThanOrEqual(limits.modelChars);
    expect(parsed.omitted).toBe(300 - parsed.data.rows.length);
    expect(parsed.data.rows[0]).toEqual({ key: "GHSA-0|pkg-0", n: 0 });
  });

  it("halves an oversized string when no array is left to trim", () => {
    const text = forModel("x", {
      ok: true,
      data: { note: "y".repeat(20_000) },
      summary: "s",
      evidence: empty,
      stepId,
    });
    expect(text.length).toBeLessThanOrEqual(limits.modelChars);
    expect(JSON.parse(text).data.note.endsWith("…")).toBe(true);
  });

  it("gives the error alone for a failed call, and the same text every time", () => {
    const failed = { ok: false as const, error: "No finding has the key x", stepId };
    expect(JSON.parse(forModel("reachability", failed))).toEqual({
      tool: "reachability",
      ok: false,
      error: "No finding has the key x",
    });
    const data = { rows: Array.from({ length: 300 }, (_, i) => ({ i })) };
    const result = { ok: true as const, data, summary: "s", evidence: empty, stepId };
    expect(forModel("x", result)).toBe(forModel("x", result));
  });
});

describe("evidence", () => {
  it("keeps each node and edge once and builds the edge key", () => {
    const collected = new Collector()
      .node({ id: 1, key: "a", label: "File", name: "a" })
      .node({ id: 1, key: "a", label: "File", name: "a" })
      .edge({ id: 7, type: "LOADS", from: 1, to: 2, fromKey: "a", toKey: "b" })
      .ran("Q")
      .ran("Q")
      .done();
    expect(collected.nodes).toHaveLength(1);
    expect(collected.edges[0]?.key).toBe("a|LOADS|b");
    expect(collected.cypher).toEqual(["Q"]);
  });

  it("drops edges whose endpoints were cut", () => {
    const nodes = Array.from({ length: 301 }, (_, id) => ({ id, key: `n${id}`, label: "N", name: "n" }));
    const edges = [
      { id: 1, key: "n0|E|n1", type: "E", from: 0, to: 1, fromKey: "n0", toKey: "n1" },
      { id: 2, key: "n0|E|n300", type: "E", from: 0, to: 300, fromKey: "n0", toKey: "n300" },
    ];
    const capped = cap({ nodes, edges, cypher: [] });
    expect(capped.evidence.nodes).toHaveLength(300);
    expect(capped.evidence.edges.map((edge) => edge.id)).toEqual([1]);
    expect(capped.dropped).toBe(2);
  });
});

describe("available", () => {
  const tools = createTools({
    db: {
      graph: () => {
        throw new Error("unused");
      },
      list: async () => [],
      close: async () => {},
    },
    clock: { now: () => 0 },
    ids: { next: () => "x" },
  });

  const names = (actor: Parameters<typeof available>[0], access: Parameters<typeof available>[1]) =>
    available(actor, access, tools).map((t) => t.name);

  it("gives each actor the contract's tools that are built", () => {
    const all = ["read", "derive", "act"] as const;
    expect(names("triage", all)).toEqual([
      "recall_decisions",
      "list_alerts",
      "reachability",
      "introduced_by",
      "record_decision",
      "read_only_cypher",
    ]);
    expect(names("fixer", all)).toEqual(["recall_decisions", "list_alerts", "read_only_cypher"]);
    expect(names("baseline", all)).toEqual(["list_alerts"]);
    expect(names("ui", all)).toEqual(["record_decision"]);
  });

  it("keeps act tools from MCP unless writes are allowed, and derive tools from a read-only client", () => {
    expect(names("mcp", ["read", "derive"])).toEqual([
      "recall_decisions",
      "list_alerts",
      "reachability",
      "introduced_by",
      "read_only_cypher",
    ]);
    expect(names("mcp", ["read"])).toEqual(["introduced_by", "read_only_cypher"]);
  });
});
