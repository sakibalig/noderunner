import { randomBytes } from "node:crypto";
import { type Db, graphName, type RunEvent, RunId, StepId } from "@noderunner/core";
import { connect } from "@noderunner/graph";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { GraphArchive } from "./archive.ts";

// Integration: a real FalkorDB from `docker compose up falkordb`.
const url = process.env.FALKORDB_URL ?? "redis://localhost:6379";
const never = new AbortController().signal;
const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const token = (n: number) => [...randomBytes(n)].map((b) => alphabet[b % 32]).join("");
let db: Db;
const made: string[] = [];

beforeAll(async () => {
  db = await connect({ url, signal: never, onError: () => {} });
});
afterEach(async () => {
  const { FalkorDB } = await import("falkordb");
  const raw = await FalkorDB.connect({ url });
  for (const name of made.splice(0))
    await raw
      .selectGraph(name)
      .delete()
      .catch(() => undefined);
  await raw.close();
});
afterAll(async () => {
  await db.close();
});

describe("GraphArchive", () => {
  it("stores a run's events on its Run node and finds them by id across repository graphs", async () => {
    const graph = graphName({ owner: "acme", name: `api-${token(8).toLowerCase()}` });
    made.push(graph);
    const runId = RunId.parse(`01JQZ8${token(20)}`);
    const stepId = StepId.parse(`01JQZ8${token(20)}`);
    const archive = new GraphArchive(db, { now: () => 42 });
    const events: RunEvent[] = [
      { type: "run.started", runId, agent: "triage", model: "openai/gpt-5" },
      { type: "step.started", stepId, seq: 1, tool: "list_alerts", input: {} },
      { type: "run.finished", runId, status: "done", unverified: false, report: "done" },
    ];
    await archive.begin(graph, runId, "openai/gpt-5");
    expect(await archive.find(runId, never)).toBeNull();
    await archive.save(graph, runId, events);
    expect(await archive.find(runId, never)).toEqual(events);
    expect(await archive.find(RunId.parse(`01JQZ8${token(20)}`), never)).toBeNull();
  });
});
