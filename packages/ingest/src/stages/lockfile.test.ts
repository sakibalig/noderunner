import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Db, type G, GraphName, Sha } from "@noderunner/core";
import { connect, migrate } from "@noderunner/graph";
import { golden, ingest, query } from "@noderunner/graph/cypher";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { lock as parseLock } from "../parse/lock.ts";
import type { Manifest } from "../parse/manifest.ts";
import { lockfile, resolve, tree } from "./lockfile.ts";

const nested = parseLock(
  readFileSync(join(import.meta.dirname, "../../../../fixtures/lockfiles/nested.json"), "utf8"),
);
const manifest: Manifest = {
  name: "nested",
  dependencies: { a: "^1.0.0", b: "^2.0.0" },
  devDependencies: { "jest-ish": "^1.0.0" },
};

describe("resolve", () => {
  const have = new Set([
    "node_modules/a",
    "node_modules/b",
    "node_modules/c",
    "node_modules/a/node_modules/b",
    "packages/local/node_modules/c",
  ]);

  it("gives the nested copy to its parent and the root copy to everyone else", () => {
    expect(resolve("node_modules/a", "b", have)).toBe("node_modules/a/node_modules/b");
    expect(resolve("node_modules/c", "b", have)).toBe("node_modules/b");
    expect(resolve("", "b", have)).toBe("node_modules/b");
  });

  it("walks up from a nested install to the root", () => {
    expect(resolve("node_modules/a/node_modules/b", "c", have)).toBe("node_modules/c");
  });

  it("looks in a workspace's own node_modules before the root's", () => {
    expect(resolve("packages/local/node_modules/q", "c", have)).toBe("packages/local/node_modules/c");
    expect(resolve("packages/local/node_modules/q", "a", have)).toBe("node_modules/a");
  });

  it("finds a scoped package and answers null when nothing matches", () => {
    expect(resolve("", "@scope/d", new Set(["node_modules/@scope/d"]))).toBe("node_modules/@scope/d");
    expect(resolve("node_modules/a", "ghost", have)).toBeNull();
  });
});

describe("tree", () => {
  const built = tree(nested, manifest);

  it("makes one install per versioned entry, skipping the root, links, and workspace folders", () => {
    expect(built.installs.map((install) => install.lock_path)).toEqual([
      "node_modules/@scope/d",
      "node_modules/a",
      "node_modules/a/node_modules/b",
      "node_modules/alias-folder",
      "node_modules/b",
      "node_modules/c",
      "node_modules/jest-ish",
      "packages/local/node_modules/c",
    ]);
  });

  it("names an install from the entry when given, else from its path, and builds its purl", () => {
    const byPath = new Map(built.installs.map((install) => [install.lock_path, install]));
    expect(byPath.get("node_modules/alias-folder")).toMatchObject({ name: "real-name", version: "0.1.0" });
    expect(byPath.get("node_modules/a/node_modules/b")).toMatchObject({ name: "b", purl: "pkg:npm/b@1.5.0" });
    expect(byPath.get("node_modules/@scope/d")?.purl).toBe("pkg:npm/%40scope/d@3.0.0");
  });

  it("marks dev and devOptional entries as dev", () => {
    expect(built.installs.filter((install) => install.dev).map((install) => install.lock_path)).toEqual([
      "node_modules/@scope/d",
      "node_modules/jest-ish",
    ]);
  });

  it("resolves exactly the hand-counted DEPENDS_ON edges", () => {
    expect(built.depends).toEqual([
      { from: "node_modules/a", to: "node_modules/a/node_modules/b", range: "^1.0.0", kind: "prod" },
      { from: "node_modules/a", to: "node_modules/c", range: "^1.0.0", kind: "prod" },
      { from: "node_modules/a/node_modules/b", to: "node_modules/c", range: "^1.0.0", kind: "prod" },
      { from: "node_modules/jest-ish", to: "node_modules/@scope/d", range: "^3.0.0", kind: "prod" },
      { from: "node_modules/jest-ish", to: "node_modules/c", range: "^1.0.0", kind: "prod" },
    ]);
  });

  it("declares the root's direct dependencies with their range and dev flag", () => {
    expect(built.declares).toEqual([
      { to: "node_modules/a", range: "^1.0.0", dev: false },
      { to: "node_modules/b", range: "^2.0.0", dev: false },
      { to: "node_modules/jest-ish", range: "^1.0.0", dev: true },
    ]);
  });

  it("warns once for the unresolved regular dependency and the entry with no version, never for optional or peer", () => {
    expect(built.warnings).toEqual([
      { code: "skipped", count: 1, sample: ["node_modules/noversion"] },
      { code: "unresolved", count: 1, sample: ["node_modules/b -> ghost"] },
    ]);
  });

  it("prefers prod over optional over peer when one dependency is listed twice", () => {
    const twice = parseLock(
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          "node_modules/x": {
            version: "1.0.0",
            peerDependencies: { y: "*" },
            optionalDependencies: { y: "^2" },
            dependencies: { y: "^1" },
          },
          "node_modules/y": { version: "1.0.0" },
        },
      }),
    );
    expect(tree(twice, {}).depends).toEqual([
      { from: "node_modules/x", to: "node_modules/y", range: "^1", kind: "prod" },
    ]);
  });

  it("warns for a declared dependency that is not installed, unless it is optional", () => {
    const built2 = tree(nested, { dependencies: { missing: "1" }, optionalDependencies: { maybe: "1" } });
    expect(built2.warnings).toContainEqual({
      code: "unresolved",
      count: 2,
      sample: ["node_modules/b -> ghost", "package.json -> missing"],
    });
  });

  it("gives the same rows for the same input", () => {
    expect(tree(nested, manifest)).toEqual(built);
  });
});

