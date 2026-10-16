import { randomBytes } from "node:crypto";
import {
  type Db,
  type G,
  GraphName,
  type Json,
  limits,
  RunId,
  type StepId,
  type ToolCtx,
} from "@noderunner/core";
import { connect } from "@noderunner/graph";
import { memory, query, write } from "@noderunner/graph/cypher";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createToolbox, type StepHooks } from "./call.ts";
import type { AnyTool } from "./registry.ts";

const url = process.env.FALKORDB_URL ?? "redis://localhost:6379";
const never = new AbortController().signal;
let db: Db;
const made: G[] = [];
let tick = 0;

function ulid(): string {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  return [...randomBytes(26)]
    .map((byte) => alphabet[byte % 32])
    .join("")
    .replace(/^./, "0");
}

async function started(): Promise<{ g: G; ctx: ToolCtx }> {
  const g = db.graph(GraphName.parse(`verify:${ulid().toLowerCase()}`));
  made.push(g);
  const runId = RunId.parse(ulid());
  await g.query(memory.run.start, { id: runId, agent: "triage", model: null, now: 0 }, never);
  return { g, ctx: { graph: g.name, runId, actor: "triage", signal: never } };
}

/** A stand-in tool under a real tool name, so callTool's own behaviour can be tested in isolation. */
function stub(
  behaviour: (signal: AbortSignal) => Promise<unknown>,
  timeoutMs: number = limits.toolMs,
): AnyTool {
  return {
    name: "list_alerts",
    description: "test",
    input: z.object({ n: z.number().int() }).strict(),
    access: "derive",
    timeoutMs,
    async run(ctx) {
      const data = await behaviour(ctx.signal);
      return { data, summary: "ran", evidence: { nodes: [], edges: [], cypher: [] } };
    },
  };
}

function recorder() {
  const starts: { stepId: StepId; seq: number; tool: string; input: Json }[] = [];
  const finishes: Parameters<StepHooks["onFinish"]>[0][] = [];
  const hooks: StepHooks = { onStart: (s) => starts.push(s), onFinish: (s) => finishes.push(s) };
  return { starts, finishes, hooks };
}

function box(tools: readonly AnyTool[]) {
  return createToolbox(
    { db, clock: { now: () => (tick += 1) }, ids: { next: ulid }, tools },
    { access: ["read", "derive", "act"] },
  );
}

const steps = query(
  "test.steps",
  "MATCH (:Run {id: $runId})-[:HAS_STEP]->(s:Step) RETURN s.id AS id, s.seq AS seq, s.tool AS tool, s.ok AS ok, s.summary AS summary ORDER BY seq LIMIT 50",
  z.object({ id: z.string(), seq: z.number(), tool: z.string(), ok: z.boolean(), summary: z.string() }),
);

beforeAll(async () => {
  db = await connect({ url, signal: never, onError: () => {} });
});

afterEach(async () => {
  for (const g of made.splice(0)) await g.drop();
});

afterAll(async () => {
  await db.close();
});

