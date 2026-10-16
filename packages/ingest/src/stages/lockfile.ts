import { type G, LockPath, purl, type RunEvent, type Sha, type Warning } from "@noderunner/core";
import { ingest } from "@noderunner/graph/cypher";
import type { Lock } from "../parse/lock.ts";
import type { Manifest } from "../parse/manifest.ts";

export type Kind = "prod" | "optional" | "peer";

export type InstallRow = {
  readonly lock_path: string;
  readonly name: string;
  readonly version: string;
  readonly purl: string;
  readonly dev: boolean;
  readonly optional: boolean;
};
export type DependsRow = {
  readonly from: string;
  readonly to: string;
  readonly range: string;
  readonly kind: Kind;
};
export type DeclaresRow = { readonly to: string; readonly range: string; readonly dev: boolean };

export type Tree = {
  readonly installs: readonly InstallRow[];
  readonly depends: readonly DependsRow[];
  readonly declares: readonly DeclaresRow[];
  readonly warnings: readonly Warning[];
};

const rank: Readonly<Record<Kind, number>> = { prod: 0, optional: 1, peer: 2 };
const marker = "node_modules/";

/** Node's lookup: the nearest `node_modules/<dep>` walking up from the requiring install's folder. */
export function resolve(from: string, dep: string, have: ReadonlySet<string>): string | null {
  let base = from;
  for (;;) {
    const candidate = `${base ? `${base}/` : ""}${marker}${dep}`;
    if (have.has(candidate)) return candidate;
    if (!base) return null;
    const at = base.lastIndexOf(`/${marker}`);
    base = at === -1 ? "" : base.slice(0, at);
  }
}

function nameOf(lockPath: string, declared: string | undefined): string {
  return declared ?? lockPath.slice(lockPath.lastIndexOf(marker) + marker.length);
}

function grouped(code: Warning["code"], items: readonly string[]): Warning[] {
  return items.length === 0 ? [] : [{ code, count: items.length, sample: items.slice(0, 5) }];
}

/** Builds every install, DEPENDS_ON, and DECLARES row from the two package files; touches no graph. */
export function tree(lock: Lock, manifest: Manifest): Tree {
  const installs: InstallRow[] = [];
  const skipped: string[] = [];
  const entries = Object.entries(lock.packages).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [lockPath, entry] of entries) {
    if (lockPath === "" || entry.link === true) continue;
    if (!lockPath.includes(marker)) continue;
    if (entry.version === undefined || !LockPath.safeParse(lockPath).success) {
      skipped.push(lockPath);
      continue;
    }
    const name = nameOf(lockPath, entry.name);
    installs.push({
      lock_path: lockPath,
      name,
      version: entry.version,
      purl: purl(name, entry.version),
      dev: entry.dev === true || entry.devOptional === true,
      optional: entry.optional === true,
    });
  }
  const have = new Set(installs.map((install) => install.lock_path));

  const unresolved: string[] = [];
  const depends: DependsRow[] = [];
  for (const install of installs) {
    const entry = lock.packages[install.lock_path];
    if (entry === undefined) continue;
    const wanted = new Map<string, { range: string; kind: Kind }>();
    const add = (ranges: Readonly<Record<string, string>> | undefined, kind: Kind) => {
      for (const [dep, range] of Object.entries(ranges ?? {})) {
        const seen = wanted.get(dep);
        if (seen === undefined || rank[kind] < rank[seen.kind]) wanted.set(dep, { range, kind });
      }
    };
    add(entry.dependencies, "prod");
    add(entry.optionalDependencies, "optional");
    add(entry.peerDependencies, "peer");
    for (const [dep, { range, kind }] of [...wanted].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      const to = resolve(install.lock_path, dep, have);
      if (to !== null) depends.push({ from: install.lock_path, to, range, kind });
      else if (kind === "prod") unresolved.push(`${install.lock_path} -> ${dep}`);
    }
  }

  const declares: DeclaresRow[] = [];
  const direct = new Map<string, { range: string; dev: boolean }>();
  for (const [dep, range] of Object.entries(manifest.devDependencies ?? {}))
    direct.set(dep, { range, dev: true });
  for (const [dep, range] of Object.entries(manifest.optionalDependencies ?? {}))
    direct.set(dep, { range, dev: false });
  for (const [dep, range] of Object.entries(manifest.dependencies ?? {}))
    direct.set(dep, { range, dev: false });
  for (const [dep, { range, dev }] of [...direct].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const to = resolve("", dep, have);
    if (to !== null) declares.push({ to, range, dev });
    else if (manifest.optionalDependencies?.[dep] === undefined) unresolved.push(`package.json -> ${dep}`);
  }

  return {
    installs,
    depends,
    declares,
    warnings: [...grouped("skipped", skipped), ...grouped("unresolved", unresolved)],
  };
}

/** Stage 2. Writes the installs, their packages, DEPENDS_ON, and DECLARES, stamped with the commit. */
export async function lockfile(
  input: {
    readonly g: G;
    readonly url: string;
    readonly sha: Sha;
    readonly lock: Lock;
    readonly manifest: Manifest;
  },
  opts: {
    readonly onProgress: (event: Extract<RunEvent, { type: "ingest.progress" }>) => void;
    readonly signal: AbortSignal;
  },
): Promise<{ readonly installs: number; readonly warnings: readonly Warning[] }> {
  const { g, url, sha } = input;
  const { signal } = opts;
  const built = tree(input.lock, input.manifest);
  const total = built.installs.length + built.depends.length + built.declares.length;
  opts.onProgress({ type: "ingest.progress", stage: "lockfile", done: 0, total });
  await g.batch(ingest.lockfile.installs, built.installs, { sha }, signal);
  opts.onProgress({ type: "ingest.progress", stage: "lockfile", done: built.installs.length, total });
  await g.batch(ingest.lockfile.depends, built.depends, { sha }, signal);
  await g.batch(ingest.lockfile.declares, built.declares, { sha, url }, signal);
  opts.onProgress({ type: "ingest.progress", stage: "lockfile", done: total, total });
  return { installs: built.installs.length, warnings: built.warnings };
}
