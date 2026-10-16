import { z } from "zod";
import { query } from "../define.ts";

/** The repository the graph holds, once ingestion has stamped a commit on it. */
export const repo = query(
  "repos.repo",
  `MATCH (r:Repo) WHERE r.snapshot_sha IS NOT NULL
RETURN r.owner AS owner, r.name AS name, r.snapshot_sha AS sha, r.ingested_at AS ingestedAt
ORDER BY ingestedAt DESC LIMIT 1`,
  z.object({ owner: z.string(), name: z.string(), sha: z.string(), ingestedAt: z.number().int() }),
);

/** Node counts for the repository page: files, installs, vulnerabilities in the tree, open findings, people. */
export const counts = query(
  "repos.counts",
  `OPTIONAL MATCH (f:File) WITH count(f) AS files
OPTIONAL MATCH (i:Install) WITH files, count(i) AS installs
OPTIONAL MATCH (v:Vuln)-[:AFFECTS]->(:Install) WITH files, installs, count(DISTINCT v) AS vulns
OPTIONAL MATCH (x:Finding) WHERE x.status <> "fixed" WITH files, installs, vulns, count(x) AS findings
OPTIONAL MATCH (p:Person)
RETURN files, installs, vulns, findings, count(p) AS people`,
  z.object({
    files: z.number().int(),
    installs: z.number().int(),
    vulns: z.number().int(),
    findings: z.number().int(),
    people: z.number().int(),
  }),
);
