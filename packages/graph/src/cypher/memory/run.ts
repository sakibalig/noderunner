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
