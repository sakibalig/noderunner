import { randomBytes } from "node:crypto";
import { type Db, type G, GraphName, Sha } from "@noderunner/core";
import { connect, migrate } from "@noderunner/graph";
import { golden, ingest, query } from "@noderunner/graph/cypher";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { lock as parseLock } from "../parse/lock.ts";
import type { Manifest } from "../parse/manifest.ts";
import { bare, graph, imports, load, relative } from "./imports.ts";
import { lockfile } from "./lockfile.ts";

const kept = new Set(["src/a.ts", "src/util.ts", "src/view.tsx", "src/dir/index.ts", "src/esm.mts"]);

describe("relative", () => {
  it.each([
    ["src/a.ts", "./util", "src/util.ts"],
    ["src/a.ts", "./util.js", "src/util.ts"],
    ["src/a.ts", "./view.jsx", "src/view.tsx"],
    ["src/a.ts", "./view.js", "src/view.tsx"],
    ["src/a.ts", "./esm.mjs", "src/esm.mts"],
    ["src/a.ts", "./dir", "src/dir/index.ts"],
    ["src/dir/index.ts", "../util", "src/util.ts"],
    ["src/dir/index.ts", "..", "src/index.ts"],
  ])("resolves %s importing %s to %s", (from, specifier, expected) => {
    const files = new Set([...kept, "src/index.ts"]);
    expect(relative(from, specifier, files)).toEqual({ kind: "file", path: expected });
  });

  it("ignores data and style files, and paths outside the repository", () => {
    expect(relative("src/a.ts", "./data.json", kept)).toEqual({ kind: "ignored" });
    expect(relative("src/a.ts", "./styles.css", kept)).toEqual({ kind: "ignored" });
    expect(relative("a.ts", "../outside", kept)).toEqual({ kind: "ignored" });
  });

  it("reports a source file that was not kept as missing", () => {
    expect(relative("src/a.ts", "./gone", kept)).toEqual({ kind: "missing" });
    expect(relative("src/a.ts", "./gone.js", kept)).toEqual({ kind: "missing" });
  });
});

describe("bare and load", () => {
  it.each([
    ["lodash", "lodash"],
    ["lodash/merge", "lodash"],
    ["@scope/pkg", "@scope/pkg"],
    ["@scope/pkg/deep/x", "@scope/pkg"],
  ])("names %s as package %s", (specifier, name) => {
    expect(bare(specifier)).toEqual({ name });
  });

  it.each(["@/lib", "~/utils", "#internal", "@"])("treats %s as an alias", (specifier) => {
    expect(bare(specifier)).toBeNull();
  });

  const installs = new Set([
    "node_modules/react",
    "packages/web/node_modules/react",
    "node_modules/@scope/pkg",
  ]);

  it("loads a workspace's own copy before the root's, walking up from the file's folder", () => {
    expect(load("packages/web/src/deep/page.tsx", "react", installs)).toBe("packages/web/node_modules/react");
    expect(load("packages/api/src/main.ts", "react", installs)).toBe("node_modules/react");
    expect(load("index.ts", "@scope/pkg", installs)).toBe("node_modules/@scope/pkg");
    expect(load("src/a.ts", "ghost", installs)).toBeNull();
  });
});

const files = new Map([
  [
    "src/index.ts",
    [
      'import express from "express";',
      'import { u } from "./util.js";',
      'import x from "@/lib";',
      'import fs from "node:fs";',
      'import p from "path";',
      'import m from "lodash/merge";',
      'import g from "ghost";',
      'import d from "./data.json";',
      'import miss from "./missing";',
      "export const all = [express, u, x, fs, p, m, g, d, miss];",
    ].join("\n"),
  ],
  ["src/util.ts", 'export const u = require("qs");'],
  ["src/dir/index.ts", 'export * from "../util";'],
  ["src/use.ts", 'import "./dir";'],
  ["src/app.test.ts", 'import express from "express";'],
  [
    "packages/web/src/page.tsx",
    'import React from "react";\nimport q from "qs";\nexport const P = () => <i>{q}</i>;',
  ],
]);
const manifest: Manifest = { main: "./src/index.ts", dependencies: { express: "4", qs: "6", lodash: "4" } };
const installed = new Set([
  "node_modules/express",
  "node_modules/lodash",
  "node_modules/qs",
  "node_modules/react",
  "packages/web/node_modules/react",
]);

