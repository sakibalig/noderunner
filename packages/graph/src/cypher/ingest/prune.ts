import { z } from "zod";
import { query, write } from "../define.ts";

const deleted = z.object({ deleted: z.number().int().nonnegative() });

// Stage 6. Each delete removes at most 5,000 and is repeated until it reports 0. Params: `{ sha }`, the commit just
// ingested; anything stamped with another commit was not seen in it. Memory nodes are never deleted.

export const installs = query(
  "prune.installs",
  "MATCH (n:Install) WHERE n.snapshot_sha <> $sha WITH n LIMIT 5000 DETACH DELETE n RETURN count(*) AS deleted",
  deleted,
);
export const files = query(
  "prune.files",
  "MATCH (n:File) WHERE n.snapshot_sha <> $sha WITH n LIMIT 5000 DETACH DELETE n RETURN count(*) AS deleted",
  deleted,
);
export const depends = query(
  "prune.depends",
  "MATCH ()-[e:DEPENDS_ON]->() WHERE e.snapshot_sha <> $sha WITH e LIMIT 5000 DELETE e RETURN count(*) AS deleted",
  deleted,
);
export const imports = query(
  "prune.imports",
  "MATCH ()-[e:IMPORTS]->() WHERE e.snapshot_sha <> $sha WITH e LIMIT 5000 DELETE e RETURN count(*) AS deleted",
  deleted,
);
export const loads = query(
  "prune.loads",
  "MATCH ()-[e:LOADS]->() WHERE e.snapshot_sha <> $sha WITH e LIMIT 5000 DELETE e RETURN count(*) AS deleted",
  deleted,
);
export const declares = query(
  "prune.declares",
  "MATCH ()-[e:DECLARES]->() WHERE e.snapshot_sha <> $sha WITH e LIMIT 5000 DELETE e RETURN count(*) AS deleted",
  deleted,
);
export const affects = query(
  "prune.affects",
  "MATCH ()-[e:AFFECTS]->() WHERE e.snapshot_sha <> $sha WITH e LIMIT 5000 DELETE e RETURN count(*) AS deleted",
  deleted,
);
export const at = query(
  "prune.at",
  "MATCH ()-[e:AT]->() WHERE e.snapshot_sha <> $sha WITH e LIMIT 5000 DELETE e RETURN count(*) AS deleted",
  deleted,
);

/** Params: `{ now }`. An open or planned finding left with no affected install is fixed. */
export const fixed = query(
  "prune.fixed",
  `MATCH (x:Finding) WHERE x.status IN ["open", "planned"] AND NOT (x)-[:AT]->(:Install)
SET x.status = "fixed", x.fixed_at = $now
RETURN count(x) AS fixed`,
  z.object({ fixed: z.number().int().nonnegative() }),
);

/** Params: `{ url, sha, now }`. Marks the commit the graph now holds. */
export const stamp = write(
  "prune.stamp",
  "MATCH (r:Repo {url: $url}) SET r.snapshot_sha = $sha, r.ingested_at = $now",
);
