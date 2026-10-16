import { z } from "zod";
import { query } from "./define.ts";

/** G1: compare with the lockfile's non-root, non-link entries and `npm ls --all`. Params: `{ url }`. */
export const counts = query(
  "golden.counts",
  `MATCH (i:Install)
WITH count(i) AS installs, sum(CASE WHEN i.dev THEN 1 ELSE 0 END) AS dev
OPTIONAL MATCH (:Repo {url: $url})-[d:DECLARES]->(:Install)
RETURN installs, dev, count(d) AS direct`,
  z.object({
    installs: z.number().int().nonnegative().describe("Install nodes"),
    dev: z.number().int().nonnegative().describe("Installs only in the dev tree"),
    direct: z.number().int().nonnegative().describe("DECLARES edges from the repository"),
  }),
);

/** G4: production files that load a package. Params: `{ package }`. */
export const loaders = query(
  "golden.loaders",
  `MATCH (f:File {kind: "prod"})-[:LOADS]->(:Install)-[:OF]->(:Package {name: $package})
RETURN DISTINCT f.path AS file ORDER BY file LIMIT 200`,
  z.object({ file: z.string().describe("A production file path") }),
);

/** G2: compare with `npm audit --json` on the same lockfile. */
export const vulns = query(
  "golden.vulns",
  `MATCH (v:Vuln)-[:AFFECTS]->(i:Install)
WITH v, i ORDER BY i.lock_path
RETURN v.id AS vuln, v.severity AS severity, collect(i.lock_path) AS installs
ORDER BY vuln LIMIT 500`,
  z.object({
    vuln: z.string().describe("The OSV id"),
    severity: z.string().describe("The severity word"),
    installs: z.array(z.string()).describe("The affected lock paths"),
  }),
);
