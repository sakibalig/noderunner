import { type ErrorBody, errorTable } from "@noderunner/core";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { requestId } from "hono/request-id";
import { ZodError } from "zod";
import { surfaceOf, WorkerError } from "../errors.ts";
import type { Catalog } from "../jobs/catalog.ts";
import type { Findings } from "../jobs/findings.ts";
import type { Limiter } from "../jobs/limit.ts";
import type { Plans } from "../jobs/plans.ts";
import type { Jobs } from "../jobs/queue.ts";
import type { Archive, Runs } from "../jobs/runs.ts";
import type { Log } from "../log.ts";
import { auth } from "./auth.ts";
import { findings } from "./findings.ts";
import { health } from "./health.ts";
import { limit } from "./limit.ts";
import { plans } from "./plans.ts";
import { progress } from "./progress.ts";
import { repos } from "./repos.ts";
import { runs } from "./runs.ts";

export const BODY_BYTES = 65_536;

export type AppDeps = {
  readonly jobs: Jobs;
  readonly runs: Runs;
  readonly archive: Archive;
  readonly plans: Plans;
  readonly catalog: Catalog;
  readonly findings: Findings;
  readonly limiter: Limiter;
  readonly probe: { readonly falkordb: () => Promise<boolean>; readonly model: boolean };
  readonly log: Log;
  readonly config: { readonly token: string; readonly origin: string };
};

/** The Run API. Order: request id and logging, CORS, health, bearer check, body limit, routes. */
export function createApp(deps: AppDeps): Hono {
  const { log } = deps;
  const app = new Hono();

  app.use(requestId());
  app.use(async (c, next) => {
    const started = performance.now();
    await next();
    const fields = {
      requestId: c.get("requestId"),
      method: c.req.method,
      path: c.req.routePath,
      status: c.res.status,
    };
    log.info({ ...fields, ms: Math.round(performance.now() - started) }, "api.request.finished");
  });
  app.use(cors({ origin: deps.config.origin }));
  app.route("/", health(deps.probe));
  app.use(auth(deps.config.token, log));
  app.use(
    bodyLimit({
      maxSize: BODY_BYTES,
      onError: () => {
        throw new WorkerError("invalid", "api.body", "Request body too large");
      },
    }),
  );
  const limited = limit(deps.limiter, log);
  app.route("/", repos({ jobs: deps.jobs, catalog: deps.catalog, limited }));
  app.route(
    "/",
    runs({ runs: deps.runs, archive: deps.archive, jobs: deps.jobs, catalog: deps.catalog, limited }),
  );
  app.route("/", plans({ plans: deps.plans }));
  app.route("/", findings({ findings: deps.findings }));
  app.route("/", progress(deps.jobs));

  app.notFound(() => {
    throw new WorkerError("missing", "api.route", "No such route");
  });
  app.onError((error, c) => {
    const failure = toFailure(error);
    if (failure.code === "internal") log.error({ path: c.req.path, err: error }, "api.request.failed");
    const body: ErrorBody = { error: failure };
    return c.json(body, errorTable[failure.code].status as 400);
  });
  return app;
}

function toFailure(error: Error): ErrorBody["error"] {
  if (error instanceof ZodError) return { code: "invalid", message: "The request failed validation" };
  if (error instanceof SyntaxError) return { code: "invalid", message: "The body is not valid JSON" };
  return surfaceOf(error, "Unexpected failure");
}
