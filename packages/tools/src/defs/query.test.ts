import type { Db, G } from "@noderunner/core";
import { connect } from "@noderunner/graph";
import { query } from "@noderunner/graph/cypher";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { seeded, silent, toolbox } from "../fixture.ts";
import { bounded, guard } from "./query.ts";

const url = process.env.FALKORDB_URL ?? "redis://localhost:6379";
const never = new AbortController().signal;
let db: Db;
const made: G[] = [];

const installs = query(
  "test.installs",
  "MATCH (i:Install) RETURN count(i) AS n",
  z.object({ n: z.number() }),
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

describe("guard and bounded", () => {
  it.each([
    ["CREATE (:X)", "write clauses"],
    ["MATCH (n) DETACH DELETE n", "write clauses"],
    ["MATCH (n) SET n.x = 1", "write clauses"],
    ["CALL db.labels()", "db. procedures"],
    ["MATCH (n) RETURN n; MATCH (m) RETURN m", "one statement"],
    ["LOAD CSV FROM 'x' AS r RETURN r", "LOAD CSV"],
  ])("rejects %s", (text, reason) => {
    expect(() => guard(text)).toThrow(reason);
  });

  it("allows a write keyword inside a string and a trailing semicolon", () => {
    expect(() => guard("MATCH (p:Package) WHERE p.name = 'CREATE' RETURN p.name;")).not.toThrow();
  });

  it("appends LIMIT 201, lowers a larger one, and keeps a smaller one", () => {
    expect(bounded("MATCH (n) RETURN n")).toBe("MATCH (n) RETURN n LIMIT 201");
    expect(bounded("MATCH (n) RETURN n LIMIT 5000;")).toBe("MATCH (n) RETURN n LIMIT 201");
    expect(bounded("MATCH (n) RETURN n LIMIT 5")).toBe("MATCH (n) RETURN n LIMIT 5");
    expect(bounded("MATCH (n) RETURN n LIMIT $k")).toBe("MATCH (n) RETURN n LIMIT 201");
  });
});

describe("read_only_cypher", () => {
  it("returns rows with every string marked as quoted data, and parameters work", async () => {
    const { ctx } = await seeded(db, made);
    const result = await toolbox(db).callTool(
      "read_only_cypher",
      {
        query: "MATCH (i:Install {lock_path: $p}) RETURN i.version AS v, 1 AS one",
        params: { p: "node_modules/qs" },
      },
      ctx,
      silent,
    );
    expect(result.ok && result.data).toEqual({
      rows: [{ v: { quoted: "6.7.0" }, one: 1 }],
      truncated: false,
    });
  });

  it("cuts 250 rows to 200 and says so", async () => {
    const { ctx } = await seeded(db, made);
    const result = await toolbox(db).callTool(
      "read_only_cypher",
      { query: "UNWIND range(1, 250) AS n RETURN n" },
      ctx,
      silent,
    );
    const data = result.ok ? (result.data as { rows: unknown[]; truncated: boolean }) : null;
    expect(data?.rows).toHaveLength(200);
    expect(data?.truncated).toBe(true);
  });

  it("turns nodes and edges in the rows into evidence with stable keys", async () => {
    const { ctx } = await seeded(db, made);
    const result = await toolbox(db).callTool(
      "read_only_cypher",
      {
        query: "MATCH (a:Install)-[r:DEPENDS_ON]->(b:Install {lock_path: 'node_modules/qs'}) RETURN a, r, b",
      },
      ctx,
      silent,
    );
    if (!result.ok) throw new Error(result.error);
    expect(result.evidence.nodes.map((n) => n.key).sort()).toEqual([
      "node_modules/body-parser",
      "node_modules/qs",
    ]);
    expect(result.evidence.edges.map((e) => e.key)).toEqual([
      "node_modules/body-parser|DEPENDS_ON|node_modules/qs",
    ]);
  });

  it.each([
    "CREATE (:Install {lock_path: 'node_modules/evil'})",
    "MATCH (i:Install) DELETE i",
    "CALL db.labels()",
  ])("refuses %s and leaves the graph unchanged", async (text) => {
    const { g, ctx } = await seeded(db, made);
    const result = await toolbox(db).callTool("read_only_cypher", { query: text }, ctx, silent);
    expect(result.ok).toBe(false);
    expect(await g.query(installs, {}, never)).toEqual([{ n: 12 }]);
  });
});
