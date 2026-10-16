import { write } from "../define.ts";

/**
 * Params: `{ url, owner, name, branch }`. `branch` is null when the commit was given rather than read from the
 * default branch, and then keeps the stored value. `snapshot_sha` and `ingested_at` are set by stage 6 only.
 */
export const upsert = write(
  "repo.upsert",
  `MERGE (r:Repo {url: $url})
SET r.owner = $owner, r.name = $name, r.default_branch = coalesce($branch, r.default_branch)`,
);
