import { randomBytes } from "node:crypto";
import { type Db, type G, GraphName } from "@noderunner/core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { connect } from "./client.ts";
import { schema } from "./cypher/index.ts";
import { migrate } from "./migrate.ts";

// Integration tests against a real FalkorDB; each runs on its own verification graph.
const url = process.env.FALKORDB_URL ?? "redis://localhost:6379";
const never = new AbortController().signal;
let db: Db;
const made: G[] = [];

function scratch(): G {
  const alphabet = "0123456789abcdefghjkmnpqrstvwxyz";
  const token = [...randomBytes(26)].map((byte) => alphabet[byte % 32]).join("");
  const g = db.graph(GraphName.parse(`verify:${token}`));
  made.push(g);
  return g;
}

async function indexed(g: G): Promise<string[]> {
  const rows = await g.query(schema.indexes, {}, never);
  return rows.flatMap((row) => row.properties.map((property) => `${row.label}.${property}`)).sort();
}

beforeAll(async () => {
  db = await connect({ url, signal: never, onError: () => {} });
});

afterEach(async () => {
  for (const g of made.splice(0)) await g.drop();
});

afterAll(async () => {
  await db.close();
});

describe("migrate", () => {
  it("creates exactly the nine repository indexes, and a second run changes nothing", async () => {
    const g = scratch();
    const expected = schema.repo.map((index) => `${index.label}.${index.property}`).sort();
    await migrate(g, "repo", never);
    expect(await indexed(g)).toEqual(expected);
    await migrate(g, "repo", never);
    expect(await indexed(g)).toEqual(expected);
    expect(expected).toHaveLength(9);
  });

  it("creates exactly the two advisories indexes", async () => {
    const g = scratch();
    await migrate(g, "advisories", never);
    await migrate(g, "advisories", never);
    expect(await indexed(g)).toEqual(["Adv.id", "PV.key"]);
  });

  it("adds only the missing indexes to a partly indexed graph", async () => {
    const g = scratch();
    const [first] = schema.repo;
    if (first === undefined) throw new Error("the repo index list is empty");
    await g.query(first.create, {}, never);
    await migrate(g, "repo", never);
    expect(await indexed(g)).toHaveLength(9);
  });
});
