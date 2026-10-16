import { serve } from "@hono/node-server";
import { EnvError, llmConfig, llmKey, parseEnv } from "@noderunner/core";
import { connect } from "@noderunner/graph";
import { GitHistory, GitHub, ingest, OSV } from "@noderunner/ingest";
import { pino } from "pino";
import { GraphCatalog } from "./adapters/catalog.ts";
import { systemClock, ulidIds } from "./adapters/clock.ts";
import { reachable } from "./adapters/probe.ts";
import { createApp } from "./api/app.ts";
import type { Ingester } from "./jobs/catalog.ts";
import { Limiter } from "./jobs/limit.ts";
import { Jobs } from "./jobs/queue.ts";

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
const app = createApp({
  jobs,
  catalog: new GraphCatalog(db),
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
  await Promise.race([jobs.stop(), new Promise((resolve) => setTimeout(resolve, SHUTDOWN_MS))]);
  await db.close();
  log.info({}, "worker.stopped");
  process.exit(0);
}
process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());
