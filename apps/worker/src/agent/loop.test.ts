import type { Block, Db, G, Json, Message, Model, RunEvent, Turn } from "@noderunner/core";
import { connect } from "@noderunner/graph";
import { query } from "@noderunner/graph/cypher";
import { createToolbox, createTools, type Toolbox } from "@noderunner/tools";
import { ids, manual, packuments, seeded } from "@noderunner/tools/fixture";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { Recorded } from "../adapters/model/recorded.ts";
import { runAgent } from "./loop.ts";

const url = process.env.FALKORDB_URL ?? "redis://localhost:6379";
const never = new AbortController().signal;
const QS = "GHSA-hrpp-h998-j3pp|qs";
const EXPRESS = "GHSA-rv95-896h-c2vc|express";
const usage = { input: 100, output: 10, cached: 0 };
const log = { info: () => {}, warn: () => {}, error: () => {} };
let db: Db;
const made: G[] = [];

const call = (id: string, name: string, input: { readonly [key: string]: Json } = {}): Block => ({
  type: "tool_use",
  id,
  name,
  input,
});
const tools = (...calls: Block[]): Turn => ({ stop: "tool_use", content: calls, usage });
const say = (text: string): Turn => ({ stop: "end", content: [{ type: "text", text }], usage });

/** The tool results the loop has sent so far, parsed from what the model receives. */
function results(messages: readonly Message[]): { tool: string; stepId: string; ok: boolean }[] {
  return messages
    .flatMap((m) => m.content)
    .filter((b): b is Extract<Block, { type: "tool_result" }> => b.type === "tool_result")
    .map((b) => JSON.parse(b.content) as { tool: string; stepId: string; ok: boolean });
}

/** A model that runs the default calls, then writes a report citing the step ids it was actually given. */
class Scripted implements Model {
  readonly requests: Parameters<Model["turn"]>[0][] = [];
  constructor(private readonly reports: ((ids: Record<string, string>) => string)[]) {}
  async turn(request: Parameters<Model["turn"]>[0]): Promise<Turn> {
    this.requests.push(structuredClone(request));
    if (this.requests.length === 1) {
      return tools(
        call("c1", "list_alerts"),
        call("c2", "reachability"),
        call("c3", "plan_upgrades", { tiers: ["import-reachable"] }),
      );
    }
    const seen = Object.fromEntries(results(request.messages).map((r) => [r.tool, r.stepId]));
    const write = this.reports[this.requests.length - 2] ?? this.reports.at(-1);
    return say(write === undefined ? "" : write(seen));
  }
}

const valid = (s: Record<string, string>) => `## Funnel
| Stage | Count |
| --- | --- |
| All alerts | 4 [s:${s.list_alerts}] |
| In the production tree | 3 [s:${s.reachability}] |
| Import-reachable | 2 [s:${s.reachability}] |
| Still open after the plan | 0 [s:${s.plan_upgrades}] |

One refresh of express closes both reachable findings [s:${s.plan_upgrades}].

\`\`\`result
{"mustFix": ["${QS}", "${EXPRESS}"], "upgrades": [{"package": "express", "to": "4.22.3"}]}
\`\`\`
`;

function box(clock = manual()): Toolbox {
  return createToolbox(
    { db, clock, ids, tools: createTools({ db, clock, ids, registry: packuments() }) },
    { access: ["read", "derive", "act"] },
  );
}

async function run(model: Model, signal = never) {
  const { g, ctx } = await seeded(db, made);
  const events: RunEvent[] = [];
  const clock = manual();
  const outcome = await runAgent(
    {
      model,
      modelId: "test/scripted",
      toolbox: box(clock),
      tools: createTools({ db, clock, ids, registry: packuments() }),
      db,
      clock,
      log,
    },
    {
      repo: { owner: "acme", name: "mini-repo" },
      graph: ctx.graph,
      runId: ctx.runId,
      agent: "triage",
      kickoff: {},
      hooks: { onStart: () => {}, onFinish: () => {} },
      emit: (event) => events.push(event),
      signal,
    },
  );
  return { g, ctx, events, outcome };
}

