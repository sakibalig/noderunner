import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Advisories, type Db, type G, GraphName, OsvRecord, Sha } from "@noderunner/core";
import { connect, migrate } from "@noderunner/graph";
import { golden, ingest, query, write } from "@noderunner/graph/cypher";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { lock as parseLock } from "../parse/lock.ts";
import { advisories, affected, type Installed, normalise, pairs } from "./advisories.ts";
import { lockfile } from "./lockfile.ts";

const dir = join(import.meta.dirname, "../../../../fixtures/osv");
const record = (id: string) => OsvRecord.parse(JSON.parse(readFileSync(join(dir, `${id}.json`), "utf8")));
const qs = record("GHSA-4mjr-xmp4-gh2g");
const express = record("GHSA-rv95-896h-c2vc");
const minimist = record("GHSA-vh95-rmgr-6w4m");
const records = new Map([qs, express, minimist].map((r) => [r.id, r]));

const installs: Installed[] = [
  { lock_path: "node_modules/qs", name: "qs", version: "6.7.0" },
  { lock_path: "node_modules/body-parser/node_modules/qs", name: "qs", version: "6.7.0" },
  { lock_path: "node_modules/express", name: "express", version: "4.17.1" },
  { lock_path: "node_modules/minimist", name: "minimist", version: "1.2.0" },
  { lock_path: "node_modules/left-pad", name: "left-pad", version: "1.3.0" },
];
const asked = pairs(installs);
const answers: Record<string, readonly { id: string; modified: number }[]> = {
  "express@4.17.1": [{ id: express.id, modified: 1 }],
  "minimist@1.2.0": [{ id: minimist.id, modified: 1 }],
  "qs@6.7.0": [
    { id: qs.id, modified: 1 },
    { id: "GHSA-gone-gone-gone", modified: 1 },
  ],
};
const hits = asked.map((pair) => answers[`${pair.name}@${pair.version}`] ?? []);

describe("normalise", () => {
  it("keeps the installed package's ranges, sorts the fixed versions, and converts dates", () => {
    const row = normalise(express, ["express"]);
    expect(row).toMatchObject({
      id: "GHSA-rv95-896h-c2vc",
      severity: "moderate",
      severity_rank: 2,
      published: Date.parse(express.published),
      modified: Date.parse(express.modified),
      fixed: ["4.19.2", "5.0.0-beta.3"],
      packages: ["express"],
    });
    expect(Object.keys(JSON.parse(row.ranges))).toEqual(["express"]);
    expect(JSON.parse(row.ranges).express).toHaveLength(2);
  });

  it("cuts the summary to 500 characters and sorts aliases", () => {
    const long = { ...qs, summary: "x".repeat(800), aliases: ["CVE-2", "CVE-1"] };
    const row = normalise(long, ["qs"]);
    expect(row.summary).toHaveLength(500);
    expect(row.aliases).toEqual(["CVE-1", "CVE-2"]);
  });

  it("answers unknown severity and no ranges when the record names neither", () => {
    const bare = { ...qs, database_specific: undefined };
    expect(normalise(bare, ["other"])).toMatchObject({ severity: "unknown", severity_rank: 0, fixed: [] });
  });
});

describe("pairs and affected", () => {
  it("asks about each distinct name and version once, sorted", () => {
    expect(asked.map((p) => `${p.name}@${p.version}`)).toEqual([
      "express@4.17.1",
      "left-pad@1.3.0",
      "minimist@1.2.0",
      "qs@6.7.0",
    ]);
  });

  const built = affected(installs, asked, hits, records);

  it("makes one finding per advisory and package, with AT to every affected install", () => {
    expect(built.findings.map((f) => f.key)).toEqual([
      "GHSA-4mjr-xmp4-gh2g|qs",
      "GHSA-rv95-896h-c2vc|express",
      "GHSA-vh95-rmgr-6w4m|minimist",
    ]);
    expect(built.at.filter((a) => a.key === "GHSA-4mjr-xmp4-gh2g|qs").map((a) => a.lock_path)).toEqual([
      "node_modules/body-parser/node_modules/qs",
      "node_modules/qs",
    ]);
    expect(built.affects).toHaveLength(4);
    expect(built.vulns.map((v) => v.id)).toEqual([qs.id, express.id, minimist.id]);
  });

  it("skips an advisory whose record OSV no longer has, with a skipped warning, and agrees with OSV otherwise", () => {
    expect(built.warnings).toEqual([{ code: "skipped", count: 1, sample: ["GHSA-gone-gone-gone"] }]);
  });

  it("gives a range warning where the ranges say a listed version is not affected", () => {
    const fixedVersion = [{ lock_path: "node_modules/qs", name: "qs", version: "6.16.0" }];
    const result = affected(fixedVersion, pairs(fixedVersion), [[{ id: qs.id, modified: 1 }]], records);
    expect(result.warnings).toEqual([{ code: "range", count: 1, sample: [`${qs.id} qs@6.16.0`] }]);
    expect(result.affects).toHaveLength(1);
  });
});

