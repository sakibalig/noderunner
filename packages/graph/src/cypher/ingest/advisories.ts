import { write } from "../define.ts";

/**
 * Rows: `{ id, aliases, severity, severity_rank, summary, published, modified, ranges, fixed, packages }`, with
 * `ranges` a JSON string and `packages` the names the advisory affects in this repository.
 */
export const vulns = write(
  "advisories.vulns",
  `UNWIND $rows AS r
MERGE (v:Vuln {id: r.id})
SET v.aliases = r.aliases, v.severity = r.severity, v.severity_rank = r.severity_rank, v.summary = r.summary,
    v.published = r.published, v.modified = r.modified, v.ranges = r.ranges, v.fixed = r.fixed
WITH v, r
UNWIND r.packages AS name
MERGE (p:Package {name: name})
MERGE (v)-[:IN_PACKAGE]->(p)`,
);

/** Rows: `{ vuln_id, lock_path }`; params: `{ sha }`. */
export const affects = write(
  "advisories.affects",
  `UNWIND $rows AS r
MATCH (v:Vuln {id: r.vuln_id}), (i:Install {lock_path: r.lock_path})
MERGE (v)-[e:AFFECTS]->(i)
SET e.snapshot_sha = $sha`,
);

/** Rows: `{ key, vuln_id, package }`. A fixed finding that reappears is reopened; others keep their status. */
export const findings = write(
  "advisories.findings",
  `UNWIND $rows AS r
MATCH (v:Vuln {id: r.vuln_id})
MERGE (x:Finding {key: r.key})
ON CREATE SET x.vuln_id = r.vuln_id, x.package = r.package, x.status = "open"
WITH x, v, x.status = "fixed" AS reopened
SET x.severity = v.severity,
    x.status = CASE WHEN reopened THEN "open" ELSE x.status END,
    x.fixed_at = CASE WHEN reopened THEN null ELSE x.fixed_at END
MERGE (x)-[:ABOUT]->(v)`,
);

/** Rows: `{ key, lock_path }`; params: `{ sha }`. */
export const at = write(
  "advisories.at",
  `UNWIND $rows AS r
MATCH (x:Finding {key: r.key}), (i:Install {lock_path: r.lock_path})
MERGE (x)-[a:AT]->(i)
SET a.snapshot_sha = $sha`,
);
