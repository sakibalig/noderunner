import { JobId } from "@noderunner/core";
import { Hono } from "hono";
import { ends, type Jobs } from "../jobs/queue.ts";
import { lastEventId, pump } from "./stream.ts";

/** GET /jobs/:id/events: events after Last-Event-ID, then live ones, until the job's last event. */
export function progress(jobs: Jobs): Hono {
  return new Hono().get("/jobs/:id/events", (c) => {
    const jobId = JobId.parse(c.req.param("id"));
    const from = lastEventId(c.req.header("Last-Event-ID"));
    return pump(c, (send) => jobs.subscribe(jobId, from, send), ends);
  });
}