const stored = query(
  "test.run",
  "MATCH (r:Run {id: $id}) OPTIONAL MATCH (r)-[:HAS_STEP]->(s:Step) RETURN r.status AS status, r.result AS result, r.unverified AS unverified, r.tokens_in AS tokensIn, r.tokens_out AS tokensOut, r.finished_at AS finished, collect(s.id) AS steps",
  z.object({
    status: z.string(),
    result: z.string().nullable(),
    unverified: z.boolean(),
    tokensIn: z.number(),
    tokensOut: z.number(),
    finished: z.number().nullable(),
    steps: z.array(z.string()),
  }),
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

describe("runAgent", () => {
  it("runs the tools, writes a verified report, and stores the run", async () => {
    const { g, ctx, events, outcome } = await run(new Scripted([valid]));
    expect(outcome).toMatchObject({ status: "done", unverified: false, tokens: { input: 200, output: 20 } });
    expect(outcome.result).toEqual({
      mustFix: [QS, EXPRESS],
      upgrades: [{ package: "express", to: "4.22.3" }],
    });
    const [row] = await g.query(stored, { id: ctx.runId }, never);
    expect(row).toMatchObject({ status: "done", unverified: false, tokensIn: 200, tokensOut: 20 });
    expect(JSON.parse(row?.result ?? "null")).toEqual(outcome.result);
    expect(row?.finished).not.toBeNull();
    expect(events.map((e) => e.type)).toEqual([
      "run.started",
      "step.started",
      "step.finished",
      "step.started",
      "step.finished",
      "step.started",
      "step.finished",
      "run.finished",
    ]);
    const started = events
      .filter((e) => e.type === "step.started")
      .map((e) => (e.type === "step.started" ? e.stepId : ""));
    expect(new Set(row?.steps)).toEqual(new Set(started));
  });

  it("sends one correction for an unknown citation and accepts the fixed report", async () => {
    const bad = (s: Record<string, string>) =>
      valid(s).replace("closes both reachable findings [s:", "closes both [s:nope] [s:");
    const model = new Scripted([bad, valid]);
    const { outcome } = await run(model);
    expect(outcome).toMatchObject({ status: "done", unverified: false });
    const correction = model.requests[2]?.messages.at(-1)?.content[0];
    expect(correction?.type === "text" && correction.text).toContain("[s:nope] is not a step of this run");
  });

  it("stores the second invalid report as unverified", async () => {
    const wrong = (s: Record<string, string>) =>
      valid(s).replace("| Import-reachable | 2", "| Import-reachable | 9");
    const { g, ctx, outcome } = await run(new Scripted([wrong, wrong]));
    expect(outcome).toMatchObject({ status: "done", unverified: true });
    expect((await g.query(stored, { id: ctx.runId }, never))[0]?.unverified).toBe(true);
  });

  it("stops at 15 calls, never runs the 16th, and asks for the report with no tools", async () => {
    const many = Array.from({ length: 16 }, (_, i) => call(`c${i}`, "list_alerts"));
    const model = new Recorded([tools(...many), say("the report")]);
    const { g, ctx, outcome } = await run(model);
    expect(outcome).toMatchObject({ status: "capped", report: "the report" });
    expect((await g.query(stored, { id: ctx.runId }, never))[0]?.steps).toHaveLength(15);
    const last = model.requests[1];
    expect(last?.tools).toEqual([]);
    const skipped = last?.messages.at(-1)?.content.filter((b) => b.type === "tool_result" && b.isError);
    expect(skipped?.map((b) => (b.type === "tool_result" ? b.toolUseId : ""))).toEqual(["c15"]);
  });

  it("fails a capped run whose final turn is refused", async () => {
    const many = Array.from({ length: 16 }, (_, i) => call(`c${i}`, "list_alerts"));
    const { outcome } = await run(new Recorded([tools(...many), { stop: "refusal", content: [], usage }]));
    expect(outcome).toMatchObject({ status: "failed", result: null });
  });

  it("returns a bad tool input to the model as an error and carries on", async () => {
    const model = new Recorded([
      tools(call("c1", "reachability", { keys: "not a list" })),
      say("done"),
      say("done"),
    ]);
    const { outcome } = await run(model);
    const sent = model.requests[1]?.messages.at(-1)?.content[0];
    expect(sent?.type === "tool_result" && sent.isError).toBe(true);
    expect(outcome).toMatchObject({ status: "done", unverified: true });
  });

  it("sends an opaque reasoning block back unchanged", async () => {
    const opaque: Block = {
      type: "opaque",
      carry: { provider: "openai", raw: { type: "reasoning", encrypted_content: "x1y2" } },
    };
    const model = new Recorded([
      { stop: "tool_use", content: [opaque, call("c1", "list_alerts")], usage },
      say("done"),
    ]);
    await run(model);
    expect(model.requests[1]?.messages[1]?.content[0]).toEqual(opaque);
  });

  it("fails on a refusal, and on a cancelled run, and still records the end", async () => {
    const refused = await run(new Recorded([{ stop: "refusal", content: [], usage }]));
    expect(refused.outcome).toMatchObject({
      status: "failed",
      report: "The model refused to continue this run.",
    });
    const controller = new AbortController();
    controller.abort();
    const cancelled = await run(new Recorded([say("never")]), controller.signal);
    expect(cancelled.outcome).toMatchObject({ status: "failed", report: "The run was cancelled." });
    expect((await cancelled.g.query(stored, { id: cancelled.ctx.runId }, never))[0]?.finished).not.toBeNull();
  });
});