// Integration: a real FalkorDB from `docker compose up falkordb`; OSV is a double over the recorded fixtures.
const url = process.env.FALKORDB_URL ?? "redis://localhost:6379";
const never = new AbortController().signal;
const sha = Sha.parse("a".repeat(40));
let db: Db;
const made: G[] = [];

const recorded: Advisories = {
  async query(asked) {
    return asked.map((pair) => answers[`${pair.name}@${pair.version}`] ?? []);
  },
  async record(id) {
    return records.get(id) ?? null;
  },
};

async function seeded(): Promise<G> {
  const alphabet = "0123456789abcdefghjkmnpqrstvwxyz";
  const id = [...randomBytes(26)].map((byte) => alphabet[byte % 32]).join("");
  const g = db.graph(GraphName.parse(`verify:${id}`));
  made.push(g);
  await migrate(g, "repo", never);
  const repoUrl = "https://github.com/acme/api";
  await g.query(ingest.repo.upsert, { url: repoUrl, owner: "acme", name: "api", branch: "main" }, never);
  const lock = parseLock(
    JSON.stringify({
      lockfileVersion: 3,
      packages: Object.fromEntries(installs.map((i) => [i.lock_path, { version: i.version }])),
    }),
  );
  await lockfile({ g, url: repoUrl, sha, lock, manifest: {} }, { onProgress: () => {}, signal: never });
  return g;
}

const statuses = query(
  "test.statuses",
  "MATCH (x:Finding)-[:ABOUT]->(v:Vuln) OPTIONAL MATCH (x)-[a:AT]->(:Install) RETURN x.key AS key, x.status AS status, x.severity AS severity, count(a) AS at ORDER BY key LIMIT 10",
  z.object({ key: z.string(), status: z.string(), severity: z.string(), at: z.number() }),
);
const setStatus = write(
  "test.setStatus",
  "MATCH (x:Finding {key: $key}) SET x.status = $status, x.fixed_at = 1",
);
const inPackage = query(
  "test.inPackage",
  "MATCH (v:Vuln)-[:IN_PACKAGE]->(p:Package) RETURN v.id AS id, p.name AS name, v.severity_rank AS rank ORDER BY id LIMIT 10",
  z.object({ id: z.string(), name: z.string(), rank: z.number() }),
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

describe("advisories stage", () => {
  it("writes vulnerabilities, findings, and AT edges, and answers G2", async () => {
    const g = await seeded();
    const result = await advisories(
      { g, sha, installs },
      { advisories: recorded },
      { onProgress: () => {}, signal: never },
    );
    expect(result).toMatchObject({ vulns: 3, findings: 3 });
    expect(await g.query(statuses, {}, never)).toEqual([
      { key: "GHSA-4mjr-xmp4-gh2g|qs", status: "open", severity: "moderate", at: 2 },
      { key: "GHSA-rv95-896h-c2vc|express", status: "open", severity: "moderate", at: 1 },
      { key: "GHSA-vh95-rmgr-6w4m|minimist", status: "open", severity: "moderate", at: 1 },
    ]);
    expect(await g.query(inPackage, {}, never)).toEqual([
      { id: qs.id, name: "qs", rank: 2 },
      { id: express.id, name: "express", rank: 2 },
      { id: minimist.id, name: "minimist", rank: 2 },
    ]);
    expect(await g.query(golden.vulns, {}, never)).toEqual([
      {
        vuln: qs.id,
        severity: "moderate",
        installs: ["node_modules/body-parser/node_modules/qs", "node_modules/qs"],
      },
      { vuln: express.id, severity: "moderate", installs: ["node_modules/express"] },
      { vuln: minimist.id, severity: "moderate", installs: ["node_modules/minimist"] },
    ]);
  });

  it("reopens a fixed finding that reappears and leaves a waived one waived", async () => {
    const g = await seeded();
    const run = () =>
      advisories({ g, sha, installs }, { advisories: recorded }, { onProgress: () => {}, signal: never });
    await run();
    await g.query(setStatus, { key: "GHSA-4mjr-xmp4-gh2g|qs", status: "fixed" }, never);
    await g.query(setStatus, { key: "GHSA-rv95-896h-c2vc|express", status: "waived" }, never);
    await run();
    expect((await g.query(statuses, {}, never)).map((row) => `${row.key} ${row.status} ${row.at}`)).toEqual([
      "GHSA-4mjr-xmp4-gh2g|qs open 2",
      "GHSA-rv95-896h-c2vc|express waived 1",
      "GHSA-vh95-rmgr-6w4m|minimist open 1",
    ]);
  });
});
