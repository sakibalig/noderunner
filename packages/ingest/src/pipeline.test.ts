import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { gzipSync } from "node:zlib";
import {
  type Advisories,
  type Db,
  type Forge,
  type G,
  GraphName,
  graphName,
  OsvRecord,
  type RepoRef,
  RunId,
  Sha,
} from "@noderunner/core";
import { connect } from "@noderunner/graph";
import { query, write } from "@noderunner/graph/cypher";
import { pack } from "tar-stream";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { IngestError } from "./errors.ts";
import { ingest } from "./pipeline.ts";

const root = join(import.meta.dirname, "../../..");
const mini = join(root, "fixtures/mini-repo");
const url = process.env.FALKORDB_URL ?? "redis://localhost:6379";
const never = new AbortController().signal;
const FIRST = Sha.parse("1".repeat(40));
const SECOND = Sha.parse("2".repeat(40));
let db: Db;
const repos: string[] = [];
const verifies: G[] = [];

function token(): string {
  const alphabet = "0123456789abcdefghjkmnpqrstvwxyz";
  return [...randomBytes(12)].map((byte) => alphabet[byte % 32]).join("");
}

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

async function tarball(contents: ReadonlyMap<string, string>): Promise<Buffer> {
  const archive = pack();
  for (const [path, text] of contents) archive.entry({ name: `acme-mini-0123abc/${path}` }, text);
  archive.finalize();
  const chunks: Uint8Array[] = [];
  for await (const chunk of archive) if (chunk instanceof Uint8Array) chunks.push(chunk);
  return gzipSync(Buffer.concat(chunks));
}

