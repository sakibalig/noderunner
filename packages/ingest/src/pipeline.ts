import {
  type Advisories,
  type Clock,
  type Db,
  type Forge,
  graphName,
  type IngestReport,
  type RepoRef,
  type RunEvent,
  type Stage,
  verifyName,
  type Warning,
} from "@noderunner/core";
import { migrate } from "@noderunner/graph";
import { IngestError } from "./errors.ts";
import { advisories } from "./stages/advisories.ts";
import { snapshot, type Target } from "./stages/fetch.ts";
import { imports } from "./stages/imports.ts";
import { lockfile, tree } from "./stages/lockfile.ts";
import { people } from "./stages/people.ts";
import { prune } from "./stages/prune.ts";

export type Deps = {
  readonly db: Db;
  readonly forge: Pick<Forge, "head" | "tarball" | "history">;
  readonly advisories: Advisories;
  readonly clock: Clock;
};

export type Opts = {
  readonly target: Target;
  readonly onProgress: (event: Extract<RunEvent, { type: "ingest.progress" }>) => void;
  readonly signal: AbortSignal;
};

/** One warning per code across stages: counts added, samples kept in stage order up to five. */
function merged(lists: readonly (readonly Warning[])[]): Warning[] {
  const byCode = new Map<Warning["code"], Warning>();
  for (const warning of lists.flat()) {
    const seen = byCode.get(warning.code);
    byCode.set(
      warning.code,
      seen === undefined
        ? warning
        : {
            code: warning.code,
            count: seen.count + warning.count,
            sample: [...seen.sample, ...warning.sample].slice(0, 5),
          },
    );
  }
  return [...byCode.values()];
}

/**
 * Ingests one repository at one commit into its graph: stages 1 to 6 for a repository, and for a verification
 * graph the same without people, from the override's package files. Re-running at the same commit repairs a
 * partial ingest, because every write merges.
 */
export async function ingest(repo: RepoRef, deps: Deps, opts: Opts): Promise<IngestReport> {
  const { signal, onProgress } = opts;
  const graph = opts.target.kind === "repo" ? graphName(repo) : verifyName(opts.target.runId);
  const g = deps.db.graph(graph);
  const ms: Record<Stage, number> = { fetch: 0, lockfile: 0, imports: 0, advisories: 0, people: 0, prune: 0 };
  const timed = async <T>(stage: Stage, work: () => Promise<T>): Promise<T> => {
    if (signal.aborted) throw new IngestError("ingest.aborted", "ingestion was stopped");
    const started = deps.clock.now();
    const result = await work();
    ms[stage] = deps.clock.now() - started;
    return result;
  };
  const stage = { onProgress, signal };

  await migrate(g, "repo", signal);
  const snap = await timed("fetch", () =>
    snapshot({ g, repo, target: opts.target }, { forge: deps.forge }, stage),
  );
  const base = { g, url: snap.url, sha: snap.sha };
  const installed = await timed("lockfile", () =>
    lockfile({ ...base, lock: snap.lock, manifest: snap.manifest }, stage),
  );
  const linked = await timed("imports", () =>
    imports({ ...base, files: snap.files, manifest: snap.manifest, installs: installed.paths }, stage),
  );
  const found = await timed("advisories", () =>
    advisories(
      { g, sha: snap.sha, installs: tree(snap.lock, snap.manifest).installs },
      { advisories: deps.advisories },
      stage,
    ),
  );
  const owners =
    opts.target.kind === "repo"
      ? await timed("people", async () => {
          onProgress({ type: "ingest.progress", stage: "people", done: 0, total: 1 });
          const result = await people(
            {
              g,
              repo: { ...repo, sha: snap.sha },
              sha: snap.sha,
              files: [...snap.files.keys()],
              codeowners: snap.codeowners,
            },
            { forge: deps.forge },
            signal,
          );
          onProgress({ type: "ingest.progress", stage: "people", done: 1, total: 1 });
          return result;
        })
      : { people: 0, warnings: [] };
  await timed("prune", () => prune({ ...base, now: deps.clock.now() }, stage));

  return {
    graph,
    sha: snap.sha,
    counts: {
      files: linked.files,
      installs: installed.installs,
      vulns: found.vulns,
      findings: found.findings,
      people: owners.people,
    },
    warnings: merged([snap.warnings, installed.warnings, linked.warnings, found.warnings, owners.warnings]),
    ms,
  };
}
