import "server-only";
import { parseEnv } from "@noderunner/core";
import type { Upstream } from "./proxy.ts";

let cached: Upstream | undefined;

/** The worker's URL and token, parsed once; only server code imports this module. */
export function upstream(): Upstream {
  if (cached === undefined) {
    const env = parseEnv("web", process.env);
    cached = { url: env.WORKER_URL.replace(/\/$/, ""), token: env.WORKER_TOKEN };
  }
  return cached;
}
