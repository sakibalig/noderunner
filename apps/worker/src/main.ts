import { serve } from "@hono/node-server";
import { EnvError, llmConfig, llmKey, parseEnv } from "@noderunner/core";
import { connect } from "@noderunner/graph";
import { GitHistory, GitHub, ingest, OSV } from "@noderunner/ingest";
import { npm } from "@noderunner/planner";
import { createToolbox, createTools } from "@noderunner/tools";
import { pino } from "pino";
import { GraphArchive } from "./adapters/archive.ts";
import { GraphCatalog } from "./adapters/catalog.ts";
import { systemClock, ulidIds } from "./adapters/clock.ts";
import { GraphFindings } from "./adapters/findings.ts";
import { OpenAIModel } from "./adapters/model/openai.ts";
import { GraphPlans } from "./adapters/plans.ts";
import { reachable } from "./adapters/probe.ts";
import { runAgent } from "./agent/loop.ts";
import { createApp } from "./api/app.ts";
import type { Ingester } from "./jobs/catalog.ts";
import { Limiter } from "./jobs/limit.ts";
import { Jobs } from "./jobs/queue.ts";
import { type Runner, Runs } from "./jobs/runs.ts";

const SHUTDOWN_MS = 10_000;
const RATE = { limit: 10, windowMs: 3_600_000, clients: 10_000 };

let env: ReturnType<typeof parseEnv<"worker">>;
try {
  env = parseEnv("worker", process.env);
} catch (error) {
  if (!(error instanceof EnvError)) throw error;
  console.error(error.message);
  process.exit(1);
}

const log = pino({ level: env.LOG_LEVEL });
const llm = llmConfig(env);
const key = llmKey(env);
const db = await connect({
  url: env.FALKORDB_URL,
  signal: AbortSignal.timeout(10_000),
  onError: (error) => log.error({ code: error.code }, "graph.connection.failed"),
});
const github = new GitHub({ token: env.GITHUB_TOKEN });
const history = new GitHistory({ token: env.GITHUB_TOKEN });
const forge = {
  head: github.head.bind(github),
  tarball: github.tarball.bind(github),
  history: history.history.bind(history),
};
const osv = new OSV();
const ingester: Ingester = (repo, { onProgress, signal }) =>
  ingest(
    repo,
    { db, forge, advisories: osv, clock: systemClock },
    { target: { kind: "repo" }, onProgress, signal },
  );
const jobs = new Jobs({ ingest: ingester, clock: systemClock, ids: ulidIds, log });

const tools = createTools({
  db,
  clock: systemClock,
  ids: ulidIds,
  registry: npm({ dir: env.CACHE_DIR, clock: systemClock }),
});
const toolbox = createToolbox(
  { db, clock: systemClock, ids: ulidIds, tools },
  { access: ["read", "derive", "act"] },
);
// Only the OpenAI adapter is built (llm.md); another provider starts the worker without agent runs.
const model = llm.provider === "openai" ? new OpenAIModel(key, llm.model) : null;
const runner: Runner = async ({ repo, graph, runId, emit, signal }) => {
  if (model === null) throw new Error(`no adapter for ${llm.provider}`);
  await runAgent(
    { model, modelId: llm.id, toolbox, tools, db, clock: systemClock, log },
    {
      repo,
      graph,
      runId,
      agent: "triage",
      kickoff: {},
      hooks: {
        onStart: (step) => log.info({ runId, stepId: step.stepId, tool: step.tool }, "tool.call.started"),
        onFinish: (step) =>
          log.info(
            { runId, stepId: step.stepId, ok: step.ok, ms: step.ms },
            step.ok ? "tool.call.finished" : "tool.call.failed",
          ),
      },
      emit,
      signal,
    },
  );
};
const archive = new GraphArchive(db, systemClock);
const runs = new Runs({ run: runner, archive, model: llm.id, clock: systemClock, ids: ulidIds, log });
const app = createApp({
  jobs,
  runs,
  archive,
  plans: new GraphPlans(db, systemClock),
  catalog: new GraphCatalog(db),
  findings: new GraphFindings({ db, clock: systemClock, ids: ulidIds, toolbox }),
  limiter: new Limiter(RATE, systemClock),
  probe: { falkordb: reachable(env.FALKORDB_URL), model: key.length > 0 },
  log,
  config: { token: env.WORKER_TOKEN, origin: env.WEB_ORIGIN },
});

const server = serve({ fetch: app.fetch, port: env.PORT }, () => {
  log.info({ port: env.PORT, model: llm.id }, "worker.started");
});

async function shutdown(): Promise<void> {
  server.close();
  await Promise.race([
    Promise.all([jobs.stop(), runs.stop()]),
    new Promise((resolve) => setTimeout(resolve, SHUTDOWN_MS)),
  ]);
  await db.close();
  log.info({}, "worker.stopped");
  process.exit(0);
}
process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());
