import { z } from "zod";
import { query } from "../define.ts";

const Id = z.number().int().nonnegative();

/**
 * Params: `{ key }`. For each affected install of the finding, the direct dependencies whose DECLARES edge reaches
 * it and the shortest chain; `*0..15` includes a vulnerable install that is itself a direct dependency.
 */
export const introduced = query(
  "chain.introduced",
  `MATCH (:Finding {key: $key})-[:AT]->(bad:Install)
MATCH (repo:Repo)-[d:DECLARES]->(top:Install)
WITH repo, d, top, bad, shortestPath((top)-[:DEPENDS_ON*0..15]->(bad)) AS p
WHERE p IS NOT NULL
RETURN top.name AS package, d.range AS range, d.dev AS dev, bad.lock_path AS target, length(p) AS hops,
       [n IN nodes(p) | n.lock_path] AS chain, [n IN nodes(p) | id(n)] AS nodeIds,
       [r IN relationships(p) | id(r)] AS edgeIds, id(d) AS declaresId, id(repo) AS repoId, repo.url AS repoUrl
ORDER BY hops, package, target LIMIT 50`,
  z.object({
    package: z.string(),
    range: z.string(),
    dev: z.boolean(),
    target: z.string(),
    hops: z.number().int().nonnegative(),
    chain: z.array(z.string()).min(1),
    nodeIds: z.array(Id),
    edgeIds: z.array(Id),
    declaresId: Id,
    repoId: Id,
    repoUrl: z.string(),
  }),
);
