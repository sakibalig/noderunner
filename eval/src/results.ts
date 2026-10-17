import { z } from "zod";

export const Agent = z.enum(["triage", "baseline"]);

export const RunScore = z.object({
  agent: Agent,
  runId: z.string(),
  status: z.enum(["done", "failed", "capped"]),
  unverified: z.boolean(),
  result: z
    .boolean()
    .describe("False when the run ended without a valid result block, which scores as empty"),
  mustFix: z.array(z.string()),
  precision: z.number().nullable(),
  recall: z.number().nullable(),
  upgrades: z.number().int(),
  calls: z.number().int(),
  tokensIn: z.number().int(),
  tokensOut: z.number().int(),
  ms: z.number().int(),
});
export type RunScore = z.infer<typeof RunScore>;

export const Results = z.object({
  repo: z.string(),
  sha: z.string(),
  model: z.string(),
  date: z.string().describe("YYYY-MM-DD of the run"),
  labels: z.object({
    total: z.number().int(),
    reachable: z.number().int(),
    checked: z.number().int(),
    corrections: z.number().int(),
  }),
  runs: z.array(RunScore),
});
export type Results = z.infer<typeof Results>;
