import { z } from "zod";
import { IngestReport, Stage, Verification } from "./domain.ts";
import { ErrorCode } from "./errors.ts";
import { Evidence } from "./evidence.ts";
import { PlanId, RunId, StepId } from "./ids.ts";
import { Json } from "./json.ts";

export const Agent = z.enum(["triage", "fixer", "baseline", "mcp", "ui"]).describe("The run's agent");
export type Agent = z.infer<typeof Agent>;

/** One server-sent event, per contracts/api/events.md. */
export const RunEvent = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("ingest.progress"),
    stage: Stage,
    done: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  }),
  z.object({ type: z.literal("ingest.finished"), report: IngestReport }),
  z.object({
    type: z.literal("run.started"),
    runId: RunId,
    agent: Agent,
    model: z.string().nullable().describe("The model id; null for mcp and ui runs"),
  }),
  z.object({
    type: z.literal("step.started"),
    stepId: StepId,
    seq: z.number().int().positive(),
    tool: z.string().min(1),
    input: Json,
  }),
  z.object({
    type: z.literal("step.finished"),
    stepId: StepId,
    ok: z.boolean(),
    summary: z.string(),
    evidence: Evidence,
    ms: z.number().nonnegative(),
  }),
  z.object({ type: z.literal("message.delta"), text: z.string() }),
  z.object({
    type: z.literal("run.finished"),
    runId: RunId,
    status: z.enum(["done", "failed", "capped"]),
    unverified: z.boolean().describe("True when the report's citations failed validation twice"),
    report: z.string(),
  }),
  z.object({ type: z.literal("pr.opened"), planId: PlanId, url: z.url(), verification: Verification }),
  z.object({
    type: z.literal("pr.refused"),
    planId: PlanId,
    reason: z.string().min(1),
    verification: Verification.nullable().describe("Null when refused before verification"),
  }),
  z.object({ type: z.literal("job.failed"), code: ErrorCode, message: z.string() }),
]);
export type RunEvent = z.infer<typeof RunEvent>;
