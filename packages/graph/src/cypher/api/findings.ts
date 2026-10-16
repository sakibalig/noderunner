import { z } from "zod";
import { query } from "../define.ts";

/** Params: `{ tier, status }`, either null for any. Findings most severe first, with their affected installs. */
export const list = query(
  "findings.list",
  `MATCH (x:Finding)-[:ABOUT]->(v:Vuln)
WHERE ($tier IS NULL OR x.tier = $tier) AND ($status IS NULL OR x.status = $status)
OPTIONAL MATCH (x)-[:AT]->(i:Install)
WITH x, v, i ORDER BY i.lock_path
WITH x, v, collect(i.lock_path) AS installs
RETURN x.key AS key, x.vuln_id AS vulnId, x.package AS package, x.severity AS severity, x.tier AS tier,
       x.status AS status, installs, v.severity_rank AS rank
ORDER BY rank DESC, key LIMIT 2000`,
  z.object({
    key: z.string(),
    vulnId: z.string(),
    package: z.string(),
    severity: z.string(),
    tier: z.string().nullable(),
    status: z.string(),
    installs: z.array(z.string()),
    rank: z.number().int(),
  }),
);
