import { z } from "zod";
import { query, write } from "../define.ts";

/**
 * Params: `{ planId }`. What shipping a plan needs: its approval, any pull request it already has, its upgrades, the
 * findings they close, and the repository's commit; no row for an unknown plan.
 */
export const load = query(
  "ship.load",
  `MATCH (run:Run)-[:PROPOSED]->(p:Plan {id: $planId})
OPTIONAL MATCH (p)-[:SHIPPED_AS]->(pr:PullRequest)
OPTIONAL MATCH (p)-[:INCLUDES]->(u:Upgrade)
WITH run, p, pr, collect(u) AS us
OPTIONAL MATCH (p)-[:INCLUDES]->(:Upgrade)-[:CLOSES]->(x:Finding)
WITH run, p, pr, us, collect(DISTINCT x.key) AS targets
MATCH (r:Repo)
RETURN p.approved AS approved, pr.url AS shipped, run.id AS runId, r.owner AS owner, r.name AS name,
       r.snapshot_sha AS sha, targets,
       [u IN us | {id: u.id, kind: u.kind, package: u.package, from: u.from, to: u.to, jump: u.semver_jump,
                   cost: u.cost}] AS upgrades
LIMIT 1`,
  z.object({
    approved: z.boolean().nullable(),
    shipped: z.string().nullable(),
    runId: z.string(),
    owner: z.string(),
    name: z.string(),
    sha: z.string().nullable(),
    targets: z.array(z.string()),
    upgrades: z.array(
      z.object({
        id: z.string(),
        kind: z.enum(["refresh", "bump", "override"]),
        package: z.string(),
        from: z.string(),
        to: z.string(),
        jump: z.enum(["patch", "minor", "major"]),
        cost: z.number(),
      }),
    ),
  }),
);

/** Every finding with an affected install, and its tier. Run on both the repository and the verification graph. */
export const keys = query(
  "ship.keys",
  `MATCH (x:Finding)-[:AT]->(:Install)
RETURN DISTINCT x.key AS key ORDER BY key LIMIT 5000`,
  z.object({ key: z.string() }),
);

/** Params: `{ planId, url, number, branch, targeted, closed, newFindings, now }`. */
export const record = write(
  "ship.record",
  `MATCH (p:Plan {id: $planId})
MERGE (pr:PullRequest {url: $url})
SET pr.number = $number, pr.branch = $branch, pr.state = "open", pr.targeted = $targeted, pr.closed = $closed,
    pr.new_findings = $newFindings, pr.created_at = $now
MERGE (p)-[:SHIPPED_AS]->(pr)`,
);
