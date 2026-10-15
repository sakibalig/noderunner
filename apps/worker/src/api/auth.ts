import { createHash, timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { WorkerError } from "../errors.ts";
import type { Log } from "../log.ts";

const digest = (value: string) => createHash("sha256").update(value).digest();

/** Requires `Authorization: Bearer <token>`, compared in constant time; anything else answers `unauthorized`. */
export function auth(token: string, log: Log): MiddlewareHandler {
  const expected = digest(token);
  return async (c, next) => {
    const presented = /^Bearer (\S+)$/.exec(c.req.header("Authorization") ?? "")?.[1];
    if (presented === undefined || !timingSafeEqual(digest(presented), expected)) {
      log.warn({ path: c.req.path }, "api.request.rejected");
      throw new WorkerError("unauthorized", "api.unauthorized", "Missing or wrong worker token");
    }
    await next();
  };
}
