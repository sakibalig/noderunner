import { serve } from "@hono/node-server";
import { EnvError, parseEnv } from "@noderunner/core";
import { pino } from "pino";
import { systemClock, ulidIds } from "./adapters/clock.ts";
import { reachable } from "./adapters/probe.ts";
import { Standin } from "./adapters/standin.ts";
import { createApp } from "./api/app.ts";
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
// Until packages/ingest and packages/graph land, ingestion and the catalog are the in-memory stand-in.
const standin = new Standin(systemClock);
const jobs = new Jobs({ ingest: standin.ingest, clock: systemClock, ids: ulidIds, log });
const app = createApp({
  jobs,
  catalog: standin,
  limiter: new Limiter(RATE, systemClock),
  probe: { falkordb: reachable(env.FALKORDB_URL), model: env.OPENAI_API_KEY.length > 0 },
  log,
  config: { token: env.WORKER_TOKEN, origin: env.WEB_ORIGIN },
});

const server = serve({ fetch: app.fetch, port: env.PORT }, () => {
  log.info({ port: env.PORT, model: env.MODEL }, "worker.started");
});

async function shutdown(): Promise<void> {
  server.close();
  await Promise.race([jobs.stop(), new Promise((resolve) => setTimeout(resolve, SHUTDOWN_MS))]);
  log.info({}, "worker.stopped");
  process.exit(0);
}
process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());
