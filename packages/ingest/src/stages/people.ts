import type { Commit, Forge, G, RepoRef, Sha, Warning } from "@noderunner/core";
import { ingest } from "@noderunner/graph/cypher";
import { Codeowners, type Owner } from "../parse/codeowners.ts";

export const HISTORY_COMMITS = 200;

const bots = /(\[bot\]$|^dependabot|^renovate|^github-actions)/i;

export type PeopleInput = {
  readonly g: G;
  readonly repo: RepoRef;
  readonly sha: Sha;
  /** Every File node's path, repository-relative. */
  readonly files: readonly string[];
  /** The CODEOWNERS text from the root, `.github/`, or `docs/`, or null when there is none. */
  readonly codeowners: string | null;
};

export type PeopleResult = { readonly people: number; readonly warnings: readonly Warning[] };

type Changed = { handle: string; name: string; path: string; commits: number; last_at: number };

/** Counts each person's commits per file, dropping bots and commits with no GitHub login. */
export function tally(commits: readonly Commit[], files: ReadonlySet<string>): readonly Changed[] {
  const byKey = new Map<string, Changed>();
  for (const commit of commits) {
    if (commit.login === null || bots.test(commit.login)) continue;
    const handle = `@${commit.login.toLowerCase()}`;
    for (const path of commit.files) {
      if (!files.has(path)) continue;
      const key = `${handle}\u0000${path}`;
      const seen = byKey.get(key);
      if (seen === undefined)
        byKey.set(key, { handle, name: commit.name, path, commits: 1, last_at: commit.at });
      else byKey.set(key, { ...seen, commits: seen.commits + 1, last_at: Math.max(seen.last_at, commit.at) });
    }
  }
  return [...byKey.values()].sort((a, b) => a.handle.localeCompare(b.handle) || a.path.localeCompare(b.path));
}

/**
 * Stage 5. Replaces every OWNS edge from CODEOWNERS and every CHANGED edge from the last commits. Each half is
 * independent: when history fails, its `people` warning is returned and the previous CHANGED edges stay.
 */
export async function people(
  input: PeopleInput,
  deps: { readonly forge: Pick<Forge, "history"> },
  signal: AbortSignal,
): Promise<PeopleResult> {
  const { g } = input;
  const warnings: Warning[] = [];
  const handles = new Set<string>();

  const owners = input.codeowners === null ? null : new Codeowners(input.codeowners);
  if (owners !== null && owners.dropped.length > 0)
    warnings.push({ code: "people", count: owners.dropped.length, sample: owners.dropped.slice(0, 5) });
  const owned =
    owners === null
      ? []
      : input.files.flatMap((path) => owners.ownersOf(path).map((owner) => ({ owner, path })));
  const teams = new Map<string, Owner>(owned.map(({ owner }) => [owner.handle, owner]));

  let changed: readonly Changed[] | null = null;
  try {
    const commits = await deps.forge.history(input.repo, input.sha, HISTORY_COMMITS, signal);
    changed = tally(commits, new Set(input.files));
  } catch (error) {
    signal.throwIfAborted();
    warnings.push({ code: "people", count: 1, sample: [error instanceof Error ? error.name : "history"] });
  }

  const persons = [
    ...[...teams.values()].map((owner) => ({ handle: owner.handle, kind: owner.kind, name: null })),
    ...(changed ?? []).map((row) => ({ handle: row.handle, kind: "user", name: row.name })),
  ];
  await g.batch(ingest.people.persons, persons, {}, signal);
  for (const person of persons) handles.add(person.handle);

  await drain(g, ingest.people.clearOwns, signal);
  await g.batch(
    ingest.people.owns,
    owned.map(({ owner, path }) => ({ handle: owner.handle, path })),
    {},
    signal,
  );
  if (changed !== null) {
    await drain(g, ingest.people.clearChanged, signal);
    await g.batch(
      ingest.people.changed,
      changed.map(({ handle, path, commits, last_at }) => ({ handle, path, commits, last_at })),
      {},
      signal,
    );
  }
  return { people: handles.size, warnings };
}

async function drain(g: G, q: typeof ingest.people.clearOwns, signal: AbortSignal): Promise<void> {
  for (;;) {
    const [row] = await g.query(q, {}, signal);
    if ((row?.deleted ?? 0) === 0) return;
  }
}
