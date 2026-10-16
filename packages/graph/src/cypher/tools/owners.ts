import { z } from "zod";
import { query, write } from "../define.ts";

/** Params: `{ planId }`. Whether the plan exists. */
export const plan = query(
  "owners.plan",
  "MATCH (p:Plan {id: $planId}) RETURN count(p) AS n",
  z.object({ n: z.number() }),
);

/**
 * Params: `{ planId, since }`. For each upgrade, the production files that load an install reaching a finding it
 * closes, with their CODEOWNERS owners and the people who changed them since `since`.
 */
export const files = query(
  "owners.files",
  `MATCH (:Plan {id: $planId})-[:INCLUDES]->(u:Upgrade)-[:CLOSES]->(:Finding)-[:AT]->(bad:Install)
MATCH (f:File {kind: "prod"})-[:LOADS]->(entry:Install)
WITH DISTINCT u, f, entry, bad
WITH u, f, shortestPath((entry)-[:DEPENDS_ON*0..15]->(bad)) AS p
WHERE p IS NOT NULL
WITH DISTINCT u, f
OPTIONAL MATCH (o:Person)-[:OWNS]->(f)
WITH u, f, collect(DISTINCT o.handle) AS owners
OPTIONAL MATCH (c:Person)-[ch:CHANGED]->(f) WHERE ch.last_at >= $since
RETURN u.id AS upgrade, f.path AS file, owners, collect({handle: c.handle, commits: ch.commits}) AS changed
ORDER BY upgrade, file LIMIT 2000`,
  z.object({
    upgrade: z.string(),
    file: z.string(),
    owners: z.array(z.string()),
    changed: z.array(z.object({ handle: z.string().nullable(), commits: z.number().nullable() })),
  }),
);

/** Rows: `{ upgrade, handle, why }`. */
export const save = write(
  "owners.save",
  `UNWIND $rows AS r
MATCH (u:Upgrade {id: r.upgrade}), (p:Person {handle: r.handle})
MERGE (u)-[e:REVIEW_BY]->(p)
SET e.why = r.why`,
);

/** Params: `{ planId }`. The REVIEW_BY edges now on the plan's upgrades, for evidence. */
export const review = query(
  "owners.review",
  `MATCH (:Plan {id: $planId})-[:INCLUDES]->(u:Upgrade)-[e:REVIEW_BY]->(p:Person)
RETURN u.id AS upgrade, id(u) AS upgradeNode, p.handle AS handle, id(p) AS personNode, id(e) AS edge
ORDER BY upgrade, handle LIMIT 500`,
  z.object({
    upgrade: z.string(),
    upgradeNode: z.number().int(),
    handle: z.string(),
    personNode: z.number().int(),
    edge: z.number().int(),
  }),
);
