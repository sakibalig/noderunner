import { randomBytes } from "node:crypto";
import {
  type Db,
  type Fault,
  type GraphName,
  graphName,
  PlanId,
  type RunEvent,
  StepId,
  type ToolResult,
} from "@noderunner/core";
import { connect } from "@noderunner/graph";
import { query, write } from "@noderunner/graph/cypher";
import type { Toolbox } from "@noderunner/tools";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { GraphShipments } from "./shipments.ts";

// Integration: a real FalkorDB; the toolbox is a stand-in for open_pull_request.
const url = process.env.FALKORDB_URL ?? "redis://localhost:6379";
const never = new AbortController().signal;
const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const token = (n: number) => [...randomBytes(n)].map((b) => alphabet[b % 32]).join("");
const STEP = StepId.parse("01JQZ8STEP00000000000000AA");
let db: Db;
const made: GraphName[] = [];

const seed = write(
  "test.shipSeed",
  `CREATE (:Run {id: $runId})-[:PROPOSED]->(:Plan {id: $planId, created_at: 1, total_cost: 1, uncovered: [],
                                                approved: true})`,
);
const runs = query(
  "test.uiRuns",
  `MATCH (r:Run {agent: "ui"}) RETURN r.status AS status, r.report AS report`,
  z.object({ status: z.string(), report: z.string() }),
);
const verification = { targeted: 1, closed: 1, stillOpen: [], newFindings: [] };
const log = { info: () => {}, warn: () => {}, error: () => {} };

beforeAll(async () => {
  db = await connect({ url, signal: never, onError: () => {} });
});
afterEach(async () => {
  for (const name of made.splice(0))
    await db
      .graph(name as never)
      .drop()
      .catch(() => undefined);
});
afterAll(async () => {
  await db.close();
});

/** A toolbox whose open_pull_request answers with `result`, reporting `code` the way callTool does. */
function toolbox(result: ToolResult<unknown>, code?: Fault["surface"]): Toolbox {
  return {
    async callTool(tool, input, _ctx, hooks) {
      hooks.onStart({ stepId: STEP, seq: 1, tool, input: input as never });
      hooks.onFinish({ stepId: STEP, ok: result.ok, summary: "s", ms: 3, ...(code ? { code } : {}) });
      return result;
    },
  };
}

async function fixture(result: ToolResult<unknown>, code?: Fault["surface"]) {
  const graph = graphName({ owner: "acme", name: `api-${token(8).toLowerCase()}` });
  made.push(graph);
  const planId = PlanId.parse(`01JQZ8${token(20)}`);
  await db.graph(graph).query(seed, { runId: `01JQZ8${token(20)}`, planId }, never);
  let next = 0;
  const shipments = new GraphShipments({
    db,
    clock: { now: () => 1 },
    ids: { next: () => `01JQZ8${token(19)}${next++}` },
    toolbox: toolbox(result, code),
    log,
  });
  const events: RunEvent[] = [];
  return { graph, planId, shipments, events, emit: (e: RunEvent) => events.push(e) };
}

describe("GraphShipments", () => {
  it("locates a plan with its approval, and null for an unknown one", async () => {
    const { graph, planId, shipments } = await fixture({ ok: false, error: "x", stepId: STEP });
    expect(await shipments.locate(planId, never)).toEqual({ graph, approved: true, shipped: null });
    expect(await shipments.locate(`01JQZ8${token(20)}`, never)).toBeNull();
  });

  it("streams the step and ends with pr.opened, recording a finished ui run", async () => {
    const shipment = {
      outcome: "opened",
      url: "https://github.com/sakibalig/api/pull/1",
      branch: "b",
      verification,
    };
    const { graph, planId, shipments, events, emit } = await fixture({
      ok: true,
      data: shipment,
      summary: "Opened",
      evidence: { nodes: [], edges: [], cypher: [] },
      stepId: STEP,
    });
    await shipments.ship(graph, planId, emit, never);
    expect(events.map((e) => e.type)).toEqual(["step.started", "step.finished", "pr.opened"]);
    expect(events.at(-1)).toEqual({ type: "pr.opened", planId, url: shipment.url, verification });
    expect(await db.graph(graph).query(runs, {}, never)).toEqual([{ status: "done", report: "Opened" }]);
  });

  it("ends a verification refusal with pr.refused carrying the verification", async () => {
    const refused = { outcome: "refused", reason: "new reachable finding", verification };
    const { graph, planId, shipments, events, emit } = await fixture({
      ok: true,
      data: refused,
      summary: "Refused",
      evidence: { nodes: [], edges: [], cypher: [] },
      stepId: STEP,
    });
    await shipments.ship(graph, planId, emit, never);
    expect(events.at(-1)).toEqual({
      type: "pr.refused",
      planId,
      reason: "new reachable finding",
      verification,
    });
  });

  it.each([
    ["unapproved", "pr.refused"],
    ["shipped", "pr.refused"],
    ["busy", "pr.refused"],
    ["upstream", "job.failed"],
    ["missing", "job.failed"],
  ] as const)("ends a tool failure with %s as %s", async (code, type) => {
    const { graph, planId, shipments, events, emit } = await fixture(
      { ok: false, error: "no", stepId: STEP },
      code,
    );
    await shipments.ship(graph, planId, emit, never);
    const last = events.at(-1);
    expect(last?.type).toBe(type);
    if (last?.type === "pr.refused") expect(last.verification).toBeNull();
    if (last?.type === "job.failed") expect(last.code).toBe(code);
    expect(await db.graph(graph).query(runs, {}, never)).toEqual([{ status: "failed", report: "no" }]);
  });
});
