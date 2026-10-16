import { z } from "zod";
import { query, write } from "../define.ts";

/** Params: `{ runId }`. Whether the run exists. */
export const run = query(
  "plan.run",
  "MATCH (r:Run {id: $runId}) RETURN count(r) AS n",
  z.object({ n: z.number() }),
);

/** How many findings exist and how many have a tier, so planning before reachability is refused. */
export const tiered = query(
  "plan.tiered",
  `MATCH (x:Finding) WHERE x.status IN ["open", "planned"]
RETURN count(x) AS total, sum(CASE WHEN x.tier IS NULL THEN 0 ELSE 1 END) AS tiered`,
  z.object({ total: z.number().int(), tiered: z.number().int() }),
);

/**
 * Params: `{ tiers }`. One row per (finding, affected install) in those tiers that is open or planned, with every
 * range that selects the install and the advisory's ranges as stored.
 */
export const targets = query(
  "plan.targets",
  `MATCH (x:Finding)-[:AT]->(i:Install), (x)-[:ABOUT]->(v:Vuln)
WHERE x.tier IN $tiers AND x.status IN ["open", "planned"]
OPTIONAL MATCH (:Install)-[d:DEPENDS_ON]->(i)
WITH x, i, v, collect(d.range) AS deps
OPTIONAL MATCH (:Repo)-[dd:DECLARES]->(i)
RETURN x.key AS key, x.package AS package, i.lock_path AS lockPath, i.version AS version, v.ranges AS ranges,
       deps, collect(dd.range) AS declared
ORDER BY key, lockPath LIMIT 5000`,
  z.object({
    key: z.string(),
    package: z.string(),
    lockPath: z.string(),
    version: z.string(),
    ranges: z.string(),
    deps: z.array(z.string()),
    declared: z.array(z.string()),
  }),
);

/** Params: `{ tiers }`. Each route of at most two hops from a direct dependency down to a target install. */
export const chains = query(
  "plan.chains",
  `MATCH (x:Finding)-[:AT]->(bad:Install)
WHERE x.tier IN $tiers AND x.status IN ["open", "planned"]
MATCH p = (:Repo)-[d:DECLARES]->(top:Install)-[:DEPENDS_ON*0..2]->(bad)
RETURN x.key AS key, bad.lock_path AS lockPath, top.version AS version, d.range AS range,
       [n IN nodes(p) WHERE n:Install | n.name] AS path
ORDER BY key, lockPath, size(path) LIMIT 20000`,
  z.object({
    key: z.string(),
    lockPath: z.string(),
    version: z.string(),
    range: z.string(),
    path: z.array(z.string()).min(1),
  }),
);

/**
 * Params: `{ runId, planId, now, totalCost, uncovered, upgrades }`, each upgrade
 * `{ id, kind, package, from, to, semverJump, cost, closes }`. Writes the whole plan in one query, unapproved; an
 * open finding it closes becomes planned.
 */
export const save = write(
  "plan.save",
  `MATCH (run:Run {id: $runId})
CREATE (run)-[:PROPOSED]->(p:Plan {id: $planId, created_at: $now, total_cost: $totalCost, uncovered: $uncovered,
                                   approved: false})
WITH p
UNWIND $upgrades AS u
CREATE (p)-[:INCLUDES]->(x:Upgrade {id: u.id, kind: u.kind, package: u.package, from: u.from, to: u.to,
                                    semver_jump: u.semverJump, cost: u.cost})
WITH x, u
UNWIND u.closes AS key
MATCH (f:Finding {key: key})
CREATE (x)-[:CLOSES]->(f)
SET f.status = CASE WHEN f.status = "open" THEN "planned" ELSE f.status END`,
);

/** Params: `{ planId }`. The plan's upgrades and the findings each closes, for evidence. */
export const read = query(
  "plan.read",
  `MATCH (p:Plan {id: $planId})-[i:INCLUDES]->(u:Upgrade)
OPTIONAL MATCH (u)-[c:CLOSES]->(f:Finding)
RETURN id(p) AS planNode, u.id AS upgrade, id(u) AS upgradeNode, id(i) AS includesId,
       collect({key: f.key, node: id(f), edge: id(c)}) AS closes
ORDER BY upgrade LIMIT 500`,
  z.object({
    planNode: z.number().int(),
    upgrade: z.string(),
    upgradeNode: z.number().int(),
    includesId: z.number().int(),
    closes: z.array(
      z.object({ key: z.string().nullable(), node: z.number().nullable(), edge: z.number().nullable() }),
    ),
  }),
);
