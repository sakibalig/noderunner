import { fixtureRun } from "@noderunner/core/fixtures";
import { describe, expect, it } from "vitest";
import { elements, short } from "./canvas.ts";
import { initial, reducer } from "./reducer.ts";

const state = fixtureRun.reduce(reducer, initial("live"));
const reach = state.order.find((id) => state.steps[id]?.tool === "reachability") ?? "";

describe("elements", () => {
  it("uses stable keys as ids and points edges at existing nodes", () => {
    const all = elements(state.graph, state.highlight);
    const ids = new Set(all.filter((e) => e.group === "nodes").map((e) => e.data.id));
    for (const edge of all.filter((e) => e.group === "edges")) {
      expect(ids.has(edge.data.source ?? "")).toBe(true);
      expect(ids.has(edge.data.target ?? "")).toBe(true);
    }
    expect(ids.has("src/server.js")).toBe(true);
  });

  it("marks nothing until a step is selected", () => {
    expect(elements(state.graph, state.highlight).some((e) => /\b(on|dim)\b/.test(e.classes))).toBe(false);
  });

  it("lights the selected step's path and dims everything else", () => {
    const selected = reducer(state, { type: "select", stepId: reach });
    const all = elements(selected.graph, selected.highlight);
    const on = all.filter((e) => e.classes.split(" ").includes("on")).map((e) => e.data.id);
    expect(on).toContain("src/server.js");
    expect(on).toContain("node_modules/qs");
    expect(on.some((id) => id?.includes("|DEPENDS_ON|"))).toBe(true);
    expect(all.some((e) => e.classes.split(" ").includes("dim"))).toBe(true);
  });
});

describe("short", () => {
  it("shows the installed package name, not its full lock path", () => {
    expect(short("node_modules/a/node_modules/@scope/b")).toBe("@scope/b");
  });

  it("cuts long names from the front", () => {
    expect(short("x".repeat(40))).toHaveLength(28);
  });
});
