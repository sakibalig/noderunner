import { z } from "zod";
import { query, write } from "../define.ts";

const Id = z.number().int().nonnegative();

/** Params: `{ minRank }`. Every finding not fixed, most severe first, with up to five installs. */
export const list = query(
  "alerts.list",
  `MATCH (x:Finding)-[ab:ABOUT]->(v:Vuln) WHERE x.status <> "fixed" AND v.severity_rank >= $minRank
OPTIONAL MATCH (x)-[a:AT]->(i:Install)
WITH x, ab, v, a, i ORDER BY i.lock_path
WITH x, ab, v, collect(i.lock_path)[0..5] AS installs, collect(id(i))[0..5] AS installIds,
     collect(id(a))[0..5] AS atIds
RETURN x.key AS key, x.vuln_id AS vulnId, x.package AS package, x.severity AS severity, x.tier AS tier,
       x.status AS status, v.severity_rank AS rank, installs, installIds, atIds,
       id(x) AS findingId, id(v) AS vulnNode, id(ab) AS aboutId
ORDER BY rank DESC, key LIMIT 5000`,
  z.object({
    key: z.string(),
    vulnId: z.string(),
    package: z.string(),
    severity: z.string(),
    tier: z.string().nullable(),
    status: z.string(),
    rank: z.number().int(),
    installs: z.array(z.string()),
    installIds: z.array(Id),
    atIds: z.array(Id),
    findingId: Id,
    vulnNode: Id,
    aboutId: Id,
  }),
);

/** Rows: `{ key }`; params: `{ runId }`. Records that the run listed each finding. */
export const found = write(
  "alerts.found",
  `UNWIND $rows AS r
MATCH (run:Run {id: $runId}), (x:Finding {key: r.key})
MERGE (run)-[:FOUND]->(x)`,
);
