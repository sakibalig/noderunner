import { z } from "zod";
import { Verification } from "./domain.ts";
import type { Agent } from "./events.ts";
import { Evidence } from "./evidence.ts";
import { type GraphName, type RunId, StepId } from "./ids.ts";

export const ToolName = z
  .enum([
    "recall_decisions",
    "list_alerts",
    "reachability",
    "introduced_by",
    "rank_packages",
    "plan_upgrades",
    "owners_for",
    "record_decision",
    "open_pull_request",
    "read_only_cypher",
    "search_files",
    "read_file",
  ])
  .describe("A tool name");
export type ToolName = z.infer<typeof ToolName>;

export const Access = z.enum(["read", "derive", "act"]).describe("read, derive, or act");
export type Access = z.infer<typeof Access>;

export type ToolCtx = {
  readonly graph: GraphName;
  readonly runId: RunId;
  readonly actor: Agent;
  readonly signal: AbortSignal;
};

/** What a tool's implementation returns before `callTool` wraps it. */
export type ToolOutput<O> = { readonly data: O; readonly summary: string; readonly evidence: Evidence };

export type ToolDef<I extends z.ZodType, O> = {
  readonly name: ToolName;
  readonly description: string;
  readonly input: I;
  readonly access: Access;
  readonly timeoutMs: number;
  run(ctx: ToolCtx, input: z.infer<I>): Promise<ToolOutput<O>>;
};

export type ToolOk<T> = {
  readonly ok: true;
  readonly data: T;
  readonly summary: string;
  readonly evidence: Evidence;
  readonly stepId: StepId;
};

export type ToolErr = { readonly ok: false; readonly error: string; readonly stepId: StepId };

export type ToolResult<T> = ToolOk<T> | ToolErr;

/** Builds the schema of a tool result whose `data` matches the given schema. */
export function toolResult<T extends z.ZodType>(data: T) {
  return z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), data, summary: z.string(), evidence: Evidence, stepId: StepId }),
    z.object({ ok: z.literal(false), error: z.string(), stepId: StepId }),
  ]);
}

/** What open_pull_request returns. */
export const Shipment = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("opened"),
    url: z.url().describe("The pull request URL"),
    branch: z.string().min(1).describe("The pushed branch"),
    verification: Verification,
  }),
  z.object({
    outcome: z.literal("refused"),
    reason: z.literal("new reachable finding").describe("Why the pull request was not opened"),
    verification: Verification,
  }),
]);
export type Shipment = z.infer<typeof Shipment>;