// Integration: a real FalkorDB from `docker compose up falkordb`.
const url = process.env.FALKORDB_URL ?? "redis://localhost:6379";
const never = new AbortController().signal;
const repoUrl = "https://github.com/acme/nested";
const sha = Sha.parse("e".repeat(40));
let db: Db;
const made: G[] = [];

async function scratch(): Promise<G> {
  const alphabet = "0123456789abcdefghjkmnpqrstvwxyz";
  const id = [...randomBytes(26)].map((byte) => alphabet[byte % 32]).join("");
  const g = db.graph(GraphName.parse(`verify:${id}`));
  made.push(g);
  await migrate(g, "repo", never);
  await g.query(ingest.repo.upsert, { url: repoUrl, owner: "acme", name: "nested", branch: "main" }, never);
  return g;
}

const shape = query(
  "test.shape",
  `MATCH (i:Install) WITH count(i) AS installs
MATCH (p:Package) WITH installs, count(p) AS packages
OPTIONAL MATCH (:Install)-[d:DEPENDS_ON]->(:Install) WITH installs, packages, count(d) AS depends
OPTIONAL MATCH (:Install)-[o:OF]->(:Package)
RETURN installs, packages, depends, count(o) AS ofs`,
  z.object({ installs: z.number(), packages: z.number(), depends: z.number(), ofs: z.number() }),
);
const declared = query(
  "test.declared",
  "MATCH (:Repo)-[d:DECLARES]->(i:Install) RETURN i.lock_path AS path, d.range AS range, d.dev AS dev, d.snapshot_sha AS sha ORDER BY path LIMIT 10",
  z.object({ path: z.string(), range: z.string(), dev: z.boolean(), sha: z.string() }),
);
const nestedEdge = query(
  "test.nestedEdge",
  "MATCH (:Install {lock_path: 'node_modules/a'})-[e:DEPENDS_ON]->(b:Install) RETURN b.lock_path AS to, e.kind AS kind, e.snapshot_sha AS sha ORDER BY to LIMIT 10",
  z.object({ to: z.string(), kind: z.string(), sha: z.string() }),
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

describe("lockfile", () => {
  it("writes the fixture's installs, packages, and edges, and a second run changes nothing", async () => {
    const g = await scratch();
    const events: number[] = [];
    const input = { g, url: repoUrl, sha, lock: nested, manifest };
    const opts = { onProgress: (e: { done: number }) => events.push(e.done), signal: never };
    const result = await lockfile(input, opts);
    expect(result.installs).toBe(8);
    const expected = { installs: 8, packages: 6, depends: 5, ofs: 8 };
    expect((await g.query(shape, {}, never))[0]).toEqual(expected);
    await lockfile(input, opts);
    expect((await g.query(shape, {}, never))[0]).toEqual(expected);
    expect(events.slice(0, 3)).toEqual([0, 8, 16]);
  });

  it("stamps edges with the commit and keeps the nested copy apart", async () => {
    const g = await scratch();
    await lockfile({ g, url: repoUrl, sha, lock: nested, manifest }, { onProgress: () => {}, signal: never });
    expect(await g.query(nestedEdge, {}, never)).toEqual([
      { to: "node_modules/a/node_modules/b", kind: "prod", sha },
      { to: "node_modules/c", kind: "prod", sha },
    ]);
    expect(await g.query(declared, {}, never)).toEqual([
      { path: "node_modules/a", range: "^1.0.0", dev: false, sha },
      { path: "node_modules/b", range: "^2.0.0", dev: false, sha },
      { path: "node_modules/jest-ish", range: "^1.0.0", dev: true, sha },
    ]);
  });

  it("answers G1 with the hand counts", async () => {
    const g = await scratch();
    await lockfile({ g, url: repoUrl, sha, lock: nested, manifest }, { onProgress: () => {}, signal: never });
    expect(await g.query(golden.counts, { url: repoUrl }, never)).toEqual([
      { installs: 8, dev: 2, direct: 3 },
    ]);
  });
});
