import { type Db, Fault, type G, type Shipment } from "@noderunner/core";
import { connect } from "@noderunner/graph";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createToolbox } from "../call.ts";
import { ids, manual, packuments, seeded, silent, ulid } from "../fixture.ts";
import { createTools } from "../registry.ts";
import type { Ship } from "./ship.ts";

const url = process.env.FALKORDB_URL ?? "redis://localhost:6379";
const never = new AbortController().signal;
let db: Db;
const made: G[] = [];

class Unapproved extends Fault {
  readonly code = "executor.unapproved";
  readonly surface = "unapproved";
}

const verification = { targeted: 2, closed: 2, stillOpen: [], newFindings: [] };

function box(ship?: Ship) {
  const clock = manual();
  const tools = createTools({ db, clock, ids, registry: packuments(), ...(ship ? { ship } : {}) });
  return createToolbox({ db, clock, ids, tools }, { access: ["read", "derive", "act"] });
}

beforeAll(async () => {
  db = await connect({ url, signal: never, onError: () => {} });
});
afterEach(async () => {
  for (const g of made.splice(0)) await g.drop().catch(() => undefined);
});
afterAll(async () => {
  await db.close();
});

describe("open_pull_request", () => {
  it("hands the run's graph and the plan to the executor and returns its shipment", async () => {
    const { ctx } = await seeded(db, made);
    const planId = ulid();
    const seen: unknown[] = [];
    const shipment: Shipment = {
      outcome: "opened",
      url: "https://github.com/sakibalig/mini/pull/7",
      branch: "noderunner/plan-x",
      verification,
    };
    const result = await box(async (req) => {
      seen.push(req);
      return shipment;
    }).callTool("open_pull_request", { planId }, { ...ctx, actor: "ui" }, silent);
    expect(seen).toEqual([{ graph: ctx.graph, runId: ctx.runId, planId }]);
    expect(result).toMatchObject({ ok: true, data: shipment, summary: expect.stringContaining("2 of 2") });
  });

  it("returns a refusal as a successful call so the verification reaches the caller", async () => {
    const { ctx } = await seeded(db, made);
    const refused: Shipment = {
      outcome: "refused",
      reason: "new reachable finding",
      verification: { ...verification, newFindings: ["GHSA-x|left-pad" as never] },
    };
    const result = await box(async () => refused).callTool(
      "open_pull_request",
      { planId: ulid() },
      { ...ctx, actor: "ui" },
      silent,
    );
    expect(result).toMatchObject({ ok: true, data: refused });
  });

  it("surfaces the executor's refusal code", async () => {
    const { ctx } = await seeded(db, made);
    let code: string | undefined;
    const result = await box(async () => {
      throw new Unapproved("The plan has not been approved");
    }).callTool(
      "open_pull_request",
      { planId: ulid() },
      { ...ctx, actor: "ui" },
      { onStart: () => {}, onFinish: (step) => (code = step.code) },
    );
    expect(result).toMatchObject({ ok: false, error: "The plan has not been approved" });
    expect(code).toBe("unapproved");
  });

  it("is absent when nothing can ship", async () => {
    const { ctx } = await seeded(db, made);
    const result = await box().callTool(
      "open_pull_request",
      { planId: ulid() },
      { ...ctx, actor: "ui" },
      silent,
    );
    expect(result.ok).toBe(false);
  });
});
