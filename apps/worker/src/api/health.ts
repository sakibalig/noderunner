import type { Health } from "@noderunner/core";
import { Hono } from "hono";

/** GET /healthz: always 200 with booleans only, no token, per the contract. */
export function health(probe: { readonly falkordb: () => Promise<boolean>; readonly model: boolean }): Hono {
  return new Hono().get("/healthz", async (c) => {
    const falkordb = await probe.falkordb();
    const body: Health = { ok: falkordb && probe.model, falkordb, model: probe.model };
    return c.json(body);
  });
}
