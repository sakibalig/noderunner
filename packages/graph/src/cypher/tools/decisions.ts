import { z } from "zod";
import { query, write } from "../define.ts";

const Id = z.number().int().nonnegative();

/**
 * Params: `{ package, vulnId }`, either null for any. Every unsuperseded decision with the facts core's staleness()
 * needs; the graph applies no policy.
 */
export const recall = query(
  "decisions.recall",
  `MATCH (d:Decision)-[:ABOUT]->(x:Finding)-[:ABOUT]->(v:Vuln)
WHERE NOT (d)<-[:SUPERSEDES]-(:Decision)
  AND ($package IS NULL OR x.package = $package) AND ($vulnId IS NULL OR x.vuln_id = $vulnId)
OPTIONAL MATCH (d)-[:MADE_BY]->(p:Person)
OPTIONAL MATCH (x)-[:AT]->(:Install)<-[:AFFECTS]-(other:Vuln) WHERE other.id <> v.id
WITH d, x, v, p, collect(DISTINCT other.severity) AS others
RETURN d.id AS id, d.kind AS kind, d.reason AS reason, p.handle AS by, d.created_at AS createdAt,
       d.expires_at AS expiresAt, d.tier_at_decision AS tierAtDecision, x.key AS key, x.tier AS tier,
       v.modified AS advisoryModified, v.severity AS severity, others,
       id(d) AS decisionNode, id(x) AS findingNode, id(v) AS vulnNode
ORDER BY key, createdAt, id LIMIT 500`,
  z.object({
    id: z.string(),
    kind: z.string(),
    reason: z.string(),
    by: z.string().nullable(),
    createdAt: z.number().int(),
    expiresAt: z.number().int().nullable(),
    tierAtDecision: z.string().nullable(),
    key: z.string(),
    tier: z.string().nullable(),
    advisoryModified: z.number(),
    severity: z.string(),
    others: z.array(z.string()),
    decisionNode: Id,
    findingNode: Id,
    vulnNode: Id,
  }),
);

/** Rows: `{ id, reason }`, the stale reason or null. */
export const stale = write(
  "decisions.stale",
  `UNWIND $rows AS r
MATCH (d:Decision {id: r.id})
SET d.stale_reason = r.reason`,
);

/**
 * Params: `{ key, id, kind, reason, now, expiresAt, by }`. Records a decision against the finding's current tier and
 * returns the newest unsuperseded decision it replaces; no row when the finding does not exist.
 */
export const record = query(
  "decisions.record",
  `MATCH (x:Finding {key: $key})
OPTIONAL MATCH (old:Decision)-[:ABOUT]->(x) WHERE NOT (old)<-[:SUPERSEDES]-(:Decision)
WITH x, old ORDER BY old.created_at DESC
WITH x, head(collect(old)) AS old
MERGE (p:Person {handle: $by}) ON CREATE SET p.kind = "user"
CREATE (d:Decision {id: $id, kind: $kind, reason: $reason, created_at: $now, expires_at: $expiresAt,
                    tier_at_decision: x.tier})-[:ABOUT]->(x)
CREATE (d)-[:MADE_BY]->(p)
SET x.status = CASE WHEN $kind = "waive" THEN "waived" WHEN x.status = "waived" THEN "open" ELSE x.status END
RETURN d.id AS decisionId, old.id AS superseded, id(d) AS decisionNode, id(x) AS findingNode`,
  z.object({ decisionId: z.string(), superseded: z.string().nullable(), decisionNode: Id, findingNode: Id }),
);

/** Params: `{ id, old }`. */
export const supersede = write(
  "decisions.supersede",
  `MATCH (n:Decision {id: $id}), (o:Decision {id: $old})
MERGE (n)-[:SUPERSEDES]->(o)`,
);
