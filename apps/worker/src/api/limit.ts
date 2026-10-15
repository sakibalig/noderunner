import type { MiddlewareHandler } from "hono";
import { WorkerError } from "../errors.ts";
import type { Limiter } from "../jobs/limit.ts";
import type { Log } from "../log.ts";

/**
 * Rate-limits one route per client. Mounted only behind `auth`, so `X-Forwarded-For` comes from the web proxy,
 * which alone holds the token; without the header the client is the proxy itself.
 */
export function limit(limiter: Limiter, log: Log): MiddlewareHandler {
  return async (c, next) => {
    const client = c.req.header("X-Forwarded-For")?.split(",")[0]?.trim() || "proxy";
    if (!limiter.take(client)) {
      log.warn({ path: c.req.path }, "api.request.limited");
      throw new WorkerError("limited", "api.limited", "Too many requests; try again later");
    }
    await next();
  };
}
