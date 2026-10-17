import { randomBytes } from "node:crypto";
import { type Db, graphName } from "@noderunner/core";
import { connect } from "@noderunner/graph";
import { query, write } from "@noderunner/graph/cypher";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { GraphPlans } from "./plans.ts";

// Integration: a real FalkorDB from `docker compose up falkordb`.
const url = process.env.FALKORDB_URL ?? "redis://localhost:6379";
const never = new AbortController().signal;
const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const token = (n: number) => [...randomBytes(n)].map((b) => alphabet[b % 32]).join("");
let db: Db;
const made: string[] = [];

const seed = write(
  "test.planSeed",
  `CREATE (run:Run {id: $runId, agent: "triage", status: "done"})
CREATE (run)-[:PROPOSED]->(p:Plan {id: $planId, created_at: 1, total_cost: 1, uncovered: [], approved: false})
CREATE (p)-[:INCLUDES]->(u:Upgrade {id: "u1", kind: "refresh", package: "qs", from: "6.7.0", to: "6.7.3",
                                    semver_jump: "patch", cost: 1})
CREATE (f:File {path: "src/server.ts", kind: "prod"})
CREATE (e:Install {lock_path: "node_modules/express", name: "express", version: "4.17.1"})
CREATE (q:Install {lock_path: "node_modules/qs", name: "qs", version: "6.7.0"})
CREATE (f)-[:LOADS]->(e)-[:DEPENDS_ON]->(q)
CREATE (x:Finding {key: "GHSA-1|qs", severity: "high", tier: "import-reachable", status: "planned"})-[:AT]->(q)
CREATE (y:Finding {key: "GHSA-2|left-pad", severity: "bogus", status: "planned"})
CREATE (u)-[:CLOSES]->(y)
CREATE (u)-[:CLOSES]->(x)
CREATE (u)-[:REVIEW_BY {why: "owns src/server.ts"}]->(:Person {handle: "@alice"})`,
);

const approver = query(
  "test.approver",
  "MATCH (p:Plan {id: $planId}) RETURN p.approved_by AS by, p.approved_at AS at",
  z.object({ by: z.string(), at: z.number() }),
);

const seedEmpty = write(
  "test.planEmpty",
  `CREATE (r:Run {id: $runId})-[:PROPOSED]->(:Plan {id: $old, created_at: 1, total_cost: 1, uncovered: [], approved: false})
CREATE (r)-[:PROPOSED]->(:Plan {id: $planId, created_at: 2, total_cost: 0, uncovered: ["GHSA-9|x"], approved: false})`,
);

beforeAll(async () => {
  db = await connect({ url, signal: never, onError: () => {} });
});
afterEach(async () => {
  const { FalkorDB } = await import("falkordb");
  const raw = await FalkorDB.connect({ url });
  for (const name of made.splice(0))
    await raw
      .selectGraph(name)
      .delete()
      .catch(() => undefined);
  await raw.close();
});
afterAll(async () => {
  await db.close();
});

describe("GraphPlans", () => {
  it("drafts a run's plan with each finding's production path and reviewers, then approves it", async () => {
    const name = `api-${token(8).toLowerCase()}`;
    const graph = graphName({ owner: "acme", name });
    made.push(graph);
    const runId = `01JQZ8${token(20)}`;
    const planId = `01JQZ8${token(20)}`;
    await db.graph(graph).query(seed, { runId, planId }, never);
    const plans = new GraphPlans(db, { now: () => 7 });

    const draft = await plans.forRun(runId, never);
    expect(draft).toMatchObject({ planId, runId, repoId: `acme/${name}`, approved: false });
    expect(draft?.upgrades[0]?.closes).toEqual([
      {
        key: "GHSA-1|qs",
        severity: "high",
        tier: "import-reachable",
        file: "src/server.ts",
        chain: ["express@4.17.1", "qs@6.7.0"],
      },
      { key: "GHSA-2|left-pad", severity: "unknown", tier: null, file: null, chain: [] },
    ]);
    expect(draft?.upgrades[0]?.reviewers).toEqual([{ handle: "@alice", why: "owns src/server.ts" }]);
    expect(draft?.body).toContain("`src/server.ts` → `express@4.17.1` → `qs@6.7.0`");

    expect(await plans.approve(planId, "sakibalig", never)).toBe(true);
    expect(await plans.approve(planId, "someone-else", never)).toBe(true);
    expect((await plans.forRun(runId, never))?.approved).toBe(true);
    const [kept] = await db.graph(graph).query(approver, { planId }, never);
    expect(kept).toEqual({ by: "sakibalig", at: 7 });
    expect(await plans.approve(`01JQZ8${token(20)}`, "x", never)).toBe(false);
    expect(await plans.forRun(`01JQZ8${token(20)}`, never)).toBeNull();
  });

  it("drafts the run's newest plan, including one with no upgrade", async () => {
    const graph = graphName({ owner: "acme", name: `api-${token(8).toLowerCase()}` });
    made.push(graph);
    const runId = `01JQZ8${token(20)}`;
    const planId = `01JQZ8${token(20)}`;
    await db.graph(graph).query(seedEmpty, { runId, planId, old: `01JQZ8${token(20)}` }, never);
    const draft = await new GraphPlans(db, { now: () => 0 }).forRun(runId, never);
    expect(draft).toMatchObject({ planId, upgrades: [], uncovered: ["GHSA-9|x"] });
    expect(draft?.title).toContain("no upgrade found");
  });
});
