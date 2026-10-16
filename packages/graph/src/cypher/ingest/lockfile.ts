import { write } from "../define.ts";

/** Rows: `{ lock_path, name, version, purl, dev, optional }`; params: `{ sha }`. */
export const installs = write(
  "lockfile.installs",
  `UNWIND $rows AS r
MERGE (p:Package {name: r.name})
MERGE (i:Install {lock_path: r.lock_path})
SET i.name = r.name, i.version = r.version, i.purl = r.purl, i.dev = r.dev, i.optional = r.optional,
    i.snapshot_sha = $sha
MERGE (i)-[:OF]->(p)`,
);

/** Rows: `{ from, to, range, kind }` as lock paths; params: `{ sha }`. */
export const depends = write(
  "lockfile.depends",
  `UNWIND $rows AS r
MATCH (a:Install {lock_path: r.from}), (b:Install {lock_path: r.to})
MERGE (a)-[e:DEPENDS_ON]->(b)
SET e.range = r.range, e.kind = r.kind, e.snapshot_sha = $sha`,
);

/** Rows: `{ to, range, dev }`; params: `{ sha, url }`. */
export const declares = write(
  "lockfile.declares",
  `UNWIND $rows AS r
MATCH (repo:Repo {url: $url}), (i:Install {lock_path: r.to})
MERGE (repo)-[e:DECLARES]->(i)
SET e.range = r.range, e.dev = r.dev, e.snapshot_sha = $sha`,
);
