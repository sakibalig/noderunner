import { z } from "zod";
import { query } from "../define.ts";

/** Params: `{ runId }`. The newest plan the run proposed, or no row. */
export const ofRun = query(
  "plans.ofRun",
  `MATCH (:Run {id: $runId})-[:PROPOSED]->(p:Plan)
RETURN p.id AS planId ORDER BY p.created_at DESC LIMIT 1`,
  z.object({ planId: z.string() }),
);

/** Params: `{ planId }`. Each upgrade with the findings it closes and its suggested reviewers. */
export const detail = query(
  "plans.detail",
  `MATCH (run:Run)-[:PROPOSED]->(p:Plan {id: $planId})-[:INCLUDES]->(u:Upgrade)
OPTIONAL MATCH (u)-[:CLOSES]->(x:Finding)
WITH run, p, u, collect(DISTINCT {key: x.key, severity: x.severity}) AS closes
OPTIONAL MATCH (u)-[r:REVIEW_BY]->(person:Person)
RETURN run.id AS runId, p.approved AS approved, p.total_cost AS totalCost, p.uncovered AS uncovered,
       u.kind AS kind, u.package AS package, u.from AS from, u.to AS to, u.semver_jump AS jump, u.cost AS cost,
       closes, collect(DISTINCT {handle: person.handle, why: r.why}) AS reviewers
ORDER BY package, to LIMIT 200`,
  z.object({
    runId: z.string(),
    approved: z.boolean().nullable(),
    totalCost: z.number(),
    uncovered: z.array(z.string()).nullable(),
    kind: z.enum(["refresh", "bump", "override"]),
    package: z.string(),
    from: z.string(),
    to: z.string(),
    jump: z.enum(["patch", "minor", "major"]),
    cost: z.number(),
    closes: z.array(z.object({ key: z.string().nullable(), severity: z.string().nullable() })),
    reviewers: z.array(z.object({ handle: z.string().nullable(), why: z.string().nullable() })),
  }),
);

/**
 * Params: `{ planId }`. For each finding the plan closes, the shortest chain from a production file to an affected
 * install, as `name@version` steps; a finding with no production path is absent.
 */
export const paths = query(
  "plans.paths",
  `MATCH (:Plan {id: $planId})-[:INCLUDES]->(:Upgrade)-[:CLOSES]->(x:Finding)-[:AT]->(bad:Install)
MATCH (f:File {kind: "prod"})-[:LOADS]->(entry:Install)
WITH DISTINCT x, f, entry, bad
WITH x, f, shortestPath((entry)-[:DEPENDS_ON*0..15]->(bad)) AS p
WHERE p IS NOT NULL
WITH x, f, p ORDER BY length(p), f.path
WITH x, head(collect({file: f.path, chain: [n IN nodes(p) | n.name + "@" + n.version]})) AS best
RETURN x.key AS key, best.file AS file, best.chain AS chain
ORDER BY key LIMIT 500`,
  z.object({ key: z.string(), file: z.string(), chain: z.array(z.string()).min(1) }),
);

/** Params: `{ planId, by, now }`. Marks the plan approved; returns no row when it does not exist. */
export const approve = query(
  "plans.approve",
  `MATCH (p:Plan {id: $planId})
SET p.approved = true, p.approved_by = $by, p.approved_at = $now
RETURN p.id AS planId`,
  z.object({ planId: z.string() }),
);
