import { z } from "zod";
import { query, write } from "../define.ts";

const deleted = z.object({ deleted: z.number().int().nonnegative() });

/** Deletes up to 5,000 OWNS edges; run until it reports 0. */
export const clearOwns = query(
  "people.clearOwns",
  "MATCH (:Person)-[e:OWNS]->(:File) WITH e LIMIT 5000 DELETE e RETURN count(e) AS deleted",
  deleted,
);

/** Deletes up to 5,000 CHANGED edges; run until it reports 0. */
export const clearChanged = query(
  "people.clearChanged",
  "MATCH (:Person)-[e:CHANGED]->(:File) WITH e LIMIT 5000 DELETE e RETURN count(e) AS deleted",
  deleted,
);

/** Rows: `{ handle, kind, name }`. */
export const persons = write(
  "people.persons",
  `UNWIND $rows AS r
MERGE (p:Person {handle: r.handle})
SET p.kind = r.kind, p.name = coalesce(r.name, p.name)`,
);

/** Rows: `{ handle, path }`; a path with no File node is skipped. */
export const owns = write(
  "people.owns",
  `UNWIND $rows AS r
MATCH (p:Person {handle: r.handle}), (f:File {path: r.path})
MERGE (p)-[e:OWNS]->(f)
SET e.source = 'codeowners'`,
);

/** Rows: `{ handle, path, commits, last_at }`; a path with no File node is skipped. */
export const changed = write(
  "people.changed",
  `UNWIND $rows AS r
MATCH (p:Person {handle: r.handle}), (f:File {path: r.path})
MERGE (p)-[e:CHANGED]->(f)
SET e.commits = r.commits, e.last_at = r.last_at`,
);
