import { randomBytes } from "node:crypto";
import { type Db, findingKey, graphName } from "@noderunner/core";
import { connect } from "@noderunner/graph";
import { write } from "@noderunner/graph/cypher";
import { createToolbox, createTools } from "@noderunner/tools";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { GraphFindings } from "./findings.ts";

// Integration: a real FalkorDB from `docker compose up falkordb`.
const url = process.env.FALKORDB_URL ?? "redis://localhost:6379";
const never = new AbortController().signal;
const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const token = (n: number) => [...randomBytes(n)].map((b) => alphabet[b % 32]).join("");
let db: Db;
const made: string[] = [];
const qs = findingKey("GHSA-1", "qs");
const unknown = findingKey("GHSA-9", "qs");

const seed = write(
  "test.findingSeed",
  `CREATE (f:File {path: "src/server.ts", kind: "prod"})
CREATE (e:Install {lock_path: "node_modules/express", name: "express", version: "4.17.1"})
CREATE (q:Install {lock_path: "node_modules/qs", name: "qs", version: "6.7.0"})
CREATE (f)-[:LOADS]->(e)-[:DEPENDS_ON]->(q)
CREATE (v:Vuln {id: "GHSA-1", aliases: ["CVE-1"], severity: "high", summary: "<script>x</script>", modified: 5})
CREATE (v)-[:AFFECTS]->(q)
CREATE (x:Finding {key: "GHSA-1|qs", vuln_id: "GHSA-1", package: "qs", severity: "high",
                   tier: "import-reachable", status: "open"})
CREATE (x)-[:ABOUT]->(v)
CREATE (x)-[:AT]->(q)
CREATE (d:Install {lock_path: "node_modules/left-pad", name: "left-pad", version: "1.0.0"})
CREATE (w:Vuln {id: "GHSA-2", severity: "low"})-[:AFFECTS]->(d)
CREATE (y:Finding {key: "GHSA-2|left-pad", vuln_id: "GHSA-2", package: "left-pad", severity: "low",
                   tier: "dev-only", status: "open"})
CREATE (y)-[:ABOUT]->(w)
CREATE (y)-[:AT]->(d)`,
);

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

async function fixture() {
  const repo = { owner: "acme", name: `api-${token(8).toLowerCase()}` };
  made.push(graphName(repo));
  await db.graph(graphName(repo)).query(seed, {}, never);
  let next = 0;
  const clock = { now: () => 1_000 };
  const ids = { next: () => `01JQZ8${String(next++).padStart(20, "0")}` };
  const registry = { versions: async () => [], manifest: async () => null } as never;
  const tools = createTools({ db, clock, ids, registry });
  const toolbox = createToolbox({ db, clock, ids, tools }, { access: ["read", "derive", "act"] });
  return { repo, findings: new GraphFindings({ db, clock, ids, toolbox }) };
}

describe("GraphFindings", () => {
  it("details a reachable finding with its production path as evidence", async () => {
    const { repo, findings } = await fixture();
    const detail = await findings.detail(repo, "GHSA-1|qs", never);
    expect(detail?.finding).toMatchObject({ key: "GHSA-1|qs", tier: "import-reachable", status: "open" });
    expect(detail?.finding.installs).toEqual(["node_modules/qs"]);
    expect(detail?.vuln).toEqual({
      id: "GHSA-1",
      aliases: ["CVE-1"],
      severity: "high",
      summary: "<script>x</script>",
      modified: 5,
    });
    expect(detail?.path?.nodes.map((n) => n.key)).toEqual([
      "src/server.ts",
      "node_modules/express",
      "node_modules/qs",
      "GHSA-1",
    ]);
    expect(detail?.path?.edges.map((e) => e.key)).toEqual([
      "src/server.ts|LOADS|node_modules/express",
      "node_modules/express|DEPENDS_ON|node_modules/qs",
      "GHSA-1|AFFECTS|node_modules/qs",
    ]);
    expect(detail?.decisions).toEqual([]);
  });

  it("has no path for a dev-only finding, and null for an unknown key or repository", async () => {
    const { repo, findings } = await fixture();
    expect((await findings.detail(repo, "GHSA-2|left-pad", never))?.path).toBeNull();
    expect(await findings.detail(repo, "GHSA-9|qs", never)).toBeNull();
    expect(await findings.detail({ owner: "acme", name: "nope" }, "GHSA-1|qs", never)).toBeNull();
  });

  it("waives through record_decision in a ui run, then shows it in the history", async () => {
    const { repo, findings } = await fixture();
    const made = await findings.decide(
      repo,
      {
        repoId: `acme/${repo.name}`,
        key: qs,
        kind: "waive",
        reason: "behind auth",
        by: "alice",
        expiresInDays: 30,
      },
      never,
    );
    expect(made?.decisionId).toMatch(/^01JQZ8/);
    const detail = await findings.detail(repo, "GHSA-1|qs", never);
    expect(detail?.finding.status).toBe("waived");
    expect(detail?.decisions).toEqual([
      {
        id: made?.decisionId,
        key: "GHSA-1|qs",
        kind: "waive",
        reason: "behind auth",
        by: "@alice",
        createdAt: 1_000,
        expiresAt: 1_000 + 30 * 86_400_000,
        tierAtDecision: "import-reachable",
        staleReason: null,
      },
    ]);
  });

  it("returns null for an unknown finding and surfaces a tool refusal as invalid", async () => {
    const { repo, findings } = await fixture();
    const base = { repoId: `acme/${repo.name}`, kind: "waive" as const, by: "alice" };
    expect(await findings.decide(repo, { ...base, key: unknown, reason: "x" }, never)).toBeNull();
    await expect(
      findings.decide(repo, { ...base, key: qs, reason: "x".repeat(501) }, never),
    ).rejects.toMatchObject({ surface: "invalid" });
  });
});
