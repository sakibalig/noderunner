import type { Db, G } from "@noderunner/core";
import { connect } from "@noderunner/graph";
import { query, write } from "@noderunner/graph/cypher";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { seeded, silent, toolbox } from "../fixture.ts";

const url = process.env.FALKORDB_URL ?? "redis://localhost:6379";
const never = new AbortController().signal;
let db: Db;
const made: G[] = [];

const found = query(
  "test.found",
  "MATCH (:Run {id: $runId})-[:FOUND]->(x:Finding) RETURN x.key AS key ORDER BY key LIMIT 100",
  z.object({ key: z.string() }),
);
const lowFindings = write(
  "test.lowFindings",
  `UNWIND $rows AS r
CREATE (:Finding {key: r.key, vuln_id: r.id, package: r.pkg, severity: "low", status: "open"})
       -[:ABOUT]->(:Vuln {id: r.id, severity: "low", severity_rank: 1})`,
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

describe("list_alerts", () => {
  it("lists open findings most severe first, with installs, and records FOUND", async () => {
    const { g, ctx } = await seeded(db, made);
    const result = await toolbox(db).callTool("list_alerts", {}, ctx, silent);
    if (!result.ok) throw new Error(result.error);
    expect(result.data).toMatchObject({
      total: 4,
      bySeverity: { critical: 0, high: 2, moderate: 2, low: 0, unknown: 0 },
    });
    const data = result.data as {
      findings: { key: string; installs: string[]; status: string; tier: null }[];
    };
    expect(data.findings.map((f) => f.key)).toEqual([
      "GHSA-35jh-r3h4-6jhm|lodash",
      "GHSA-hrpp-h998-j3pp|qs",
      "GHSA-rv95-896h-c2vc|express",
      "GHSA-vh95-rmgr-6w4m|minimist",
    ]);
    expect(data.findings[1]).toMatchObject({ installs: ["node_modules/qs"], status: "open", tier: null });
    expect(result.summary).toBe("4 open findings: 0 critical, 2 high, 2 moderate, 0 low, 0 unknown");
    expect((await g.query(found, { runId: ctx.runId }, never)).length).toBe(4);
    expect(result.evidence.edges.map((e) => e.type).sort()).toContain("AT");
  });

  it("filters by minimum severity", async () => {
    const { ctx } = await seeded(db, made);
    const result = await toolbox(db).callTool("list_alerts", { minSeverity: "high" }, ctx, silent);
    expect(result.ok && result.data).toMatchObject({ total: 2 });
  });

  it("lists the 40 most severe of 45 findings and counts them all", async () => {
    const { g, ctx } = await seeded(db, made);
    const rows = Array.from({ length: 41 }, (_, i) => ({
      key: `LOW-${String(i).padStart(2, "0")}|p${i}`,
      id: `LOW-${String(i).padStart(2, "0")}`,
      pkg: `p${i}`,
    }));
    await g.batch(lowFindings, rows, {}, never);
    const result = await toolbox(db).callTool("list_alerts", {}, ctx, silent);
    if (!result.ok) throw new Error(result.error);
    const data = result.data as { total: number; findings: { key: string }[] };
    expect(data.total).toBe(45);
    expect(data.findings).toHaveLength(40);
    expect(data.findings.slice(0, 4).map((f) => f.key)).toEqual([
      "GHSA-35jh-r3h4-6jhm|lodash",
      "GHSA-hrpp-h998-j3pp|qs",
      "GHSA-rv95-896h-c2vc|express",
      "GHSA-vh95-rmgr-6w4m|minimist",
    ]);
    expect(result.summary).toContain("the 40 most severe listed");
    expect((await g.query(found, { runId: ctx.runId }, never)).length).toBe(40);
  });
});
