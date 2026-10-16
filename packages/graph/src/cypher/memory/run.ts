import { write } from "../define.ts";

/**
 * Params: `{ id, agent, model, now }`, with `model` null for mcp and ui runs. Called by whoever starts a run, before
 * its first tool call; a rerun with the same id changes nothing.
 */
export const start = write(
  "run.start",
  `MERGE (r:Run {id: $id})
ON CREATE SET r.agent = $agent, r.model = $model, r.status = "running", r.started_at = $now`,
);

/** Params: `{ id, status, report, result, unverified, tokensIn, tokensOut, now }`, with `result` a JSON string or null. */
export const finish = write(
  "run.finish",
  `MATCH (r:Run {id: $id})
SET r.status = $status, r.report = $report, r.result = $result, r.unverified = $unverified,
    r.tokens_in = $tokensIn, r.tokens_out = $tokensOut, r.finished_at = $now`,
);
