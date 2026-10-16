import {
  type Access,
  type Clock,
  type Db,
  type ErrorCode,
  type Evidence,
  Fault,
  type Ids,
  Json,
  StepId,
  type ToolCtx,
  type ToolResult,
} from "@noderunner/core";
import { memory } from "@noderunner/graph/cypher";
import type { z } from "zod";
import { ToolError } from "./errors.ts";
import { cap } from "./evidence.ts";
import { type AnyTool, available } from "./registry.ts";

/** The stored copy of a call's input is cut to this many characters. */
export const INPUT_CHARS = 4_000;

export type StepHooks = {
  onStart(step: { stepId: StepId; seq: number; tool: string; input: Json }): void;
  onFinish(step: {
    stepId: StepId;
    ok: boolean;
    summary: string;
    evidence?: Evidence;
    ms: number;
    code?: ErrorCode;
  }): void;
};

export type Toolbox = {
  callTool(name: string, input: unknown, ctx: ToolCtx, hooks: StepHooks): Promise<ToolResult<unknown>>;
};

type Outcome =
  | { readonly kind: "ok"; readonly data: unknown; readonly summary: string; readonly evidence: Evidence }
  | { readonly kind: "failed"; readonly message: string; readonly code: ErrorCode };

function zodMessage(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "input"}: ${issue.message}`)
    .join("; ");
}

function failed(error: unknown): Outcome {
  if (error instanceof Fault) return { kind: "failed", message: error.message, code: error.surface };
  return { kind: "failed", message: "The tool failed unexpectedly", code: "internal" };
}

/** Runs `def` under its own timeout, linked to the run's signal; a tool that ignores the signal is still cut off. */
async function execute(def: AnyTool, input: unknown, ctx: ToolCtx): Promise<Outcome> {
  if (ctx.signal.aborted) return failed(new ToolError("tool.cancelled", "The run was cancelled"));
  const controller = new AbortController();
  const timeout = new ToolError("tool.timeout", `The tool timed out after ${def.timeoutMs / 1000} s`);
  const cancelled = new ToolError("tool.cancelled", "The run was cancelled");
  const forward = () => controller.abort();
  ctx.signal.addEventListener("abort", forward, { once: true });
  const timer = setTimeout(() => controller.abort(), def.timeoutMs);
  try {
    const output = await new Promise<Awaited<ReturnType<AnyTool["run"]>>>((resolve, reject) => {
      controller.signal.addEventListener("abort", () => reject(ctx.signal.aborted ? cancelled : timeout), {
        once: true,
      });
      def.run({ ...ctx, signal: controller.signal }, input).then(resolve, reject);
    });
    return { kind: "ok", data: output.data, summary: output.summary, evidence: output.evidence };
  } catch (error) {
    return failed(error);
  } finally {
    clearTimeout(timer);
    ctx.signal.removeEventListener("abort", forward);
  }
}

/**
 * The one way any caller runs a tool. Every call writes exactly one Step under the run, created before the tool
 * runs, and returns the ToolResult envelope; it never throws.
 */
export function createToolbox(
  deps: { readonly db: Db; readonly clock: Clock; readonly ids: Ids; readonly tools: readonly AnyTool[] },
  opts: { readonly access: readonly Access[] },
): Toolbox {
  return {
    async callTool(name, raw, ctx, hooks) {
      const g = deps.db.graph(ctx.graph);
      const started = deps.clock.now();
      const stepId = StepId.parse(deps.ids.next());
      const stored = (JSON.stringify(raw ?? null) ?? "null").slice(0, INPUT_CHARS);
      const shown = Json.safeParse(raw ?? null);

      let seq: number | null = null;
      try {
        const [row] = await g.query(
          memory.step.start,
          { runId: ctx.runId, id: stepId, tool: name, input: stored },
          ctx.signal,
        );
        seq = row?.seq ?? null;
      } catch {
        seq = null;
      }
      if (seq === null) {
        const summary = "The step could not be recorded";
        hooks.onFinish({ stepId, ok: false, summary, ms: deps.clock.now() - started, code: "internal" });
        return { ok: false, error: summary, stepId };
      }
      hooks.onStart({ stepId, seq, tool: name, input: shown.success ? shown.data : null });

      let outcome: Outcome;
      const def = available(ctx.actor, opts.access, deps.tools).find((tool) => tool.name === name);
      if (def === undefined) {
        outcome = failed(new ToolError("tool.unavailable", `Tool ${name} is not available to this agent`));
      } else {
        const parsed = def.input.safeParse(raw ?? {});
        outcome = parsed.success
          ? await execute(def, parsed.data, ctx)
          : failed(new ToolError("tool.input", zodMessage(parsed.error)));
      }

      let evidence: Evidence = { nodes: [], edges: [], cypher: [] };
      let summary = outcome.kind === "ok" ? outcome.summary : outcome.message;
      if (outcome.kind === "ok") {
        const capped = cap(outcome.evidence);
        evidence = capped.evidence;
        if (capped.dropped > 0) summary = `${summary} (evidence capped)`;
      }
      const ms = deps.clock.now() - started;
      try {
        // The step's own writes run even when the run was cancelled, so the record stays complete.
        const writing = new AbortController().signal;
        await g.batch(
          memory.step.touched,
          evidence.nodes.map((node) => ({ id: node.id })),
          { stepId },
          writing,
        );
        await g.query(
          memory.step.finish,
          {
            id: stepId,
            ok: outcome.kind === "ok",
            summary,
            queries: evidence.cypher,
            ms,
            edges: JSON.stringify(evidence.edges.map((edge) => edge.key)),
          },
          writing,
        );
      } catch (error) {
        const message = "The step could not be recorded";
        const code = error instanceof Fault ? error.surface : "internal";
        hooks.onFinish({ stepId, ok: false, summary: message, ms, code });
        return { ok: false, error: message, stepId };
      }

      if (outcome.kind === "failed") {
        hooks.onFinish({ stepId, ok: false, summary, ms, code: outcome.code });
        return { ok: false, error: outcome.message, stepId };
      }
      hooks.onFinish({ stepId, ok: true, summary, evidence, ms });
      return { ok: true, data: outcome.data, summary, evidence, stepId };
    },
  };
}
