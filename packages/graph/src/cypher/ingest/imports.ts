import { write } from "../define.ts";

/** Rows: `{ path, kind, is_entry }`; params: `{ sha, url }`. */
export const files = write(
  "imports.files",
  `UNWIND $rows AS r
MATCH (repo:Repo {url: $url})
MERGE (f:File {path: r.path})
SET f.kind = r.kind, f.is_entry = r.is_entry, f.snapshot_sha = $sha
MERGE (repo)-[:CONTAINS]->(f)`,
);

/** Rows: `{ from, to }` as file paths; params: `{ sha }`. */
export const links = write(
  "imports.links",
  `UNWIND $rows AS r
MATCH (a:File {path: r.from}), (b:File {path: r.to})
MERGE (a)-[e:IMPORTS]->(b)
SET e.snapshot_sha = $sha`,
);

/** Rows: `{ from, name, specifier }`; a package with no install is skipped. Params: `{ sha }`. */
export const uses = write(
  "imports.uses",
  `UNWIND $rows AS r
MATCH (a:File {path: r.from}), (p:Package {name: r.name})
MERGE (a)-[e:IMPORTS]->(p)
SET e.specifier = r.specifier, e.snapshot_sha = $sha`,
);

/** Rows: `{ from, to }`, a file path and the lock path Node would load; params: `{ sha }`. */
export const loads = write(
  "imports.loads",
  `UNWIND $rows AS r
MATCH (a:File {path: r.from}), (i:Install {lock_path: r.to})
MERGE (a)-[e:LOADS]->(i)
SET e.snapshot_sha = $sha`,
);
