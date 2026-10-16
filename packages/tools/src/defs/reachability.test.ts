import type { Db, G } from "@noderunner/core";
import { connect } from "@noderunner/graph";
import { golden, query } from "@noderunner/graph/cypher";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { seeded as mini, silent, toolbox } from "../fixture.ts";

const url = process.env.FALKORDB_URL ?? "redis://localhost:6379";
const never = new AbortController().signal;
let db: Db;
const made: G[] = [];
const hooks = silent;
const seeded = () => mini(db, made);
const tiers = query(
  "test.tiers",
  "MATCH (x:Finding) RETURN x.key AS key, x.tier AS tier ORDER BY key LIMIT 20",
  z.object({ key: z.string(), tier: z.string().nullable() }),
);
const stepRecord = query(
  "test.stepRecord",
  "MATCH (s:Step {id: $id}) OPTIONAL MATCH (s)-[t:TOUCHED]->() RETURN s.ok AS ok, s.edges AS edges, s.cypher AS cypher, count(t) AS touched",
  z.object({ ok: z.boolean(), edges: z.string(), cypher: z.array(z.string()), touched: z.number() }),
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

describe("reachability on the mini-repo", () => {
  it("puts each finding in its tier, with the shortest chain for the reachable ones", async () => {
    const { g, ctx } = await seeded();
    const result = await toolbox(db).callTool("reachability", {}, ctx, hooks);
    if (!result.ok) throw new Error(result.error);
    expect(result.data).toEqual({
      counts: { "import-reachable": 2, installed: 1, "dev-only": 1 },
      reachable: [
        {
          key: "GHSA-hrpp-h998-j3pp|qs",
          files: ["src/server.ts"],
          via: "express",
          chain: ["node_modules/express", "node_modules/body-parser", "node_modules/qs"],
          hops: 2,
        },
        {
          key: "GHSA-rv95-896h-c2vc|express",
          files: ["src/server.ts"],
          via: "express",
          chain: ["node_modules/express"],
          hops: 0,
        },
      ],
    });
    expect(result.summary).toBe("4 findings tiered: 2 import-reachable, 1 installed, 1 dev-only");
    expect(await g.query(tiers, {}, never)).toEqual([
      { key: "GHSA-35jh-r3h4-6jhm|lodash", tier: "dev-only" },
      { key: "GHSA-hrpp-h998-j3pp|qs", tier: "import-reachable" },
      { key: "GHSA-rv95-896h-c2vc|express", tier: "import-reachable" },
      { key: "GHSA-vh95-rmgr-6w4m|minimist", tier: "installed" },
    ]);
  });

  it("returns the path as evidence with stable keys, and records it on the Step", async () => {
    const { g, ctx } = await seeded();
    const result = await toolbox(db).callTool("reachability", {}, ctx, hooks);
    if (!result.ok) throw new Error(result.error);
    const keys = result.evidence.edges.map((edge) => edge.key);
    expect(keys).toEqual([
      "src/server.ts|LOADS|node_modules/express",
      "node_modules/express|DEPENDS_ON|node_modules/body-parser",
      "node_modules/body-parser|DEPENDS_ON|node_modules/qs",
    ]);
    for (const edge of result.evidence.edges)
      expect(edge.key).toBe(`${edge.fromKey}|${edge.type}|${edge.toKey}`);
    const [step] = await g.query(stepRecord, { id: result.stepId }, never);
    expect(step?.ok).toBe(true);
    expect(JSON.parse(step?.edges ?? "[]")).toEqual(keys);
    expect(step?.touched).toBe(result.evidence.nodes.length);
    expect(step?.cypher.some((text) => text.includes("shortestPath"))).toBe(true);
  });

  it("tiers only the findings asked for", async () => {
    const { g, ctx } = await seeded();
    const result = await toolbox(db).callTool(
      "reachability",
      { keys: ["GHSA-vh95-rmgr-6w4m|minimist"] },
      ctx,
      hooks,
    );
    expect(result.ok && result.data).toEqual({
      counts: { "import-reachable": 0, installed: 1, "dev-only": 0 },
      reachable: [],
    });
    const written = (await g.query(tiers, {}, never)).filter((row) => row.tier !== null);
    expect(written).toEqual([{ key: "GHSA-vh95-rmgr-6w4m|minimist", tier: "installed" }]);
  });

  it("answers missing for a key no finding has", async () => {
    const { ctx } = await seeded();
    const result = await toolbox(db).callTool("reachability", { keys: ["GHSA-nope|nothing"] }, ctx, hooks);
    expect(result).toMatchObject({ ok: false, error: "No finding has the key GHSA-nope|nothing" });
  });

  it("gives the same answer every time, and G3 agrees on the chain", async () => {
    const { g, ctx } = await seeded();
    const box = toolbox(db);
    const first = await box.callTool("reachability", {}, ctx, hooks);
    const second = await box.callTool("reachability", {}, ctx, hooks);
    expect(first.ok && second.ok && first.data).toEqual(second.ok && second.data);
    expect(await g.query(golden.chain, { vulnId: "GHSA-hrpp-h998-j3pp" }, never)).toEqual([
      {
        file: "src/server.ts",
        chain: ["node_modules/express", "node_modules/body-parser", "node_modules/qs"],
        hops: 2,
      },
    ]);
  });
});