describe("callTool", () => {
  it("writes one Step per call, numbered in order, and passes the stored ids to onStart", async () => {
    const { g, ctx } = await started();
    const { starts, finishes, hooks } = recorder();
    const toolbox = box([stub(async () => ({ fine: true }))]);
    const first = await toolbox.callTool("list_alerts", { n: 1 }, ctx, hooks);
    const second = await toolbox.callTool("list_alerts", { n: 2 }, ctx, hooks);
    expect(first).toMatchObject({ ok: true, data: { fine: true }, summary: "ran" });
    const stored = await g.query(steps, { runId: ctx.runId }, never);
    expect(stored.map((s) => [s.id, s.seq, s.ok])).toEqual([
      [first.stepId, 1, true],
      [second.stepId, 2, true],
    ]);
    expect(starts.map((s) => [s.stepId, s.seq, s.input])).toEqual([
      [first.stepId, 1, { n: 1 }],
      [second.stepId, 2, { n: 2 }],
    ]);
    expect(finishes.map((f) => f.ok)).toEqual([true, true]);
  });

  it("records a call with bad input, and tells the caller which field is wrong", async () => {
    const { g, ctx } = await started();
    const { finishes, hooks } = recorder();
    const result = await box([stub(async () => 1)]).callTool("list_alerts", { n: "x" }, ctx, hooks);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain("n:");
    expect(await g.query(steps, { runId: ctx.runId }, never)).toMatchObject([
      { id: result.stepId, ok: false },
    ]);
    expect(finishes[0]).toMatchObject({ ok: false, code: "invalid" });
  });

  it("records a call to an unknown tool and to a tool outside the actor's set", async () => {
    const { g, ctx } = await started();
    const { hooks } = recorder();
    const toolbox = box([stub(async () => 1)]);
    const unknown = await toolbox.callTool("make_coffee", {}, ctx, hooks);
    const outside = await toolbox.callTool("list_alerts", { n: 1 }, { ...ctx, actor: "ui" }, hooks);
    expect(unknown).toMatchObject({ ok: false, error: "Tool make_coffee is not available to this agent" });
    expect(outside).toMatchObject({ ok: false, error: "Tool list_alerts is not available to this agent" });
    expect((await g.query(steps, { runId: ctx.runId }, never)).map((s) => [s.tool, s.ok])).toEqual([
      ["make_coffee", false],
      ["list_alerts", false],
    ]);
  });

  it("cuts a tool off at its own timeout even when it ignores the signal", async () => {
    const { g, ctx } = await started();
    const { finishes, hooks } = recorder();
    const hang = stub(() => new Promise(() => {}), 50);
    const result = await box([hang]).callTool("list_alerts", { n: 1 }, ctx, hooks);
    expect(result).toMatchObject({ ok: false, error: "The tool timed out after 0.05 s" });
    expect(finishes[0]?.code).toBe("upstream");
    expect((await g.query(steps, { runId: ctx.runId }, never))[0]?.ok).toBe(false);
  });

  it("lets a tool with a longer timeout finish", async () => {
    const { ctx } = await started();
    const slow = stub(() => new Promise((resolve) => setTimeout(() => resolve("done"), 120)), 1_000);
    const result = await box([slow]).callTool("list_alerts", { n: 1 }, ctx, recorder().hooks);
    expect(result).toMatchObject({ ok: true, data: "done" });
  });

  it("reports a cancelled run as internal and still records the Step", async () => {
    const { g, ctx } = await started();
    const controller = new AbortController();
    const { finishes, hooks } = recorder();
    const waits = stub(() => new Promise(() => controller.abort()));
    const result = await box([waits]).callTool(
      "list_alerts",
      { n: 1 },
      { ...ctx, signal: controller.signal },
      hooks,
    );
    expect(result).toMatchObject({ ok: false, error: "The run was cancelled" });
    expect(finishes[0]?.code).toBe("internal");
    expect((await g.query(steps, { runId: ctx.runId }, never))[0]?.summary).toBe("The run was cancelled");
  });

  it("does not call onStart when the run does not exist, and says the step was not recorded", async () => {
    const { ctx } = await started();
    const { starts, finishes, hooks } = recorder();
    const result = await box([stub(async () => 1)]).callTool(
      "list_alerts",
      { n: 1 },
      { ...ctx, runId: RunId.parse(ulid()) },
      hooks,
    );
    expect(result).toMatchObject({ ok: false, error: "The step could not be recorded" });
    expect(starts).toEqual([]);
    expect(finishes[0]).toMatchObject({ ok: false, code: "internal" });
  });

  it("caps evidence at 300 nodes and links exactly those to the Step", async () => {
    const { g, ctx } = await started();
    await g.batch(
      write("test.nodes", "UNWIND $rows AS r CREATE (:N {k: r.k})"),
      Array.from({ length: 400 }, (_, k) => ({ k })),
      {},
      never,
    );
    const ids = await g.query(
      query(
        "test.ids",
        "MATCH (n:N) RETURN id(n) AS id, n.k AS k ORDER BY k LIMIT 400",
        z.object({ id: z.number(), k: z.number() }),
      ),
      {},
      never,
    );
    const many: AnyTool = {
      ...stub(async () => 1),
      async run() {
        return {
          data: 1,
          summary: "many",
          evidence: {
            nodes: ids.map((row) => ({ id: row.id, key: `k${row.k}`, label: "N", name: `k${row.k}` })),
            edges: [],
            cypher: [],
          },
        };
      },
    };
    const result = await box([many]).callTool("list_alerts", { n: 1 }, ctx, recorder().hooks);
    expect(result.ok && result.evidence.nodes.length).toBe(300);
    expect(result.ok && result.summary).toBe("many (evidence capped)");
    const touched = await g.query(
      query(
        "test.touched",
        "MATCH (:Step {id: $id})-[t:TOUCHED]->() RETURN count(t) AS n",
        z.object({ n: z.number() }),
      ),
      { id: result.stepId },
      never,
    );
    expect(touched).toEqual([{ n: 300 }]);
  });
});
