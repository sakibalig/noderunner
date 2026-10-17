import { limits, type RunEvent } from "@noderunner/core";
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { WorkerError } from "../errors.ts";
import type { Framed } from "../jobs/ring.ts";

export const STREAM_MS = 900_000;

const LastEventId = z.coerce.number().int().nonnegative().default(0);

/** Parses Last-Event-ID. @throws WorkerError `invalid` when it is not a whole number. */
export function lastEventId(header: string | undefined): number {
  const parsed = LastEventId.safeParse(header);
  if (!parsed.success) throw new WorkerError("invalid", "api.event", "Last-Event-ID must be a whole number");
  return parsed.data;
}

type Subscribe = (send: (framed: Framed) => void) => { readonly stop: () => void; readonly done: boolean };

/**
 * Streams framed events until one `ends` the stream, the client leaves, the subscriber falls more than
 * `limits.ringEvents` behind, or `STREAM_MS` passes; the client then reconnects with Last-Event-ID.
 */
export function pump(c: Context, subscribe: Subscribe, ends: (event: RunEvent) => boolean): Response {
  const frames: Framed[] = [];
  let wake = () => {};
  let overflow = false;
  const { stop, done } = subscribe((framed) => {
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
}

/** Writes stored events, spacing step results by their original duration scaled to fit `totalMs`. */
export function replay(c: Context, events: readonly RunEvent[], totalMs: number, from: number): Response {
  const steps = events.reduce((sum, event) => sum + (event.type === "step.finished" ? event.ms : 0), 0);
  const scale = steps === 0 ? 0 : Math.min(1, totalMs / steps);
  return streamSSE(c, async (stream) => {
    let open = true;
    stream.onAbort(() => {
      open = false;
    });
    for (const [index, event] of events.entries()) {
      const id = index + 1;
      if (!open) break;
      if (id <= from) continue;
      if (scale > 0 && event.type === "step.finished") await stream.sleep(Math.round(event.ms * scale));
      await stream.writeSSE({ id: String(id), event: event.type, data: JSON.stringify(event) });
    }
  });
}