/** GitHub as recorded: the given commit's tarball, and no history. */
function forge(head: Sha, archive: Buffer): Pick<Forge, "head" | "tarball" | "history"> {
  return {
    async head() {
      return { branch: "main", sha: head };
    },
    async *tarball() {
      yield archive;
    },
    async history() {
      return [];
    },
  };
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
const osv: Advisories = {
  async query(pairs) {
    return pairs.map((p) => (answers[`${p.name}@${p.version}`] ?? []).map((id) => ({ id, modified: 1 })));
  },
  async record(id) {
    return records.get(id) ?? null;
  },
};

function repo(): RepoRef {
  const r = { owner: "acme", name: `mini-${token()}` };
  repos.push(graphName(r));
  return r;
}

const deps = (head: Sha, archive: Buffer, advisories: Advisories = osv) => ({
  db,
  forge: forge(head, archive),
  advisories,
  clock: { now: () => 5_000 },
});
const opts = { target: { kind: "repo" as const }, onProgress: () => {}, signal: never };

const stamped = query(
  "test.stamped",
  "MATCH (r:Repo) RETURN r.snapshot_sha AS sha, r.ingested_at AS at LIMIT 1",
  z.object({ sha: z.string().nullable(), at: z.number().nullable() }),
);
const statuses = query(
  "test.statuses",
  "MATCH (x:Finding) OPTIONAL MATCH (x)-[a:AT]->() RETURN x.key AS key, x.status AS status, count(a) AS at ORDER BY key LIMIT 20",
  z.object({ key: z.string(), status: z.string(), at: z.number() }),
);
const qsInstall = query(
  "test.qsInstall",
  "MATCH (i:Install {lock_path: 'node_modules/qs'}) RETURN i.version AS version, i.snapshot_sha AS sha",
  z.object({ version: z.string(), sha: z.string() }),
);
const memoryNodes = write(
  "test.memory",
  `MATCH (x:Finding {key: "GHSA-hrpp-h998-j3pp|qs"})
CREATE (:Decision {id: "D1", kind: "waive", reason: "r", created_at: 1})-[:ABOUT]->(x)
CREATE (:Run {id: "R1"})-[:HAS_STEP]->(:Step {id: "S1"})`,
);
const memoryCount = query(
  "test.memoryCount",
  "MATCH (n) WHERE n:Decision OR n:Run OR n:Step RETURN count(n) AS n",
  z.object({ n: z.number() }),
);

beforeAll(async () => {
  db = await connect({ url, signal: never, onError: () => {} });
});

afterEach(async () => {
  for (const g of verifies.splice(0)) await g.drop();
  const { FalkorDB } = await import("falkordb");
  const raw = await FalkorDB.connect({ url });
  for (const name of repos.splice(0))
    await raw
      .selectGraph(name)
      .delete()
      .catch(() => undefined);
  await raw.close();
});

afterAll(async () => {
  await db.close();
});

describe("ingest", () => {
  it("runs every stage on the mini-repo, stamps the commit, and reports what it wrote", async () => {
    const r = repo();
    const events: string[] = [];
    const report = await ingest(r, deps(FIRST, await tarball(files())), {
      ...opts,
      onProgress: (e) => events.push(e.stage),
    });
    expect(report).toMatchObject({
      graph: graphName(r),
      sha: FIRST,
      counts: { files: 6, installs: 12, vulns: 4, findings: 4, people: 0 },
    });
    expect(Object.keys(report.ms)).toEqual(["fetch", "lockfile", "imports", "advisories", "people", "prune"]);
    expect([...new Set(events)]).toEqual(["fetch", "lockfile", "imports", "advisories", "people", "prune"]);
    expect(await db.graph(graphName(r)).query(stamped, {}, never)).toEqual([{ sha: FIRST, at: 5_000 }]);
  });

  it("re-ingests a newer commit: the old qs is pruned, its finding fixed, and memory kept", async () => {
    const r = repo();
    await ingest(r, deps(FIRST, await tarball(files())), opts);
    const g = db.graph(graphName(r));
    await g.query(memoryNodes, {}, never);

    const next = files();
    next.set(
      "package-lock.json",
      (next.get("package-lock.json") ?? "").replace('"version": "6.7.0"', '"version": "6.7.3"'),
    );
    await ingest(r, deps(SECOND, await tarball(next)), opts);

    expect(await g.query(qsInstall, {}, never)).toEqual([{ version: "6.7.3", sha: SECOND }]);
    expect((await g.query(statuses, {}, never)).map((s) => `${s.key} ${s.status} ${s.at}`)).toEqual([
      "GHSA-35jh-r3h4-6jhm|lodash open 1",
      "GHSA-hrpp-h998-j3pp|qs fixed 0",
      "GHSA-rv95-896h-c2vc|express open 1",
      "GHSA-vh95-rmgr-6w4m|minimist open 1",
    ]);
    expect(await g.query(memoryCount, {}, never)).toEqual([{ n: 3 }]);
    expect((await g.query(stamped, {}, never))[0]?.sha).toBe(SECOND);
  });

  it("ingests a verification target into its own graph without people", async () => {
    const r = repo();
    const runId = RunId.parse("01JQZ8ABCDEFGHJKMNPQRSTVWX");
    const all = files();
    const report = await ingest({ ...r, sha: FIRST }, deps(FIRST, await tarball(all)), {
      ...opts,
      target: {
        kind: "verify",
        runId,
        override: { manifest: all.get("package.json") ?? "", lock: all.get("package-lock.json") ?? "" },
      },
    });
    verifies.push(db.graph(GraphName.parse(report.graph)));
    expect(report.graph).toBe("verify:01jqz8abcdefghjkmnpqrstvwx");
    expect(report.counts.people).toBe(0);
    expect((await db.list()).includes(graphName(r))).toBe(false);
  });

  it("keeps the previous stamp when a stage fails", async () => {
    const r = repo();
    await ingest(r, deps(FIRST, await tarball(files())), opts);
    const failing: Advisories = {
      async query() {
        throw new IngestError("ingest.upstream", "OSV could not be reached");
      },
      async record() {
        return null;
      },
    };
    await expect(ingest(r, deps(SECOND, await tarball(files()), failing), opts)).rejects.toMatchObject({
      code: "ingest.upstream",
    });
    expect((await db.graph(graphName(r)).query(stamped, {}, never))[0]?.sha).toBe(FIRST);
  });
});
