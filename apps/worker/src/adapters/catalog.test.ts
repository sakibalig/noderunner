import { randomBytes } from "node:crypto";
import { type Db, graphName, type RepoRef } from "@noderunner/core";
import { connect, migrate } from "@noderunner/graph";
import { write } from "@noderunner/graph/cypher";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { GraphCatalog } from "./catalog.ts";

const url = process.env.FALKORDB_URL ?? "redis://localhost:6379";
const never = new AbortController().signal;
let db: Db;
const made: string[] = [];

const seed = write(
  "test.seed",
  `CREATE (r:Repo {url: $url, owner: $owner, name: $name, snapshot_sha: $sha, ingested_at: 7})
CREATE (r)-[:CONTAINS]->(:File {path: "src/a.ts", kind: "prod"})
CREATE (i:Install {lock_path: "node_modules/qs", name: "qs", version: "6.7.0"})
CREATE (v1:Vuln {id: "V-HIGH", severity: "high", severity_rank: 3})-[:AFFECTS]->(i)
CREATE (v2:Vuln {id: "V-LOW", severity: "low", severity_rank: 1})-[:AFFECTS]->(i)
CREATE (v3:Vuln {id: "V-MOD", severity: "moderate", severity_rank: 2})
CREATE (a:Finding {key: "V-HIGH|qs", vuln_id: "V-HIGH", package: "qs", severity: "high", tier: "import-reachable", status: "open"})-[:ABOUT]->(v1)
CREATE (b:Finding {key: "V-LOW|qs", vuln_id: "V-LOW", package: "qs", severity: "low", tier: "installed", status: "planned"})-[:ABOUT]->(v2)
CREATE (c:Finding {key: "V-MOD|qs", vuln_id: "V-MOD", package: "qs", severity: "moderate", tier: "import-reachable", status: "waived"})-[:ABOUT]->(v3)
CREATE (d:Finding {key: "V-OLD|qs", vuln_id: "V-MOD", package: "qs", severity: "moderate", tier: "dev-only", status: "fixed"})-[:ABOUT]->(v3)
CREATE (a)-[:AT]->(i), (b)-[:AT]->(i)
CREATE (:Run {id: "01JQZ8ABCDEFGHJKMNPQRSTVWX", agent: "triage", status: "done", started_at: 5})
CREATE (:Run {id: "01JQZ8ABCDEFGHJKMNPQRSTVWY", agent: "ui", status: "done", started_at: 9})`,
);

async function seeded(): Promise<RepoRef> {
  const alphabet = "0123456789abcdefghjkmnpqrstvwxyz";
  const repo = { owner: "Acme", name: `api-${[...randomBytes(10)].map((b) => alphabet[b % 32]).join("")}` };
  const name = graphName(repo);
  made.push(name);
  const g = db.graph(name);
  await migrate(g, "repo", never);
  await g.query(
    seed,
    { url: `https://github.com/acme/${repo.name}`, owner: repo.owner, name: repo.name, sha: "a".repeat(40) },
    never,
  );
  return repo;
}

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

describe("GraphCatalog", () => {
  it("summarises the funnel from the graph: open, production, reachable, still open", async () => {
    const repo = await seeded();
    const summary = await new GraphCatalog(db).summary(repo, never);
    expect(summary).toEqual({
      funnel: { total: 3, production: 3, reachable: 2, open: 1 },
      counts: { files: 1, installs: 1, vulns: 2, findings: 3, people: 0 },
      lastRun: { runId: "01JQZ8ABCDEFGHJKMNPQRSTVWX", agent: "triage", status: "done", startedAt: 5 },
    });
  });

  it("lists findings most severe first, filtered by tier and status", async () => {
    const repo = await seeded();
    const catalog = new GraphCatalog(db);
    expect((await catalog.findings(repo, {}, never))?.map((f) => f.key)).toEqual([
      "V-HIGH|qs",
      "V-MOD|qs",
      "V-OLD|qs",
      "V-LOW|qs",
    ]);
    expect(
      (await catalog.findings(repo, { tier: "import-reachable", status: "open" }, never))?.map((f) => f.key),
    ).toEqual(["V-HIGH|qs"]);
    expect((await catalog.findings(repo, { status: "planned" }, never))?.[0]?.installs).toEqual([
      "node_modules/qs",
    ]);
  });

  it("lists the ingested repository with its commit and counts", async () => {
    const repo = await seeded();
    const listed = (await new GraphCatalog(db).list(never)).find(
      (r) => r.repoId === `${repo.owner}/${repo.name}`,
    );
    expect(listed).toMatchObject({ sha: "a".repeat(40), ingestedAt: 7, counts: { findings: 3 } });
  });

  it("answers null for a repository never ingested, and does not create its graph", async () => {
    const repo = { owner: "acme", name: "never-ingested" };
    const catalog = new GraphCatalog(db);
    expect(await catalog.summary(repo, never)).toBeNull();
    expect(await catalog.findings(repo, {}, never)).toBeNull();
    expect((await db.list()).includes(graphName(repo))).toBe(false);
  });
});
