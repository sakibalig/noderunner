import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import type { Forge, G, RepoRef, RunEvent, RunId, Sha, Warning } from "@noderunner/core";
import { ingest } from "@noderunner/graph/cypher";
import { extract } from "tar-stream";
import { IngestError } from "../errors.ts";
import { type Lock, lock } from "../parse/lock.ts";
import { type Manifest, manifest } from "../parse/manifest.ts";

/** Where an ingest writes: the repository graph, or a fresh verification graph with edited package files. */
export type Target =
  | { readonly kind: "repo" }
  | {
      readonly kind: "verify";
      readonly runId: RunId;
      readonly override: { readonly manifest: string; readonly lock: string };
    };

/** The files later stages read, from one commit. */
export type Snapshot = {
  readonly url: string;
  readonly sha: Sha;
  readonly manifest: Manifest;
  readonly lock: Lock;
  readonly codeowners: string | null;
  /** Source files by repository-relative path. */
  readonly files: ReadonlyMap<string, string>;
  readonly warnings: readonly Warning[];
};

export const FETCH_LIMITS = Object.freeze({
  sourceBytes: 512 * 1024,
  packageBytes: 20 * 1024 * 1024,
  keptBytes: 50 * 1024 * 1024,
});

const sources = /\.(js|mjs|cjs|ts|mts|cts|tsx|jsx)$/;
const excluded = /(^|\/)(node_modules|dist|build|\.next|coverage|vendor)\//;
const owners = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"] as const;

/** The Repo node's key, lowercased like the graph name so that it is stable across re-ingests. */
export function repoUrl(repo: Pick<RepoRef, "owner" | "name">): string {
  return `https://github.com/${repo.owner.toLowerCase()}/${repo.name.toLowerCase()}`;
}

type Kind = "manifest" | "lock" | "codeowners" | "source" | "drop";

function kindOf(path: string): Kind {
  if (path === "package.json") return "manifest";
  if (path === "package-lock.json") return "lock";
  if ((owners as readonly string[]).includes(path)) return "codeowners";
  if (excluded.test(path) || path.endsWith(".min.js") || !sources.test(path)) return "drop";
  return "source";
}

/** Strips GitHub's `<owner>-<repo>-<sha>/` folder; null for the folder itself or an unsafe path. */
function relative(name: string): string | null {
  const at = name.indexOf("/");
  if (at === -1) return null;
  const path = name.slice(at + 1);
  if (path === "" || path.startsWith("/") || path.split("/").some((part) => part === ".." || part === "")) {
    return null;
  }
  return path;
}

async function text(entry: AsyncIterable<unknown>): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of entry) {
    if (!(chunk instanceof Uint8Array))
      throw new IngestError("ingest.upstream", "the tarball held unreadable data");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Stage 1. Resolves the commit, records the Repo, and reads the package files, the CODEOWNERS file, and the
 * source files from the commit's tarball without unpacking it to disk.
 */
export async function snapshot(
  input: { readonly g: G; readonly repo: RepoRef; readonly target: Target },
  deps: { readonly forge: Pick<Forge, "head" | "tarball"> },
  opts: {
    readonly onProgress: (event: Extract<RunEvent, { type: "ingest.progress" }>) => void;
    readonly signal: AbortSignal;
  },
): Promise<Snapshot> {
  const { repo } = input;
  const { signal } = opts;
  if (signal.aborted) throw new IngestError("ingest.aborted", "ingestion was stopped");
  opts.onProgress({ type: "ingest.progress", stage: "fetch", done: 0, total: 1 });

  let sha: Sha;
  let branch: string | null = null;
  if (repo.sha === undefined) {
    const head = await deps.forge.head(repo, signal);
    sha = head.sha;
    branch = head.branch;
  } else {
    sha = repo.sha;
  }
  const url = repoUrl(repo);
  await input.g.query(ingest.repo.upsert, { url, owner: repo.owner, name: repo.name, branch }, signal);

  const files = new Map<string, string>();
  const found = new Map<string, string>();
  const skipped: string[] = [];
  let kept = 0;
  let manifestText: string | null = null;
  let lockText: string | null = null;

  const tar = extract();
  const reading = pipeline(Readable.from(deps.forge.tarball(repo, sha, signal)), createGunzip(), tar, {
    signal,
  });
  reading.catch(() => undefined);
  try {
    for await (const entry of tar) {
      const path = relative(entry.header.name);
      const size = entry.header.size ?? 0;
      const kind = path === null || entry.header.type !== "file" ? "drop" : kindOf(path);
      if (path === null || kind === "drop") {
        entry.resume();
        continue;
      }
      if (kind === "manifest" || kind === "lock") {
        if (size > FETCH_LIMITS.packageBytes) {
          throw new IngestError(
            kind === "lock" ? "ingest.lockfile" : "ingest.manifest",
            `${path} is larger than ${FETCH_LIMITS.packageBytes / 1024 / 1024} MB`,
          );
        }
        if (kind === "manifest") manifestText = await text(entry);
        else lockText = await text(entry);
      } else if (kind === "codeowners") {
        if (size > FETCH_LIMITS.sourceBytes) entry.resume();
        else found.set(path, await text(entry));
      } else if (size > FETCH_LIMITS.sourceBytes || kept + size > FETCH_LIMITS.keptBytes) {
        skipped.push(path);
        entry.resume();
      } else {
        kept += size;
        files.set(path, await text(entry));
      }
    }
    await reading;
  } catch (error) {
    if (error instanceof IngestError) throw error;
    if (signal.aborted) throw new IngestError("ingest.aborted", "ingestion was stopped");
    throw new IngestError("ingest.upstream", "the repository tarball could not be read");
  } finally {
    tar.destroy();
  }

  if (input.target.kind === "verify") {
    manifestText = input.target.override.manifest;
    lockText = input.target.override.lock;
  }
  if (manifestText === null)
    throw new IngestError("ingest.manifest", "the repository has no root package.json");
  if (lockText === null) {
    throw new IngestError(
      "ingest.lockfile",
      "the repository has no root package-lock.json; only npm is supported",
    );
  }
  if (Buffer.byteLength(manifestText) > FETCH_LIMITS.packageBytes) {
    throw new IngestError("ingest.manifest", "package.json is larger than the limit");
  }
  if (Buffer.byteLength(lockText) > FETCH_LIMITS.packageBytes) {
    throw new IngestError("ingest.lockfile", "package-lock.json is larger than the limit");
  }

  const warnings: Warning[] =
    skipped.length === 0 ? [] : [{ code: "skipped", count: skipped.length, sample: skipped.slice(0, 5) }];
  opts.onProgress({ type: "ingest.progress", stage: "fetch", done: 1, total: 1 });
  return {
    url,
    sha,
    manifest: manifest(manifestText),
    lock: lock(lockText),
    codeowners: owners.map((path) => found.get(path)).find((owned) => owned !== undefined) ?? null,
    files,
    warnings,
  };
}
