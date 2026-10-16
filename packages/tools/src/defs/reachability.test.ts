import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import {
  type Advisories,
  type Db,
  type G,
  GraphName,
  OsvRecord,
  RunId,
  Sha,
  type ToolCtx,
} from "@noderunner/core";
import { connect, migrate } from "@noderunner/graph";
import { golden, ingest, memory, query } from "@noderunner/graph/cypher";
import { advisories, imports, lock, lockfile, Manifest, tree } from "@noderunner/ingest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createToolbox, type StepHooks } from "../call.ts";
import { createTools } from "../registry.ts";

const root = join(import.meta.dirname, "../../../..");
const mini = join(root, "fixtures/mini-repo");
const repoUrl = "https://github.com/acme/mini-repo";
const sha = Sha.parse("1".repeat(40));
const never = new AbortController().signal;
const url = process.env.FALKORDB_URL ?? "redis://localhost:6379";

function sources(dir: string): Map<string, string> {
  const files = new Map<string, string>();
  const visit = (at: string) => {
    for (const name of readdirSync(at)) {
      const path = join(at, name);
      if (statSync(path).isDirectory()) visit(path);
      else if (/\.(ts|js)$/.test(name)) files.set(relative(dir, path), readFileSync(path, "utf8"));
    }
  };
  visit(join(dir, "src"));
  visit(join(dir, "scripts"));
  return files;
}

const answers = z
  .record(z.string(), z.array(z.string()))
  .parse(JSON.parse(readFileSync(join(mini, "osv.json"), "utf8")));
const records = new Map(
  [
    join(root, "fixtures/osv/GHSA-rv95-896h-c2vc.json"),
    join(root, "fixtures/osv/GHSA-vh95-rmgr-6w4m.json"),
    join(root, "packages/core/src/fixtures/osv/GHSA-35jh-r3h4-6jhm.json"),
    join(root, "packages/core/src/fixtures/osv/GHSA-hrpp-h998-j3pp.json"),
  ].map((path) => {
    const record = OsvRecord.parse(JSON.parse(readFileSync(path, "utf8")));
    return [record.id, record] as const;
  }),
);
const recorded: Advisories = {
  async query(pairs) {
    return pairs.map((pair) =>
      (answers[`${pair.name}@${pair.version}`] ?? []).map((id) => ({ id, modified: 1 })),
    );
  },
  async record(id) {
    return records.get(id) ?? null;
  },
};

let db: Db;
const made: G[] = [];
let counter = 0;

function ulid(): string {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  return [...randomBytes(26)]
    .map((byte) => alphabet[byte % 32])
    .join("")
    .replace(/^./, "0");
}

/** A fresh graph holding the mini-repo after stages 2 to 4, and a triage run to hang steps on. */
async function seeded(): Promise<{ g: G; ctx: ToolCtx }> {
  const g = db.graph(GraphName.parse(`verify:${ulid().toLowerCase()}`));
  made.push(g);
  await migrate(g, "repo", never);
  await g.query(
    ingest.repo.upsert,
    { url: repoUrl, owner: "acme", name: "mini-repo", branch: "main" },
    never,
  );
  const manifestFile = Manifest.parse(JSON.parse(readFileSync(join(mini, "package.json"), "utf8")));
  const lockFile = lock(readFileSync(join(mini, "package-lock.json"), "utf8"));
  const opts = { onProgress: () => {}, signal: never };
  const stage2 = await lockfile({ g, url: repoUrl, sha, lock: lockFile, manifest: manifestFile }, opts);
  await imports(
    { g, url: repoUrl, sha, files: sources(mini), manifest: manifestFile, installs: stage2.paths },
    opts,
  );
  await advisories(
    { g, sha, installs: tree(lockFile, manifestFile).installs },
    { advisories: recorded },
    opts,
  );
  const runId = RunId.parse(ulid());
  await g.query(memory.run.start, { id: runId, agent: "triage", model: null, now: 0 }, never);
  return { g, ctx: { graph: g.name, runId, actor: "triage", signal: never } };
}

const hooks: StepHooks = { onStart: () => {}, onFinish: () => {} };

function toolbox() {
  return createToolbox(
    { db, clock: { now: () => (counter += 1) }, ids: { next: ulid }, tools: createTools({ db }) },
    { access: ["read", "derive", "act"] },
  );
}

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
    const result = await toolbox().callTool("reachability", {}, ctx, hooks);
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
    const result = await toolbox().callTool("reachability", {}, ctx, hooks);
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
    const result = await toolbox().callTool(
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
    const result = await toolbox().callTool("reachability", { keys: ["GHSA-nope|nothing"] }, ctx, hooks);
    expect(result).toMatchObject({ ok: false, error: "No finding has the key GHSA-nope|nothing" });
  });

  it("gives the same answer every time, and G3 agrees on the chain", async () => {
    const { g, ctx } = await seeded();
    const box = toolbox();
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
