import type { Db, G } from "@noderunner/core";
import { connect } from "@noderunner/graph";
import { query, write } from "@noderunner/graph/cypher";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { manual, seeded, silent, toolbox } from "../fixture.ts";

const url = process.env.FALKORDB_URL ?? "redis://localhost:6379";
const never = new AbortController().signal;
const START = Date.parse("2030-01-01T00:00:00Z");
const QS = "GHSA-hrpp-h998-j3pp|qs";
const EXPRESS = "GHSA-rv95-896h-c2vc|express";
let db: Db;
const made: G[] = [];

const stored = query(
  "test.plan",
  `MATCH (:Run {id: $runId})-[:PROPOSED]->(p:Plan)-[:INCLUDES]->(u:Upgrade)-[:CLOSES]->(f:Finding)
RETURN p.approved AS approved, p.total_cost AS cost, u.kind AS kind, u.package AS package, u.to AS to,
       f.key AS key, f.status AS status ORDER BY key LIMIT 20`,
  z.object({
    approved: z.boolean(),
    cost: z.number(),
    kind: z.string(),
    package: z.string(),
    to: z.string(),
    key: z.string(),
    status: z.string(),
  }),
);
const statuses = query(
  "test.statuses",
  "MATCH (x:Finding) RETURN x.key AS key, x.status AS status ORDER BY key LIMIT 20",
  z.object({ key: z.string(), status: z.string() }),
);
const people = write(
  "test.people",
  `MATCH (f:File {path: "src/server.ts"})
CREATE (:Person {handle: "@owner", kind: "user"})-[:OWNS {source: "codeowners"}]->(f)
CREATE (:Person {handle: "@busy", kind: "user"})-[:CHANGED {commits: 2, last_at: $recent}]->(f)
CREATE (:Person {handle: "@old", kind: "user"})-[:CHANGED {commits: 9, last_at: $old}]->(f)`,
);

beforeAll(async () => {
  db = await connect({ url, signal: never, onError: () => {} });
});
afterEach(async () => {
  for (const g of made.splice(0)) await g.drop();
});
afterAll(async () => {
  await db.close();
});

async function tiered() {
  const { g, ctx } = await seeded(db, made);
  const box = toolbox(db, manual(START));
  await box.callTool("reachability", {}, ctx, silent);
  return { g, ctx, box };
}

describe("plan_upgrades", () => {
  it("plans one refresh of express that closes both reachable findings, and saves it unapproved", async () => {
    const { g, ctx, box } = await tiered();
    const result = await box.callTool("plan_upgrades", { tiers: ["import-reachable"] }, ctx, silent);
    if (!result.ok) throw new Error(result.error);
    const data = result.data as {
      upgrades: { kind: string; package: string; from: string; to: string; cost: number; closes: string[] }[];
      uncovered: string[];
      totalCost: number;
    };
    expect(
      data.upgrades.map(({ kind, package: p, from, to, cost, closes }) => ({
        kind,
        p,
        from,
        to,
        cost,
        closes,
      })),
    ).toEqual([
      { kind: "refresh", p: "express", from: "4.17.1", to: "4.22.3", cost: 1, closes: [QS, EXPRESS] },
    ]);
    expect(data.uncovered).toEqual([]);
    expect(result.summary).toBe("1 upgrade closes 2 findings at cost 1");
    expect(await g.query(stored, { runId: ctx.runId }, never)).toEqual([
      {
        approved: false,
        cost: 1,
        kind: "refresh",
        package: "express",
        to: "4.22.3",
        key: QS,
        status: "planned",
      },
      {
        approved: false,
        cost: 1,
        kind: "refresh",
        package: "express",
        to: "4.22.3",
        key: EXPRESS,
        status: "planned",
      },
    ]);
    expect(result.evidence.edges.map((e) => e.type).sort()).toEqual(["CLOSES", "CLOSES", "INCLUDES"]);
  });

  it("refreshes mkdirp for the installed tier", async () => {
    const { ctx, box } = await tiered();
    const result = await box.callTool("plan_upgrades", { tiers: ["installed"] }, ctx, silent);
    const data = result.ok
      ? (result.data as { upgrades: { kind: string; package: string; to: string }[] })
      : null;
    expect(data?.upgrades.map((u) => [u.kind, u.package, u.to])).toEqual([["refresh", "mkdirp", "0.5.6"]]);
  });

  it("leaves a waived finding out of the plan entirely", async () => {
    const { g, ctx, box } = await tiered();
    await box.callTool(
      "record_decision",
      { key: QS, kind: "waive", reason: "accepted risk", by: "@a" },
      ctx,
      silent,
    );
    const result = await box.callTool("plan_upgrades", { tiers: ["import-reachable"] }, ctx, silent);
    const data = result.ok
      ? (result.data as { upgrades: { closes: string[] }[]; uncovered: string[] })
      : null;
    expect(data?.upgrades.flatMap((u) => u.closes)).toEqual([EXPRESS]);
    expect(data?.uncovered).toEqual([]);
    expect((await g.query(statuses, {}, never)).find((s) => s.key === QS)?.status).toBe("waived");
  });

  it("refuses to plan before reachability and writes nothing", async () => {
    const { g, ctx } = await seeded(db, made);
    const result = await toolbox(db, manual(START)).callTool(
      "plan_upgrades",
      { tiers: ["import-reachable"] },
      ctx,
      silent,
    );
    expect(result).toMatchObject({ ok: false, error: "Call reachability before plan_upgrades" });
    expect((await g.query(statuses, {}, never)).every((s) => s.status === "open")).toBe(true);
  });
});

describe("owners_for", () => {
  it("ranks a CODEOWNER above a recent author and ignores old commits", async () => {
    const { g, ctx, box } = await tiered();
    await g.query(people, { recent: START - 86_400_000, old: START - 200 * 86_400_000 }, never);
    const planned = await box.callTool("plan_upgrades", { tiers: ["import-reachable"] }, ctx, silent);
    const planId = planned.ok ? (planned.data as { planId: string }).planId : "";
    const result = await box.callTool("owners_for", { planId }, ctx, silent);
    if (!result.ok) throw new Error(result.error);
    const data = result.data as { perUpgrade: { reviewers: { handle: string; why: string }[] }[] };
    expect(data.perUpgrade[0]?.reviewers).toEqual([
      { handle: "@owner", why: "owns src/server.ts" },
      { handle: "@busy", why: "2 recent commits" },
    ]);
    expect(result.evidence.edges.map((e) => e.type)).toEqual(["REVIEW_BY", "REVIEW_BY"]);
  });

  it("answers missing for an unknown plan", async () => {
    const { ctx, box } = await tiered();
    const result = await box.callTool("owners_for", { planId: "01JQZ8ABCDEFGHJKMNPQRSTVWX" }, ctx, silent);
    expect(result).toMatchObject({ ok: false, error: "No plan has the id 01JQZ8ABCDEFGHJKMNPQRSTVWX" });
  });
});
