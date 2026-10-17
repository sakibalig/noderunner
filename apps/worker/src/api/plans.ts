import { PlanApprove, PlanId, RunId } from "@noderunner/core";
import { Hono } from "hono";
import { WorkerError } from "../errors.ts";
import type { Plans } from "../jobs/plans.ts";

/** GET /runs/:id/plan (the run's plan as a pull request draft) and POST /plans/:id/approve. */
export function plans(deps: { readonly plans: Plans }): Hono {
  return new Hono()
    .get("/runs/:id/plan", async (c) => {
      const runId = RunId.parse(c.req.param("id"));
      const draft = await deps.plans.forRun(runId, c.req.raw.signal);
      if (draft === null) throw new WorkerError("missing", "plan.missing", "This run proposed no plan");
      return c.json(draft);
    })
    .post("/plans/:id/approve", async (c) => {
      const planId = PlanId.parse(c.req.param("id"));
      const { by } = PlanApprove.parse(await c.req.json());
      if (!(await deps.plans.approve(planId, by, c.req.raw.signal)))
        throw new WorkerError("missing", "plan.missing", "No such plan");
      return c.json({ approved: true });
    });
}
