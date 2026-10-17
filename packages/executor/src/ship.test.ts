import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { gzipSync } from "node:zlib";
import {
  type Advisories,
  type Change,
  type Db,
  graphName,
  OsvRecord,
  PlanId,
  type RepoRef,
  RunId,
  type Sandbox,
  Sha,
  verifyName,
} from "@noderunner/core";
import { connect } from "@noderunner/graph";
import { query, write } from "@noderunner/graph/cypher";
import { ingest } from "@noderunner/ingest";
import { pack } from "tar-stream";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { draft } from "./draft.ts";
import { type Reingest, shipper } from "./ship.ts";

// Integration: a real FalkorDB and the real ingest; GitHub, OSV, and npm are recorded fakes.
const root = join(import.meta.dirname, "../../..");
const mini = join(root, "fixtures/mini-repo");
const url = process.env.FALKORDB_URL ?? "redis://localhost:6379";
const never = new AbortController().signal;
const SHA = Sha.parse("1".repeat(40));
const QS = "GHSA-hrpp-h998-j3pp|qs";
const EXPRESS = "GHSA-rv95-896h-c2vc|express";
const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const token = (n: number) => [...randomBytes(n)].map((b) => alphabet[b % 32]).join("");
let db: Db;
const made: string[] = [];

function files(): Map<string, string> {
  const out = new Map<string, string>();
  const visit = (at: string) => {
    for (const name of readdirSync(at)) {
      const path = join(at, name);
      if (statSync(path).isDirectory()) visit(path);
      else if (name !== "osv.json") out.set(relative(mini, path), readFileSync(path, "utf8"));
    }
  };
  visit(mini);
  return out;
}

async function tarball(): Promise<Buffer> {
  const archive = pack();
  for (const [path, text] of files()) archive.entry({ name: `acme-mini-0123abc/${path}` }, text);
  archive.finalize();
  const chunks: Uint8Array[] = [];
  for await (const chunk of archive) if (chunk instanceof Uint8Array) chunks.push(chunk);
  return gzipSync(Buffer.concat(chunks));
}

const answers = z
  .record(z.string(), z.array(z.string()))
  .parse(JSON.parse(readFileSync(join(mini, "osv.json"), "utf8")));
const records = new Map(
  [
    "fixtures/osv/GHSA-rv95-896h-c2vc.json",
    "fixtures/osv/GHSA-vh95-rmgr-6w4m.json",
    "packages/core/src/fixtures/osv/GHSA-35jh-r3h4-6jhm.json",
    "packages/core/src/fixtures/osv/GHSA-hrpp-h998-j3pp.json",
  ].map((path) => {
    const record = OsvRecord.parse(JSON.parse(readFileSync(join(root, path), "utf8")));
    return [record.id, record] as const;
  }),
);
const lodash = records.get("GHSA-35jh-r3h4-6jhm");
const padded = OsvRecord.parse({
  ...lodash,
  id: "GHSA-test-left-padx",
  affected: [
    {
      package: { name: "left-pad", ecosystem: "npm" },
      ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, { fixed: "9.9.9" }] }],
    },
  ],
});

function advisories(extra: Record<string, string[]> = {}): Advisories {
  const all = { ...answers, ...extra };
  return {
    async query(pairs) {
      return pairs.map((p) => (all[`${p.name}@${p.version}`] ?? []).map((id) => ({ id, modified: 1 })));
    },
    async record(id) {
      return id === padded.id ? padded : (records.get(id) ?? null);
    },
  };
}

const plan = write(
  "test.shipPlan",
  `MATCH (q:Finding {key: $qs}), (e:Finding {key: $express})
CREATE (run:Run {id: $runId, agent: "triage", status: "done"})
CREATE (run)-[:PROPOSED]->(p:Plan {id: $planId, created_at: 1, total_cost: 1, uncovered: [], approved: $approved})
CREATE (p)-[:INCLUDES]->(u:Upgrade {id: "u1", kind: $kind, package: "express", from: "4.17.1", to: "4.22.3",
                                    semver_jump: "minor", cost: 1})
CREATE (u)-[:CLOSES]->(q)
CREATE (u)-[:CLOSES]->(e)`,
);
const pulls = query(
  "test.pulls",
  "MATCH (:Plan)-[:SHIPPED_AS]->(pr:PullRequest) RETURN pr.url AS url, pr.closed AS closed, pr.branch AS branch",
  z.object({ url: z.string(), closed: z.number(), branch: z.string() }),
);

