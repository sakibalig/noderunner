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

/** Params: `{ key }`. One finding with its advisory and affected installs; no row when it does not exist. */
export const detail = query(
  "findings.detail",
  `MATCH (x:Finding {key: $key})-[:ABOUT]->(v:Vuln)
OPTIONAL MATCH (x)-[:AT]->(i:Install)
WITH x, v, i ORDER BY i.lock_path
RETURN x.key AS key, x.vuln_id AS vulnId, x.package AS package, x.severity AS severity, x.tier AS tier,
       x.status AS status, collect(i.lock_path) AS installs, v.id AS id, v.aliases AS aliases,
       v.severity AS vulnSeverity, v.summary AS summary, v.modified AS modified
LIMIT 1`,
  z.object({
    key: z.string(),
    vulnId: z.string(),
    package: z.string(),
    severity: z.string(),
    tier: z.string().nullable(),
    status: z.string(),
    installs: z.array(z.string()),
    id: z.string(),
    aliases: z.array(z.string()).nullable(),
    vulnSeverity: z.string(),
    summary: z.string().nullable(),
    modified: z.number().nullable(),
  }),
);

const Step = z.object({ id: z.number().int(), key: z.string(), name: z.string() });

/**
 * Params: `{ key }`. The shortest path from a production file to an install the finding affects, with the ids and
 * keys the evidence needs; no row when no production file reaches it.
 */
export const path = query(
  "findings.path",
  `MATCH (x:Finding {key: $key})-[:AT]->(bad:Install)
MATCH (f:File {kind: "prod"})-[l:LOADS]->(entry:Install)
WITH DISTINCT x, f, l, entry, bad
WITH x, f, l, bad, shortestPath((entry)-[:DEPENDS_ON*0..15]->(bad)) AS p
WHERE p IS NOT NULL
WITH x, f, l, bad, p ORDER BY length(p), f.path LIMIT 1
MATCH (x)-[:ABOUT]->(v:Vuln)-[a:AFFECTS]->(bad)
RETURN f.path AS file, id(f) AS fileNode, id(l) AS loads,
       [n IN nodes(p) | {id: id(n), key: n.lock_path, name: n.name + "@" + n.version}] AS chain,
       [r IN relationships(p) | id(r)] AS hops, v.id AS vulnId, id(v) AS vulnNode, id(a) AS affects`,
  z.object({
    file: z.string(),
    fileNode: z.number().int(),
    loads: z.number().int(),
    chain: z.array(Step).min(1),
    hops: z.array(z.number().int()),
    vulnId: z.string(),
    vulnNode: z.number().int(),
    affects: z.number().int(),
  }),
);

/** Params: `{ key }`. Every decision on the finding, newest first, with who made it. */
export const decisions = query(
  "findings.decisions",
  `MATCH (d:Decision)-[:ABOUT]->(:Finding {key: $key})
OPTIONAL MATCH (d)-[:MADE_BY]->(p:Person)
RETURN d.id AS id, d.kind AS kind, d.reason AS reason, p.handle AS by, d.created_at AS createdAt,
       d.expires_at AS expiresAt, d.tier_at_decision AS tierAtDecision, d.stale_reason AS staleReason
ORDER BY createdAt DESC, id DESC LIMIT 50`,
  z.object({
    id: z.string(),
    kind: z.string(),
    reason: z.string(),
    by: z.string().nullable(),
    createdAt: z.number().int(),
    expiresAt: z.number().int().nullable(),
    tierAtDecision: z.string().nullable(),
    staleReason: z.string().nullable(),
  }),
);
