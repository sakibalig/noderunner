import { PlanApprove, PlanId, RunId, ShipAccepted } from "@noderunner/core";
import { Hono, type MiddlewareHandler } from "hono";
import { WorkerError } from "../errors.ts";
import type { Plans } from "../jobs/plans.ts";
import type { Jobs } from "../jobs/queue.ts";
import type { Shipments } from "../jobs/shipments.ts";

/** GET /runs/:id/plan (the run's plan as a pull request draft), POST /plans/:id/approve, and POST /plans/:id/ship. */
export function plans(deps: {
  readonly plans: Plans;
  readonly shipments: Shipments;
  readonly jobs: Jobs;
  readonly limited: MiddlewareHandler;
}): Hono {
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
    })
    .post("/plans/:id/ship", deps.limited, async (c) => {
      const planId = PlanId.parse(c.req.param("id"));
      const found = await deps.shipments.locate(planId, c.req.raw.signal);
      if (found === null) throw new WorkerError("missing", "plan.missing", "No such plan");
      if (!found.approved)
        throw new WorkerError("unapproved", "plan.unapproved", "Approve the plan before shipping it");
      if (found.shipped !== null)
        throw new WorkerError("shipped", "plan.shipped", "The plan already has a pull request");
      const { jobId } = deps.jobs.ship(planId, (emit, signal) =>
        deps.shipments.ship(found.graph, planId, emit, signal),
      );
      return c.json(ShipAccepted.parse({ jobId }), 202);
    });
}
