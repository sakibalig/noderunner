import { randomBytes } from "node:crypto";
import { gzipSync } from "node:zlib";
import { type Db, type Forge, type G, GraphName, type RepoRef, type RunId, Sha } from "@noderunner/core";
import { connect } from "@noderunner/graph";
import { query } from "@noderunner/graph/cypher";
import { pack } from "tar-stream";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { IngestError } from "../errors.ts";
import { FETCH_LIMITS, repoUrl, snapshot, type Target } from "./fetch.ts";

type Item =
  | { readonly path: string; readonly body: string | Buffer }
  | { readonly path: string; readonly symlink: string };

const top = "acme-api-0123abc";
const sha = Sha.parse("b".repeat(40));
const repo: RepoRef = { owner: "Acme", name: "API" };
const manifestText = JSON.stringify({ name: "api", dependencies: { qs: "^6.7.0" } });
const lockText = (version = 3) =>
  JSON.stringify({
    lockfileVersion: version,
    packages: { "": { name: "api" }, "node_modules/qs": { version: "6.7.0" } },
  });

/** Builds a gzipped tarball the way GitHub lays one out: everything under one top-level folder. */
async function tarball(items: readonly Item[]): Promise<Buffer> {
  const archive = pack();
  archive.entry({ name: `${top}/`, type: "directory" });
  for (const item of items) {
    if ("symlink" in item)
      archive.entry({ name: `${top}/${item.path}`, type: "symlink", linkname: item.symlink });
    else archive.entry({ name: `${top}/${item.path}` }, item.body);
  }
  archive.finalize();
  const chunks: Uint8Array[] = [];
  for await (const chunk of archive) if (chunk instanceof Uint8Array) chunks.push(chunk);
  return gzipSync(Buffer.concat(chunks));
}

function forge(archive: Buffer, calls: string[] = []): Pick<Forge, "head" | "tarball"> {
  return {
    async head() {
      calls.push("head");
      return { branch: "main", sha };
    },
    async *tarball(_repo, at) {
      calls.push(`tarball ${at}`);
      for (let i = 0; i < archive.length; i += 64 * 1024) yield archive.subarray(i, i + 64 * 1024);
    },
  };
}

const base: Item[] = [
  { path: "package.json", body: manifestText },
  { path: "package-lock.json", body: lockText() },
];

// Integration: a real FalkorDB from `docker compose up falkordb`; each test writes to its own graph.
const url = process.env.FALKORDB_URL ?? "redis://localhost:6379";
const never = new AbortController().signal;
let db: Db;
const made: G[] = [];

function scratch(): G {
  const alphabet = "0123456789abcdefghjkmnpqrstvwxyz";
  const id = [...randomBytes(26)].map((byte) => alphabet[byte % 32]).join("");
  const g = db.graph(GraphName.parse(`verify:${id}`));
  made.push(g);
  return g;
}

const repoTarget: Target = { kind: "repo" };

async function run(items: readonly Item[], target: Target = repoTarget, ref: RepoRef = repo) {
  const events: number[] = [];
  const result = await snapshot(
    { g: scratch(), repo: ref, target },
    { forge: forge(await tarball(items)) },
    { onProgress: (event) => events.push(event.done), signal: never },
  );
  return { result, events };
}

