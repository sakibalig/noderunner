import { DecisionCreate, RepoId } from "@noderunner/core";
import { Hono } from "hono";
import { WorkerError } from "../errors.ts";
import type { Findings } from "../jobs/findings.ts";
import { repoParams } from "./repo.ts";

/** GET /repos/:owner/:name/findings/:key (the finding drawer) and POST /decisions. */
export function findings(deps: { readonly findings: Findings }): Hono {
  return new Hono()
    .get("/repos/:owner/:name/findings/:key", async (c) => {
      const repo = repoParams(c.req.param("owner"), c.req.param("name"));
      const detail = await deps.findings.detail(repo, c.req.param("key"), c.req.raw.signal);
      if (detail === null) throw new WorkerError("missing", "finding.missing", "No such finding");
      return c.json(detail);
    })
    .post("/decisions", async (c) => {
      const body = DecisionCreate.parse(await c.req.json());
      const [owner = "", name = ""] = RepoId.parse(body.repoId).split("/");
      const made = await deps.findings.decide(repoParams(owner, name), body, c.req.raw.signal);
      if (made === null) throw new WorkerError("missing", "finding.missing", "No such finding");
      return c.json(made, 201);
    });
}
