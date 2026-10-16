import { z } from "zod";
import { query, write } from "../define.ts";

/**
 * Params: `{ runId, id, tool, input }`. Creates the Step as the run's next one before the tool runs; returns no row
 * when the run does not exist.
 */
export const start = query(
  "step.start",
  `MATCH (r:Run {id: $runId})
OPTIONAL MATCH (r)-[:HAS_STEP]->(old:Step)
WITH r, count(old) AS n
CREATE (r)-[:HAS_STEP]->(s:Step {id: $id, seq: n + 1, tool: $tool, input: $input, ok: false, summary: "",
                                 cypher: [], edges: "[]", ms: 0})
RETURN s.seq AS seq`,
  z.object({ seq: z.number().int().positive().describe("The step's position in its run, from 1") }),
);

/** Rows: `{ id }`, internal node ids from the call's capped evidence; params: `{ stepId }`. */
export const touched = write(
  "step.touched",
  `UNWIND $rows AS r
MATCH (s:Step {id: $stepId})
MATCH (x) WHERE id(x) = r.id
MERGE (s)-[:TOUCHED]->(x)`,
);

/**
 * Params: `{ id, ok, summary, queries, ms, edges }`: `queries` is the texts run (a parameter named `cypher` breaks the
 * client's `CYPHER` prefix) and `edges` the JSON list of evidence edge keys.
 */
export const finish = write(
  "step.finish",
  `MATCH (s:Step {id: $id})
SET s.ok = $ok, s.summary = $summary, s.cypher = $queries, s.ms = $ms, s.edges = $edges`,
);