/** The recorded lockfile with the given install versions changed, as npm would have written it. */
function regenerated(versions: Record<string, string>): string {
  const lock = JSON.parse(readFileSync(join(mini, "package-lock.json"), "utf8"));
  for (const [path, version] of Object.entries(versions)) lock.packages[path].version = version;
  return JSON.stringify(lock, null, 2);
}
const fixed = regenerated({ "node_modules/express": "4.22.3", "node_modules/qs": "6.7.3" });

beforeAll(async () => {
  db = await connect({ url, signal: never, onError: () => {} });
});
afterEach(async () => {
  const { FalkorDB } = await import("falkordb");
  const raw = await FalkorDB.connect({ url });
  for (const name of made.splice(0))
    await raw
      .selectGraph(name)
      .delete()
      .catch(() => undefined);
  await raw.close();
});
afterAll(async () => {
  await db.close();
});

async function fixture(
  options: {
    approved?: boolean;
    sandbox?: Sandbox;
    extra?: Record<string, string[]>;
    kind?: "refresh" | "bump";
    after?: () => Promise<void>;
  } = {},
) {
  const repo: RepoRef = { owner: "acme", name: `mini-${token(8).toLowerCase()}` };
  const graph = graphName(repo);
  made.push(graph);
  const archive = await tarball();
  const forge = {
    head: async () => ({ branch: "main", sha: SHA }),
    async *tarball() {
      yield archive;
    },
    history: async () => [],
  };
  const clock = { now: () => 5_000 };
  await ingest(
    { ...repo, sha: SHA },
    { db, forge, advisories: advisories(), clock },
    {
      target: { kind: "repo" },
      onProgress: () => {},
      signal: never,
    },
  );
  const runId = RunId.parse(`01JQZ8${token(20)}`);
  const planId = PlanId.parse(`01JQZ8${token(20)}`);
  await db.graph(graph).query(
    plan,
    {
      qs: QS,
      express: EXPRESS,
      runId,
      planId,
      approved: options.approved ?? true,
      kind: options.kind ?? "refresh",
    },
    never,
  );
  const proposed: { repo: RepoRef; change: Change }[] = [];
  const reingest: Reingest = async (r, override, id, signal) => {
    await ingest(
      r,
      { db, forge, advisories: advisories(options.extra), clock },
      {
        target: { kind: "verify", runId: id, override },
        onProgress: () => {},
        signal,
      },
    );
    await options.after?.();
  };
  const ship = shipper({
    db,
    clock,
    reingest,
    target: "sakibalig",
    sandbox: options.sandbox ?? { regenerate: async () => ({ lock: fixed }) },
    forge: {
      read: async (_r, _sha, path) => readFileSync(join(mini, path), "utf8"),
      propose: async (r, change) => {
        proposed.push({ repo: r, change });
        return { url: `https://github.com/${r.owner}/${r.name}/pull/7`, number: 7 };
      },
    },
  });
  const req = { graph, runId: RunId.parse(`01JQZ8${token(20)}`), planId };
  return { repo, graph, ship, req, proposed };
}

const opts = { signal: never, onProgress: () => {} };
const dropped = async (runId: RunId) => !(await db.list()).includes(verifyName(runId));

