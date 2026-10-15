import { FindingQuery, RepoAccepted } from "@noderunner/core";
import { Hono, type MiddlewareHandler } from "hono";
import { WorkerError } from "../errors.ts";
import type { Catalog } from "../jobs/catalog.ts";
import type { Jobs } from "../jobs/queue.ts";
import { repoFrom, repoParams } from "./repo.ts";

/** POST /repos, GET /repos, and a repository's summary and findings. */
export function repos(deps: {
  readonly jobs: Jobs;
  readonly catalog: Catalog;
  readonly limited: MiddlewareHandler;
}) {
  return new Hono()
    .post("/repos", deps.limited, async (c) => {
      const repo = repoFrom(await c.req.json());
      const { jobId } = deps.jobs.ingest(repo);
      return c.json(RepoAccepted.parse({ repoId: `${repo.owner}/${repo.name}`, jobId }), 202);
    })
    .get("/repos", async (c) => c.json({ repos: await deps.catalog.list(c.req.raw.signal) }))
    .get("/repos/:owner/:name/summary", async (c) => {
      const repo = repoParams(c.req.param("owner"), c.req.param("name"));
      const summary = await deps.catalog.summary(repo, c.req.raw.signal);
      if (summary === null) throw new WorkerError("missing", "repo.missing", "No such repository");
      return c.json(summary);
    })
    .get("/repos/:owner/:name/findings", async (c) => {
      const repo = repoParams(c.req.param("owner"), c.req.param("name"));
      const filter = FindingQuery.parse(c.req.query());
      const findings = await deps.catalog.findings(repo, filter, c.req.raw.signal);
      if (findings === null) throw new WorkerError("missing", "repo.missing", "No such repository");
      return c.json({ findings });
    });
}
