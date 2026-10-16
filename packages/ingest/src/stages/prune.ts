import type { G, Query, RunEvent, Sha } from "@noderunner/core";
import { ingest } from "@noderunner/graph/cypher";

const { prune: p } = ingest;
const deletions = [p.installs, p.files, p.depends, p.imports, p.loads, p.declares, p.affects, p.at] as const;

async function drain(g: G, q: Query<{ deleted: number }>, sha: Sha, signal: AbortSignal): Promise<number> {
  let total = 0;
  for (;;) {
    const [row] = await g.query(q, { sha }, signal);
    const deleted = row?.deleted ?? 0;
    total += deleted;
    if (deleted === 0) return total;
  }
}

/**
 * Stage 6. Removes what the new commit no longer has, marks findings with no affected install left as fixed, and
 * stamps the commit on the Repo. Run only after stages 1 to 4 succeeded, so a failed ingest keeps the old stamp.
 */
export async function prune(
  input: { readonly g: G; readonly url: string; readonly sha: Sha; readonly now: number },
  opts: {
    readonly onProgress: (event: Extract<RunEvent, { type: "ingest.progress" }>) => void;
    readonly signal: AbortSignal;
  },
): Promise<{ readonly deleted: number; readonly fixed: number }> {
  const { g, sha, signal } = { ...input, signal: opts.signal };
  const total = deletions.length + 2;
  let deleted = 0;
  for (const [index, q] of deletions.entries()) {
    opts.onProgress({ type: "ingest.progress", stage: "prune", done: index, total });
    deleted += await drain(g, q, sha, signal);
  }
  const [row] = await g.query(p.fixed, { now: input.now }, signal);
  await g.query(p.stamp, { url: input.url, sha, now: input.now }, signal);
  opts.onProgress({ type: "ingest.progress", stage: "prune", done: total, total });
  return { deleted, fixed: row?.fixed ?? 0 };
}
