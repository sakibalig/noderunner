import { z } from "zod";
import { query } from "../define.ts";

/**
 * The four funnel bars: every finding not fixed, those in the production tree, those import-reachable, and the
 * import-reachable ones still open, neither planned nor waived.
 */
export const funnel = query(
  "summary.funnel",
  `MATCH (x:Finding) WHERE x.status <> "fixed"
RETURN count(x) AS total,
       sum(CASE WHEN x.tier IN ["import-reachable", "installed"] THEN 1 ELSE 0 END) AS production,
       sum(CASE WHEN x.tier = "import-reachable" THEN 1 ELSE 0 END) AS reachable,
       sum(CASE WHEN x.tier = "import-reachable" AND x.status = "open" THEN 1 ELSE 0 END) AS open`,
  z.object({
    total: z.number().int(),
    production: z.number().int(),
    reachable: z.number().int(),
    open: z.number().int(),
  }),
);

/** The newest triage run on the repository; evaluation baselines and `ui` runs for decisions and shipping are not it. */
export const lastRun = query(
  "summary.lastRun",
  `MATCH (r:Run {agent: "triage"}) RETURN r.id AS runId, r.agent AS agent, r.status AS status, r.started_at AS startedAt
ORDER BY startedAt DESC, runId DESC LIMIT 1`,
  z.object({ runId: z.string(), agent: z.string(), status: z.string(), startedAt: z.number().int() }),
);
