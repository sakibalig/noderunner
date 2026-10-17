import type { RunEvent } from "@noderunner/core";
import { fixtureRun } from "@noderunner/core/fixtures";
import { describe, expect, it } from "vitest";
import { initial, type RunViewState, reducer } from "./reducer.ts";

const fold = (
  events: readonly (RunEvent | Parameters<typeof reducer>[1])[],
  from: RunViewState = initial("live"),
) => events.reduce(reducer, from);

describe("reducer over the recorded fixture run", () => {
  const state = fold(fixtureRun);
  const finished = fixtureRun.at(-1);

  it("orders every step and finishes them all", () => {
    const started = fixtureRun.filter((e) => e.type === "step.started");
    expect(state.order).toHaveLength(started.length);
    expect(Object.values(state.steps).every((s) => s.outcome.kind === "finished")).toBe(true);
  });

  it("ends with the stored report and the finished phase", () => {
    expect(state.report).toBe(finished?.type === "run.finished" ? finished.report : "");
    expect(state.phase).toEqual({ kind: "finished", status: "done", unverified: false });
    expect(state.model).toBe("openai/gpt-5");
  });

  it("unions evidence by stable key with no duplicates", () => {
    const keys = state.graph.nodes.map((n) => n.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain("node_modules/qs");
  });

  it("is idempotent: replaying every event again changes nothing but restarts from run.started", () => {
    expect(fold(fixtureRun, state).order).toEqual(state.order);
  });

  it("highlights the selected step's evidence and clears it", () => {
    const reach = state.order.find((id) => state.steps[id]?.tool === "reachability") ?? "";
    const selected = reducer(state, { type: "select", stepId: reach });
    expect(selected.highlight.nodes.has("src/server.js")).toBe(true);
    expect([...selected.highlight.edges].some((k) => k.includes("DEPENDS_ON"))).toBe(true);
    expect(reducer(selected, { type: "clear" }).highlight.nodes.size).toBe(0);
  });

  it("appends text deltas until run.finished replaces them", () => {
    const partial = fold(fixtureRun.filter((e) => e.type !== "run.finished"));
    expect(partial.report.length).toBeGreaterThan(0);
    expect(partial.phase.kind).toBe("running");
  });
});

describe("reducer edge cases", () => {
  it("caps the drawn graph at 400 nodes and counts the rest", () => {
    const nodes = Array.from({ length: 405 }, (_, i) => ({
      id: i,
      key: `k${i}`,
      label: "Install",
      name: `n${i}`,
    }));
    const stepId = "01JQZ8AAAAAAAAAAAAAAAAAAAA";
    const state = fold([
      {
        type: "step.finished",
        stepId: stepId as never,
        ok: true,
        summary: "",
        ms: 1,
        evidence: { nodes, edges: [], cypher: [] },
      },
    ]);
    expect([state.graph.nodes.length, state.graph.dropped]).toEqual([400, 5]);
  });
});
