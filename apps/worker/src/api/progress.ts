import { JobId, limits } from "@noderunner/core";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { WorkerError } from "../errors.ts";
import { ends, type Jobs } from "../jobs/queue.ts";
import type { Framed } from "../jobs/ring.ts";

export const STREAM_MS = 900_000;

const LastEventId = z.coerce.number().int().nonnegative().default(0);

/**
 * GET /jobs/:id/events: events after Last-Event-ID, then live ones, until the job's last event. A client that
 * falls more than `limits.ringEvents` behind, or a stream open longer than `STREAM_MS`, is closed so it reconnects.
 */
export function progress(jobs: Jobs): Hono {
  return new Hono().get("/jobs/:id/events", (c) => {
    const jobId = JobId.parse(c.req.param("id"));
    const parsed = LastEventId.safeParse(c.req.header("Last-Event-ID"));
    if (!parsed.success)
      throw new WorkerError("invalid", "api.event", "Last-Event-ID must be a whole number");
    const frames: Framed[] = [];
    let wake = () => {};
    let overflow = false;
    const { stop, done } = jobs.subscribe(jobId, parsed.data, (framed) => {
      if (frames.length >= limits.ringEvents) overflow = true;
      else frames.push(framed);
      wake();
    });
    return streamSSE(c, async (stream) => {
      let open = true;
      const close = () => {
        open = false;
        wake();
      };
      stream.onAbort(close);
      const deadline = setTimeout(close, STREAM_MS);
      try {
        while (open && !overflow) {
          const framed = frames.shift();
          if (framed === undefined) {
            if (done) break;
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
            continue;
          }
          await stream.writeSSE({
            id: String(framed.id),
            event: framed.event.type,
            data: JSON.stringify(framed.event),
          });
          if (ends(framed.event)) break;
        }
      } finally {
        clearTimeout(deadline);
        stop();
      }
    });
  });
}