describe("ship", () => {
  it("verifies the regenerated lockfile, opens the pull request on the fork, and records it", async () => {
    const { repo, graph, ship, req, proposed } = await fixture();
    const shipment = await ship(req, opts);
    expect(shipment).toEqual({
      outcome: "opened",
      url: `https://github.com/sakibalig/${repo.name}/pull/7`,
      branch: `noderunner/plan-${req.planId.slice(-8).toLowerCase()}`,
      verification: { targeted: 2, closed: 2, stillOpen: [], newFindings: [] },
    });
    const [sent] = proposed;
    expect(sent?.repo).toEqual({ owner: "sakibalig", name: repo.name });
    expect(sent?.change.base).toBe(SHA);
    expect(sent?.change.files.map((f) => f.path)).toEqual(["package.json", "package-lock.json"]);
    expect(sent?.change.files[1]?.content).toBe(fixed);
    expect(sent?.change.body).toContain("**2 of 2** targeted alerts closed");
    expect(await db.graph(graph).query(pulls, {}, never)).toEqual([
      { url: shipment.outcome === "opened" ? shipment.url : "", closed: 2, branch: sent?.change.branch },
    ]);
    expect((await draft(db.graph(graph), "acme/x", req.planId, never))?.shipped).toBe(
      `https://github.com/sakibalig/${repo.name}/pull/7`,
    );
    expect(await dropped(req.runId)).toBe(true);
    await expect(ship(req, opts)).rejects.toMatchObject({ surface: "shipped" });
  });

  it("refuses an unapproved plan before reading anything", async () => {
    const { ship, req, proposed } = await fixture({ approved: false });
    await expect(ship(req, opts)).rejects.toMatchObject({ surface: "unapproved" });
    expect(proposed).toEqual([]);
  });

  it("refuses to open a pull request that makes a new alert reachable, and pushes nothing", async () => {
    const { graph, ship, req, proposed } = await fixture({ extra: { "left-pad@1.3.0": [padded.id] } });
    const shipment = await ship(req, opts);
    expect(shipment).toEqual({
      outcome: "refused",
      reason: "new reachable finding",
      verification: { targeted: 2, closed: 2, stillOpen: [], newFindings: ["GHSA-test-left-padx|left-pad"] },
    });
    expect(proposed).toEqual([]);
    expect(await db.graph(graph).query(pulls, {}, never)).toEqual([]);
    expect(await dropped(req.runId)).toBe(true);
  });

  it("reports a target the new lockfile leaves open", async () => {
    const lock = regenerated({ "node_modules/express": "4.22.3" });
    const { ship, req, proposed } = await fixture({ sandbox: { regenerate: async () => ({ lock }) } });
    const shipment = await ship(req, opts);
    expect(shipment.verification).toEqual({ targeted: 2, closed: 1, stillOpen: [QS], newFindings: [] });
    expect(proposed[0]?.change.body).toContain("Still open:");
  });

  it("fails with upstream when npm writes something that is not a lockfile", async () => {
    const { ship, req, proposed } = await fixture({
      sandbox: { regenerate: async () => ({ lock: "{ not json" }) },
    });
    await expect(ship(req, opts)).rejects.toMatchObject({ code: "executor.sandbox", surface: "upstream" });
    expect(proposed).toEqual([]);
  });

  it("drops the verification graph when verification fails after the re-ingest wrote it", async () => {
    const { ship, req, proposed } = await fixture({
      after: async () => {
        expect(await dropped(req.runId)).toBe(false);
        throw new Error("the graph went away");
      },
    });
    await expect(ship(req, opts)).rejects.toThrow("the graph went away");
    expect(await dropped(req.runId)).toBe(true);
    expect(proposed).toEqual([]);
  });

  it("bumps a direct dependency, changing only its value in package.json", async () => {
    const { ship, req, proposed } = await fixture({ kind: "bump" });
    await ship(req, opts);
    const original = readFileSync(join(mini, "package.json"), "utf8");
    expect(proposed[0]?.change.files[0]?.content).toBe(original.replace('"^4.17.1"', '"^4.22.3"'));
  });

  it("lets only one of two concurrent ships of a plan through", async () => {
    const { ship, req } = await fixture();
    const results = await Promise.allSettled([ship(req, opts), ship(req, opts)]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    const failed = results.find((r) => r.status === "rejected");
    expect(failed?.status === "rejected" && failed.reason).toMatchObject({ surface: "busy" });
  });
});
