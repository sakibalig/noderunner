import { RunAccepted, RunCreate, type RunEvent, RunId, type RunView } from "@noderunner/core";
import { Hono, type MiddlewareHandler } from "hono";
import { WorkerError } from "../errors.ts";
import type { Catalog } from "../jobs/catalog.ts";
import type { Jobs } from "../jobs/queue.ts";
import type { Archive, Runs } from "../jobs/runs.ts";
import { repoParams } from "./repo.ts";
import { lastEventId, pump, replay } from "./stream.ts";

export const REPLAY_MS = 25_000;

const finished = (event: RunEvent) => event.type === "run.finished";

/** Folds a finished run's events into the run view. */
export function view(runId: string, events: readonly RunEvent[]): RunView {
  const started = events.find((e) => e.type === "run.started");
  const end = events.findLast((e) => e.type === "run.finished");
  const steps: RunView["steps"] = [];
  for (const event of events) {
    if (event.type !== "step.started") continue;
    const result = events.find((e) => e.type === "step.finished" && e.stepId === event.stepId);
    const done = result?.type === "step.finished" ? result : null;
    steps.push({
      stepId: event.stepId,
      seq: event.seq,
      tool: event.tool,
      input: event.input,
      ok: done?.ok ?? false,
      summary: done?.summary ?? "",
      cypher: done?.evidence.cypher ?? [],
      ms: done?.ms ?? 0,
    });
  }
  return {
    run: {
      runId: RunId.parse(runId),
      agent: started?.type === "run.started" ? started.agent : "triage",
      status: end?.type === "run.finished" ? end.status : "running",
      startedAt: 0,
      model: started?.type === "run.started" ? started.model : null,
      finishedAt: null,
      unverified: end?.type === "run.finished" ? end.unverified : false,
    },
    steps,
    report: end?.type === "run.finished" ? end.report : "",
  };
}

/** POST /runs, GET /runs/:id, and GET /runs/:id/events (live, resumed, or replayed from the graph). */
export function runs(deps: {
  readonly runs: Runs;
  readonly archive: Archive;
  readonly jobs: Jobs;
  readonly catalog: Catalog;
  readonly limited: MiddlewareHandler;
}): Hono {
  return new Hono()
    .post("/runs", deps.limited, async (c) => {
      const body = RunCreate.parse(await c.req.json());
      if (body.agent !== "triage")
        throw new WorkerError("unsupported", "run.agent", `The ${body.agent} agent is not available yet`);
      const [owner = "", name = ""] = body.repoId.split("/");
      const repo = repoParams(owner, name);
      if (deps.jobs.ingesting(`${repo.owner}/${repo.name}`))
        throw new WorkerError("busy", "run.ingesting", "The repository is still being ingested");
      if ((await deps.catalog.summary(repo, c.req.raw.signal)) === null)
        throw new WorkerError("missing", "repo.missing", "No such repository; ingest it first");
      const { runId } = await deps.runs.start(repo);
      return c.json(RunAccepted.parse({ runId }), 202);
    })
    .get("/runs/:id", async (c) => {
      const runId = RunId.parse(c.req.param("id"));
      const events = await deps.archive.find(runId, c.req.raw.signal);
      if (events === null) throw new WorkerError("missing", "run.missing", "No finished run with this id");
      return c.json(view(runId, events));
    })
    .get("/runs/:id/events", async (c) => {
      const runId = RunId.parse(c.req.param("id"));
      const from = lastEventId(c.req.header("Last-Event-ID"));
      const wantsReplay = c.req.query("replay") === "1";
      if (!wantsReplay && deps.runs.has(runId)) {
        return pump(
          c,
          (send) => deps.runs.subscribe(runId, from, send) ?? { stop: () => {}, done: true },
          finished,
        );
      }
      const events = await deps.archive.find(runId, c.req.raw.signal);
      if (events === null) throw new WorkerError("missing", "run.missing", "No such run");
      return replay(c, events, wantsReplay ? REPLAY_MS : 0, from);
    });
}
