import { z } from "zod";
import { query, write } from "../define.ts";

const File = z.object({
  path: z.string().describe("A production file that loads the chain's first install"),
  id: z.number().int().nonnegative().describe("The file's internal id"),
  edge: z.number().int().nonnegative().describe("The LOADS edge's internal id"),
});

/**
 * Params: `{ keys }`, empty for every finding. For each finding, the shortest DEPENDS_ON chain from an install a
 * production file loads to an affected install. `*0..15` covers a file loading the affected install itself (S1:
 * FalkorDB allows a minimum of 0 and only accepts shortestPath as a projection). Ties go to the entry's lock path.
 */
export const reachable = query(
  "tier.reachable",
  `MATCH (x:Finding)-[:AT]->(bad:Install)
WHERE size($keys) = 0 OR x.key IN $keys
MATCH (f:File {kind: "prod"})-[l:LOADS]->(entry:Install)
WITH x, bad, entry, f, l ORDER BY f.path
WITH x, bad, entry, collect({path: f.path, id: id(f), edge: id(l)})[0..3] AS files
WITH x, files, entry, shortestPath((entry)-[:DEPENDS_ON*0..15]->(bad)) AS p
WHERE p IS NOT NULL
WITH x, files, entry.name AS via, entry.lock_path AS start, length(p) AS hops,
     [n IN nodes(p) | n.lock_path] AS chain, [n IN nodes(p) | id(n)] AS nodeIds,
     [r IN relationships(p) | id(r)] AS edgeIds
ORDER BY hops ASC, start ASC
WITH x, head(collect({files: files, via: via, hops: hops, chain: chain, nodeIds: nodeIds, edgeIds: edgeIds})) AS best
RETURN x.key AS key, id(x) AS findingId, best.files AS files, best.via AS via, best.hops AS hops,
       best.chain AS chain, best.nodeIds AS nodeIds, best.edgeIds AS edgeIds
ORDER BY key LIMIT 5000`,
  z.object({
    key: z.string(),
    findingId: z.number().int().nonnegative(),
    files: z.array(File).min(1),
    via: z.string().describe("The package the production file loads"),
    hops: z.number().int().nonnegative(),
    chain: z.array(z.string()).min(1).describe("Lock paths from the loaded install to the affected one"),
    nodeIds: z.array(z.number().int().nonnegative()),
    edgeIds: z.array(z.number().int().nonnegative()),
  }),
);

/** Params: `{ keys, reachable }`. The findings not import-reachable: dev-only when every affected install is dev. */
export const rest = query(
  "tier.rest",
  `MATCH (x:Finding)-[:AT]->(i:Install)
WHERE (size($keys) = 0 OR x.key IN $keys) AND NOT x.key IN $reachable
WITH x, collect(i.dev) AS devs
RETURN x.key AS key, id(x) AS findingId, all(d IN devs WHERE d) AS devOnly
ORDER BY key LIMIT 5000`,
  z.object({ key: z.string(), findingId: z.number().int().nonnegative(), devOnly: z.boolean() }),
);

/** Params: `{ keys }`. Which of the given finding keys exist. */
export const known = query(
  "tier.known",
  "MATCH (x:Finding) WHERE x.key IN $keys RETURN x.key AS key ORDER BY key LIMIT 5000",
  z.object({ key: z.string() }),
);

/** Rows: `{ key, tier }`. */
export const save = write(
  "tier.save",
  `UNWIND $rows AS r
MATCH (x:Finding {key: r.key})
SET x.tier = r.tier`,
);
