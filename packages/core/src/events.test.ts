import { describe, expect, it } from "vitest";
import { fixtureRun } from "./fixtures/index.ts";

describe("fixture run", () => {
  it("starts with run.started and ends with run.finished", () => {
    expect(fixtureRun[0]?.type).toBe("run.started");
    expect(fixtureRun.at(-1)?.type).toBe("run.finished");
  });

  it("follows every step.started with its own step.finished", () => {
    const open = new Set<string>();
    for (const event of fixtureRun) {
      if (event.type === "step.started") open.add(event.stepId);
      if (event.type === "step.finished") expect(open.delete(event.stepId)).toBe(true);
    }
    expect(open.size).toBe(0);
  });

  it("gives every evidence node and edge a stable key", () => {
    const evidence = fixtureRun.flatMap((event) => (event.type === "step.finished" ? [event.evidence] : []));
    expect(evidence.length).toBeGreaterThan(0);
    for (const { nodes, edges } of evidence) {
      for (const node of nodes) expect(node.key).not.toBe("");
      for (const edge of edges) expect(edge.key).toBe(`${edge.fromKey}|${edge.type}|${edge.toKey}`);
    }
  });

  it("cites only steps of this run in its report", () => {
    const steps = new Set<string>(
      fixtureRun.flatMap((event) => (event.type === "step.started" ? [event.stepId] : [])),
    );
    const last = fixtureRun.at(-1);
    const report = last?.type === "run.finished" ? last.report : "";
    const cited = [...report.matchAll(/\[s:([0-9A-Z]{26})\]/g)].map((match) => match[1]);
    expect(cited.length).toBeGreaterThan(0);
    for (const id of cited) expect(steps.has(id ?? "")).toBe(true);
  });
});
