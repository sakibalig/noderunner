import {
  type Block,
  type Clock,
  type Db,
  Fault,
  type GraphName,
  limits,
  type Message,
  type Model,
  type RepoRef,
  type RunEvent,
  type RunId,
} from "@noderunner/core";
import { memory } from "@noderunner/graph/cypher";
import { type AnyTool, forModel, type StepHooks, type Toolbox } from "@noderunner/tools";
import type { Log } from "../log.ts";
import { BASELINE, kickoff, TRIAGE } from "./prompt.ts";
import { type Result, resultOf, type StepRecord, validateReport } from "./report.ts";
import { type AgentKind, specs, toolsFor } from "./tools.ts";

const CAPPED = `You have reached the limit of ${limits.runCalls} tool calls. Write the whole report now from the results you have; you cannot call tools.`;

/** One correction round is allowed before a report is stored unverified. */
export const CORRECTIONS = 1;

export type RunOutcome = {
  readonly status: "done" | "failed" | "capped";
  readonly report: string;
  readonly unverified: boolean;
  readonly result: Result | null;
  readonly tokens: { readonly input: number; readonly output: number };
};

const systems: Readonly<Partial<Record<AgentKind, string>>> = { triage: TRIAGE, baseline: BASELINE };

function texts(content: readonly Block[]): string {
  return content
    .filter((b): b is Extract<Block, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("");
}

/**
 * Runs one agent: the model chooses tools, each runs through callTool so it is a Step in the graph, and the report
 * is checked against the run's own results before the run ends. Decides no tier, plan, or verification itself.
 */
export async function runAgent(
  deps: {
    readonly model: Model;
    readonly modelId: string;
    readonly toolbox: Toolbox;
    readonly tools: readonly AnyTool[];
    readonly db: Db;
    readonly clock: Clock;
    readonly log: Log;
  },
  args: {
    readonly repo: RepoRef;
    readonly graph: GraphName;
    readonly runId: RunId;
    readonly agent: AgentKind;
    readonly kickoff: { readonly message?: string };
    readonly hooks: StepHooks;
    readonly emit: (event: RunEvent) => void;
    readonly signal: AbortSignal;
  },
): Promise<RunOutcome> {
  const { runId, agent, signal, emit } = args;
  const system = systems[agent];
  const tokens = { input: 0, output: 0 };
  const steps: StepRecord[] = [];
  let report = "";
  let status: RunOutcome["status"] = "done";
  let unverified = false;
  let calls = 0;
  let corrections = 0;

  emit({ type: "run.started", runId, agent, model: deps.modelId });
  deps.log.info({ runId, agent, model: deps.modelId }, "agent.run.started");
  try {
    if (system === undefined) throw new Error(`no prompt for ${agent}`);
    const defs = toolsFor(agent, deps.tools);
    const tools = specs(defs);
    const history: Message[] = [
      { role: "user", content: [{ type: "text", text: kickoff(args.repo, args.kickoff.message) }] },
    ];
    for (;;) {
      const turn = await deps.model.turn(
        { system, tools, messages: history, maxTokens: limits.maxTokens },
        (text) => emit({ type: "message.delta", text }),
        signal,
      );
      tokens.input += turn.usage.input;
      tokens.output += turn.usage.output;
      history.push({ role: "assistant", content: turn.content });
      deps.log.info({ runId, stop: turn.stop, ...turn.usage }, "agent.model.turn");

      if (turn.stop === "refusal") {
        status = "failed";
        report = "The model refused to continue this run.";
        break;
      }
      if (turn.stop === "tool_use") {
        const results: Block[] = [];
        let capped = false;
        for (const block of turn.content) {
          if (block.type !== "tool_use") continue;
          if (calls >= limits.runCalls) {
            capped = true;
            results.push({
              type: "tool_result",
              toolUseId: block.id,
              name: block.name,
              content: `Not run: the limit of ${limits.runCalls} tool calls is reached.`,
              isError: true,
            });
            continue;
          }
          calls += 1;
          const started = deps.clock.now();
          const ctx = { graph: args.graph, runId, actor: agent, signal };
          const result = await deps.toolbox.callTool(block.name, block.input, ctx, {
            onStart: (step) => {
              emit({
                type: "step.started",
                stepId: step.stepId,
                seq: step.seq,
                tool: step.tool,
                input: step.input,
              });
              args.hooks.onStart(step);
            },
            onFinish: (step) => args.hooks.onFinish(step),
          });
          emit({
            type: "step.finished",
            stepId: result.stepId,
            ok: result.ok,
            summary: result.ok ? result.summary : result.error,
            evidence: result.ok ? result.evidence : { nodes: [], edges: [], cypher: [] },
            ms: deps.clock.now() - started,
          });
          steps.push({
            stepId: result.stepId,
            tool: block.name,
            ok: result.ok,
            input: block.input,
            ...(result.ok ? { data: result.data } : {}),
          });
          results.push({
            type: "tool_result",
            toolUseId: block.id,
            name: block.name,
            content: forModel(block.name, result),
            isError: !result.ok,
          });
        }
        if (capped) {
          // One last turn with no tools, so a capped run still reports what its calls found.
          status = "capped";
          history.push({ role: "user", content: [...results, { type: "text", text: CAPPED }] });
          const last = await deps.model.turn(
            { system, tools: [], messages: history, maxTokens: limits.maxTokens },
            (text) => emit({ type: "message.delta", text }),
            signal,
          );
          tokens.input += last.usage.input;
          tokens.output += last.usage.output;
          report = texts(last.content);
          unverified = !validateReport(agent, report, steps).ok;
          break;
        }
        history.push({ role: "user", content: results });
        continue;
      }

      // stop is "end" or "limit": the turn's text is the report.
      report = texts(turn.content);
      const verdict = validateReport(agent, report, steps);
      if (verdict.ok) break;
      if (corrections >= CORRECTIONS) {
        unverified = true;
        break;
      }
      corrections += 1;
      history.push({
        role: "user",
        content: [
          {
            type: "text",
            text: `Your report has problems. Fix each one, calling tools if you need to, then write the whole report again:\n- ${verdict.problems.join("\n- ")}`,
          },
        ],
      });
    }
  } catch (error) {
    status = "failed";
    report = signal.aborted
      ? "The run was cancelled."
      : `The run failed: ${error instanceof Fault ? error.message : "the model could not be reached"}.`;
    deps.log.error({ runId, err: error instanceof Error ? error.name : "unknown" }, "agent.run.failed");
  }

  const result = status === "failed" ? null : resultOf(report);
  const g = deps.db.graph(args.graph);
  await g
    .query(
      memory.run.finish,
      {
        id: runId,
        status,
        report,
        result: result === null ? null : JSON.stringify(result),
        unverified,
        tokensIn: tokens.input,
        tokensOut: tokens.output,
        now: deps.clock.now(),
      },
      new AbortController().signal,
    )
    .catch((error: unknown) =>
      deps.log.error({ runId, err: error instanceof Error ? error.name : "unknown" }, "agent.run.unsaved"),
    );
  emit({ type: "run.finished", runId, status, unverified, report });
  deps.log.info(
    { runId, status, calls, unverified, ...tokens },
    `agent.run.${status === "done" ? "finished" : status}`,
  );
  return { status, report, unverified, result, tokens };
}