describe("graph", () => {
  const built = graph(files, manifest, installed);

  it("classifies every kept file and marks the entry", () => {
    expect(built.files).toEqual([
      { path: "packages/web/src/page.tsx", kind: "prod", is_entry: false },
      { path: "src/app.test.ts", kind: "test", is_entry: false },
      { path: "src/dir/index.ts", kind: "prod", is_entry: false },
      { path: "src/index.ts", kind: "prod", is_entry: true },
      { path: "src/use.ts", kind: "prod", is_entry: false },
      { path: "src/util.ts", kind: "prod", is_entry: false },
    ]);
  });

  it("links relative imports between files", () => {
    expect(built.links).toEqual([
      { from: "src/dir/index.ts", to: "src/util.ts" },
      { from: "src/index.ts", to: "src/util.ts" },
      { from: "src/use.ts", to: "src/dir/index.ts" },
    ]);
  });

  it("records each bare package import once per file, keeping the first specifier, and skips built-ins", () => {
    expect(built.uses.map((use) => `${use.from} ${use.name} ${use.specifier}`)).toEqual([
      "packages/web/src/page.tsx qs qs",
      "packages/web/src/page.tsx react react",
      "src/app.test.ts express express",
      "src/index.ts express express",
      "src/index.ts ghost ghost",
      "src/index.ts lodash lodash/merge",
      "src/util.ts qs qs",
    ]);
  });

  it("loads the install Node would load from each file", () => {
    expect(built.loads).toEqual([
      { from: "packages/web/src/page.tsx", to: "node_modules/qs" },
      { from: "packages/web/src/page.tsx", to: "packages/web/node_modules/react" },
      { from: "src/app.test.ts", to: "node_modules/express" },
      { from: "src/index.ts", to: "node_modules/express" },
      { from: "src/index.ts", to: "node_modules/lodash" },
      { from: "src/util.ts", to: "node_modules/qs" },
    ]);
  });

  it("warns for the alias and for what cannot be resolved, and nothing else", () => {
    expect(built.warnings).toEqual([
      { code: "alias", count: 1, sample: ["src/index.ts -> @/lib"] },
      { code: "unresolved", count: 2, sample: ["src/index.ts -> ghost", "src/index.ts -> ./missing"] },
    ]);
  });

  it("gives a parse warning for a file only the regex could read", () => {
    const broken = graph(new Map([["src/b.ts", 'import q from "qs";\nconst = ;']]), {}, installed);
    expect(broken.warnings).toEqual([{ code: "parse", count: 1, sample: ["src/b.ts"] }]);
    expect(broken.loads).toEqual([{ from: "src/b.ts", to: "node_modules/qs" }]);
  });
});

// Integration: a real FalkorDB from `docker compose up falkordb`.
const url = process.env.FALKORDB_URL ?? "redis://localhost:6379";
const never = new AbortController().signal;
const repoUrl = "https://github.com/acme/web";
const sha = Sha.parse("f".repeat(40));
let db: Db;
const made: G[] = [];

const lock = parseLock(
  JSON.stringify({
    lockfileVersion: 3,
    packages: Object.fromEntries([...installed].map((path) => [path, { version: "1.0.0" }])),
  }),
);

async function seeded(): Promise<G> {
  const alphabet = "0123456789abcdefghjkmnpqrstvwxyz";
  const id = [...randomBytes(26)].map((byte) => alphabet[byte % 32]).join("");
  const g = db.graph(GraphName.parse(`verify:${id}`));
  made.push(g);
  await migrate(g, "repo", never);
  await g.query(ingest.repo.upsert, { url: repoUrl, owner: "acme", name: "web", branch: "main" }, never);
  const opts = { onProgress: () => {}, signal: never };
  const stage2 = await lockfile({ g, url: repoUrl, sha, lock, manifest }, opts);
  await imports({ g, url: repoUrl, sha, files, manifest, installs: stage2.paths }, opts);
  return g;
}

const shape = query(
  "test.shape",
  `MATCH (:Repo)-[c:CONTAINS]->(:File) WITH count(c) AS contains
OPTIONAL MATCH (:File)-[l:IMPORTS]->(:File) WITH contains, count(l) AS links
OPTIONAL MATCH (:File)-[u:IMPORTS]->(:Package) WITH contains, links, count(u) AS uses
OPTIONAL MATCH (:File)-[d:LOADS]->(:Install)
RETURN contains, links, uses, count(d) AS loads`,
  z.object({ contains: z.number(), links: z.number(), uses: z.number(), loads: z.number() }),
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

describe("imports stage", () => {
  it("writes files and edges, skipping a package with no install, and a rerun changes nothing", async () => {
    const g = await seeded();
    const expected = { contains: 6, links: 3, uses: 6, loads: 6 };
    expect((await g.query(shape, {}, never))[0]).toEqual(expected);
    await imports(
      { g, url: repoUrl, sha, files, manifest, installs: installed },
      { onProgress: () => {}, signal: never },
    );
    expect((await g.query(shape, {}, never))[0]).toEqual(expected);
  });

  it("answers G4 with production loaders only, including a workspace's own copy", async () => {
    const g = await seeded();
    expect(await g.query(golden.loaders, { package: "qs" }, never)).toEqual([
      { file: "packages/web/src/page.tsx" },
      { file: "src/util.ts" },
    ]);
    expect(await g.query(golden.loaders, { package: "express" }, never)).toEqual([{ file: "src/index.ts" }]);
    expect(await g.query(golden.loaders, { package: "react" }, never)).toEqual([
      { file: "packages/web/src/page.tsx" },
    ]);
  });
});
