import type { Db, G } from "@noderunner/core";
import { connect } from "@noderunner/graph";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { seeded, silent, toolbox } from "../fixture.ts";

const url = process.env.FALKORDB_URL ?? "redis://localhost:6379";
const never = new AbortController().signal;
let db: Db;
const made: G[] = [];

beforeAll(async () => {
  db = await connect({ url, signal: never, onError: () => {} });
});
afterEach(async () => {
  for (const g of made.splice(0)) await g.drop();
});
afterAll(async () => {
  await db.close();
});

describe("introduced_by", () => {
  it.each([
    [
      "GHSA-hrpp-h998-j3pp|qs",
      {
        package: "express",
        range: "^4.17.1",
        dev: false,
        chain: ["node_modules/express", "node_modules/body-parser", "node_modules/qs"],
      },
    ],
    [
      "GHSA-rv95-896h-c2vc|express",
      { package: "express", range: "^4.17.1", dev: false, chain: ["node_modules/express"] },
    ],
    [
      "GHSA-vh95-rmgr-6w4m|minimist",
      {
        package: "mkdirp",
        range: "^0.5.1",
        dev: false,
        chain: ["node_modules/mkdirp", "node_modules/minimist"],
      },
    ],
    [
      "GHSA-35jh-r3h4-6jhm|lodash",
      {
        package: "jest-lite",
        range: "^1.0.0",
        dev: true,
        chain: ["node_modules/jest-lite", "node_modules/lodash"],
      },
    ],
  ])("traces %s to the direct dependency that brings it in", async (key, expected) => {
    const { ctx } = await seeded(db, made);
    const result = await toolbox(db).callTool("introduced_by", { key }, ctx, silent);
    expect(result.ok && result.data).toEqual({ direct: [expected] });
  });

  it("gives the DECLARES edge and the chain as evidence", async () => {
    const { ctx } = await seeded(db, made);
    const result = await toolbox(db).callTool(
      "introduced_by",
      { key: "GHSA-hrpp-h998-j3pp|qs" },
      ctx,
      silent,
    );
    expect(result.ok && result.evidence.edges.map((e) => e.key)).toEqual([
      "https://github.com/acme/mini-repo|DECLARES|node_modules/express",
      "node_modules/express|DEPENDS_ON|node_modules/body-parser",
      "node_modules/body-parser|DEPENDS_ON|node_modules/qs",
    ]);
    expect(result.ok && result.summary).toBe("GHSA-hrpp-h998-j3pp|qs comes in through express");
  });

  it("answers missing for an unknown finding", async () => {
    const { ctx } = await seeded(db, made);
    const result = await toolbox(db).callTool("introduced_by", { key: "X|y" }, ctx, silent);
    expect(result).toMatchObject({ ok: false, error: "No finding has the key X|y" });
  });
});
