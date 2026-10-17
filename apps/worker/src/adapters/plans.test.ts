import { randomBytes } from "node:crypto";
import { type Db, graphName } from "@noderunner/core";
import { connect } from "@noderunner/graph";
import { write } from "@noderunner/graph/cypher";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
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
CREATE (x:Finding {key: "GHSA-1|qs", severity: "high", status: "planned"})-[:AT]->(q)
CREATE (u)-[:CLOSES]->(x)
CREATE (u)-[:REVIEW_BY {why: "owns src/server.ts"}]->(:Person {handle: "@alice"})`,
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
      { key: "GHSA-1|qs", severity: "high", file: "src/server.ts", chain: ["express@4.17.1", "qs@6.7.0"] },
    ]);
    expect(draft?.upgrades[0]?.reviewers).toEqual([{ handle: "@alice", why: "owns src/server.ts" }]);
    expect(draft?.body).toContain("`src/server.ts` → express@4.17.1 → qs@6.7.0");

    expect(await plans.approve(planId, "sakibalig", never)).toBe(true);
    expect((await plans.forRun(runId, never))?.approved).toBe(true);
    expect(await plans.approve(`01JQZ8${token(20)}`, "x", never)).toBe(false);
    expect(await plans.forRun(`01JQZ8${token(20)}`, never)).toBeNull();
  });
});
