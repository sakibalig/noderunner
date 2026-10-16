import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import {
  type Advisories,
  type Clock,
  type Db,
  type G,
  GraphName,
  type Ids,
  OsvRecord,
  type Packument,
  type Registry,
  RunId,
  Sha,
  type ToolCtx,
} from "@noderunner/core";
import { migrate } from "@noderunner/graph";
import { ingest, memory } from "@noderunner/graph/cypher";
import { advisories, imports, lock, lockfile, Manifest, tree } from "@noderunner/ingest";
import { z } from "zod";
import { createToolbox, type StepHooks, type Toolbox } from "./call.ts";
import { createTools } from "./registry.ts";

// Test support only: builds fixtures/mini-repo into a fresh graph. Not exported from the package.

const root = join(import.meta.dirname, "../../..");
const mini = join(root, "fixtures/mini-repo");
export const miniUrl = "https://github.com/acme/mini-repo";
const sha = Sha.parse("1".repeat(40));
const never = new AbortController().signal;

export const silent: StepHooks = { onStart: () => {}, onFinish: () => {} };

export function ulid(): string {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  return [...randomBytes(26)]
    .map((byte) => alphabet[byte % 32])
    .join("")
    .replace(/^./, "0");
}

/** A clock the test moves by hand. */
export function manual(start = 1_000_000): Clock & { set(now: number): void } {
  let now = start;
  return {
    now: () => now,
    set: (next) => {
      now = next;
    },
  };
}

export const ids: Ids = { next: ulid };

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

function records(): Map<string, OsvRecord> {
  return new Map(
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
}

/** OSV answering from fixtures/mini-repo/osv.json and the recorded advisories. */
export function recorded(): Advisories {
  const answers = z
    .record(z.string(), z.array(z.string()))
    .parse(JSON.parse(readFileSync(join(mini, "osv.json"), "utf8")));
  const byId = records();
  return {
    async query(pairs) {
      return pairs.map((p) => (answers[`${p.name}@${p.version}`] ?? []).map((id) => ({ id, modified: 1 })));
    },
    async record(id) {
      return byId.get(id) ?? null;
    },
  };
}

/** The npm registry answering from fixtures/npm; a name with no file is null, as a 404 would be. */
export function packuments(): Registry {
  return {
    async packument(name) {
      let raw: string;
      try {
        raw = readFileSync(join(root, "fixtures/npm", `${encodeURIComponent(name)}.json`), "utf8");
      } catch {
        return null;
      }
      const parsed = z
        .object({
          name: z.string(),
          versions: z.record(
            z.string(),
            z.object({
              dependencies: z.record(z.string(), z.string()).optional(),
              optionalDependencies: z.record(z.string(), z.string()).optional(),
              peerDependencies: z.record(z.string(), z.string()).optional(),
            }),
          ),
        })
        .parse(JSON.parse(raw));
      const versions: Packument["versions"] = Object.fromEntries(
        Object.entries(parsed.versions).map(([v, i]) => [
          v,
          { deps: { ...i.peerDependencies, ...i.optionalDependencies, ...i.dependencies } },
        ]),
      );
      return { name: parsed.name, versions };
    },
  };
}

/** A fresh verify graph holding the mini-repo after stages 2 to 4, and a triage run to hang steps on. */
export async function seeded(db: Db, made: G[]): Promise<{ g: G; ctx: ToolCtx }> {
  const g = db.graph(GraphName.parse(`verify:${ulid().toLowerCase()}`));
  made.push(g);
  await migrate(g, "repo", never);
  await g.query(
    ingest.repo.upsert,
    { url: miniUrl, owner: "acme", name: "mini-repo", branch: "main" },
    never,
  );
  const manifest = Manifest.parse(JSON.parse(readFileSync(join(mini, "package.json"), "utf8")));
  const lockFile = lock(readFileSync(join(mini, "package-lock.json"), "utf8"));
  const opts = { onProgress: () => {}, signal: never };
  const stage2 = await lockfile({ g, url: miniUrl, sha, lock: lockFile, manifest }, opts);
  await imports({ g, url: miniUrl, sha, files: sources(mini), manifest, installs: stage2.paths }, opts);
  await advisories({ g, sha, installs: tree(lockFile, manifest).installs }, { advisories: recorded() }, opts);
  const runId = RunId.parse(ulid());
  await g.query(memory.run.start, { id: runId, agent: "triage", model: null, now: 0 }, never);
  return { g, ctx: { graph: g.name, runId, actor: "triage", signal: never } };
}

/** The full toolbox over the real tools, with the given clock. */
export function toolbox(db: Db, clock: Clock = manual()): Toolbox {
  return createToolbox(
    { db, clock, ids, tools: createTools({ db, clock, ids, registry: packuments() }) },
    { access: ["read", "derive", "act"] },
  );
}