async function failure(work: Promise<unknown>): Promise<IngestError> {
  try {
    await work;
  } catch (error) {
    if (error instanceof IngestError) return error;
    throw error;
  }
  throw new Error("expected an IngestError");
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

describe("snapshot: what is kept", () => {
  it("keeps source files and drops build output, dependencies, minified files, big files, and symlinks", async () => {
    const { result } = await run([
      ...base,
      { path: "src/a.ts", body: "export const a = 1;" },
      { path: "src/view.tsx", body: "export {}" },
      { path: "lib/b.cjs", body: "module.exports = 1" },
      { path: "README.md", body: "# api" },
      { path: "node_modules/x/index.js", body: "x" },
      { path: "packages/web/node_modules/y/index.js", body: "y" },
      { path: "dist/b.js", body: "b" },
      { path: "c.min.js", body: "c" },
      { path: "src/huge.ts", body: Buffer.alloc(600 * 1024, 97) },
      { path: "src/link.ts", symlink: "a.ts" },
    ]);
    expect([...result.files.keys()].sort()).toEqual(["lib/b.cjs", "src/a.ts", "src/view.tsx"]);
    expect(result.files.get("src/a.ts")).toBe("export const a = 1;");
    expect(result.warnings).toEqual([{ code: "skipped", count: 1, sample: ["src/huge.ts"] }]);
  });

  it("keeps a lockfile over the source size limit", async () => {
    const packages: Record<string, { version: string }> = { "": { version: "1.0.0" } };
    for (let i = 0; i < 30_000; i += 1) packages[`node_modules/pkg-${i}`] = { version: "1.0.0" };
    const big = JSON.stringify({ lockfileVersion: 3, packages });
    expect(Buffer.byteLength(big)).toBeGreaterThan(1024 * 1024);
    const { result } = await run([
      { path: "package.json", body: manifestText },
      { path: "package-lock.json", body: big },
    ]);
    expect(Object.keys(result.lock.packages).length).toBeGreaterThan(10_000);
  });

  it("stops keeping source at the total limit and reports the rest as skipped", async () => {
    const body = Buffer.alloc(500 * 1024, 97);
    const count = Math.floor(FETCH_LIMITS.keptBytes / body.length) + 3;
    const sources = Array.from({ length: count }, (_, i) => ({
      path: `src/f${String(i).padStart(3, "0")}.ts`,
      body,
    }));
    const { result } = await run([...base, ...sources]);
    expect(result.files.size).toBe(count - 3);
    expect(result.warnings).toEqual([
      { code: "skipped", count: 3, sample: sources.slice(-3).map((source) => source.path) },
    ]);
  }, 30_000);

  it("takes CODEOWNERS from .github/ before the root and docs/", async () => {
    const { result } = await run([
      ...base,
      { path: "docs/CODEOWNERS", body: "* @docs" },
      { path: "CODEOWNERS", body: "* @root" },
      { path: ".github/CODEOWNERS", body: "* @github" },
    ]);
    expect(result.codeowners).toBe("* @github");
  });

  it("falls back to docs/CODEOWNERS, and to null when there is none", async () => {
    expect((await run([...base, { path: "docs/CODEOWNERS", body: "* @docs" }])).result.codeowners).toBe(
      "* @docs",
    );
    expect((await run(base)).result.codeowners).toBeNull();
  });

  it("ignores a nested package.json and reports progress from 0 to 1", async () => {
    const { result, events } = await run([
      ...base,
      { path: "packages/web/package.json", body: JSON.stringify({ name: "other" }) },
    ]);
    expect(result.manifest.name).toBe("api");
    expect(events).toEqual([0, 1]);
  });
});

describe("snapshot: package files", () => {
  it("fails ingest.lockfile without a package-lock.json", async () => {
    const error = await failure(run([{ path: "package.json", body: manifestText }]));
    expect(error).toMatchObject({ code: "ingest.lockfile", surface: "unsupported" });
  });

  it("fails ingest.lockfile for lockfileVersion 1", async () => {
    const error = await failure(
      run([
        { path: "package.json", body: manifestText },
        { path: "package-lock.json", body: lockText(1) },
      ]),
    );
    expect(error.code).toBe("ingest.lockfile");
    expect(error.message).toContain("version 1");
  });

  it("fails ingest.lockfile for a lockfile that is not JSON", async () => {
    const error = await failure(
      run([
        { path: "package.json", body: manifestText },
        { path: "package-lock.json", body: "{" },
      ]),
    );
    expect(error.code).toBe("ingest.lockfile");
  });

  it("fails ingest.manifest without a root package.json", async () => {
    const error = await failure(run([{ path: "package-lock.json", body: lockText() }]));
    expect(error).toMatchObject({ code: "ingest.manifest", surface: "unsupported" });
  });

  it("fails ingest.manifest when dependencies are not a map of strings", async () => {
    const error = await failure(
      run([
        { path: "package.json", body: JSON.stringify({ dependencies: ["qs"] }) },
        { path: "package-lock.json", body: lockText() },
      ]),
    );
    expect(error.code).toBe("ingest.manifest");
  });

  it("replaces both package files with the override on a verify target", async () => {
    const target: Target = {
      kind: "verify",
      runId: "01JQZ8ABCDEFGHJKMNPQRSTVWX" as RunId,
      override: {
        manifest: JSON.stringify({ name: "api", dependencies: { qs: "^6.14.0" } }),
        lock: JSON.stringify({ lockfileVersion: 3, packages: { "node_modules/qs": { version: "6.14.0" } } }),
      },
    };
    const { result } = await run([...base, { path: "src/a.ts", body: "export {}" }], target, {
      ...repo,
      sha,
    });
    expect(result.manifest.dependencies).toEqual({ qs: "^6.14.0" });
    expect(result.lock.packages["node_modules/qs"]?.version).toBe("6.14.0");
    expect([...result.files.keys()]).toEqual(["src/a.ts"]);
  });

  it("fails ingest.upstream for a tarball that is not gzip", async () => {
    const g = scratch();
    const error = await failure(
      snapshot(
        { g, repo, target: repoTarget },
        { forge: forge(Buffer.from("not a tarball")) },
        { onProgress: () => {}, signal: never },
      ),
    );
    expect(error.code).toBe("ingest.upstream");
  });

  it("fails ingest.aborted when the signal has already fired, before any call", async () => {
    const calls: string[] = [];
    const error = await failure(
      snapshot(
        { g: scratch(), repo, target: repoTarget },
        { forge: forge(await tarball(base), calls) },
        { onProgress: () => {}, signal: AbortSignal.abort() },
      ),
    );
    expect(error.code).toBe("ingest.aborted");
    expect(calls).toEqual([]);
  });
});

describe("snapshot: the Repo node and the commit", () => {
  const repos = query(
    "test.repos",
    "MATCH (r:Repo) RETURN r.url AS url, r.owner AS owner, r.name AS name, r.default_branch AS branch, r.snapshot_sha AS stamp ORDER BY url LIMIT 10",
    z.object({
      url: z.string(),
      owner: z.string(),
      name: z.string(),
      branch: z.string().nullable(),
      stamp: z.string().nullable(),
    }),
  );

  it("reads the default branch head, records the Repo once, and leaves the stamp to stage 6", async () => {
    const g = scratch();
    const calls: string[] = [];
    const archive = await tarball(base);
    for (let i = 0; i < 2; i += 1) {
      const result = await snapshot(
        { g, repo, target: repoTarget },
        { forge: forge(archive, calls) },
        { onProgress: () => {}, signal: never },
      );
      expect(result.sha).toBe(sha);
      expect(result.url).toBe("https://github.com/acme/api");
    }
    expect(calls).toEqual(["head", `tarball ${sha}`, "head", `tarball ${sha}`]);
    expect(await g.query(repos, {}, never)).toEqual([
      { url: repoUrl(repo), owner: "Acme", name: "API", branch: "main", stamp: null },
    ]);
  });

  it("uses a given commit without reading the head, and keeps the stored branch", async () => {
    const g = scratch();
    const archive = await tarball(base);
    await snapshot(
      { g, repo, target: repoTarget },
      { forge: forge(archive) },
      { onProgress: () => {}, signal: never },
    );
    const calls: string[] = [];
    const given = Sha.parse("c".repeat(40));
    await snapshot(
      { g, repo: { ...repo, sha: given }, target: repoTarget },
      { forge: forge(archive, calls) },
      { onProgress: () => {}, signal: never },
    );
    expect(calls).toEqual([`tarball ${given}`]);
    expect((await g.query(repos, {}, never))[0]?.branch).toBe("main");
  });
});
