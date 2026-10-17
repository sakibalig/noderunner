import {
  type Clock,
  type Db,
  type GraphName,
  type Ids,
  type Model,
  type RepoRef,
  RunId,
} from "@noderunner/core";
import { memory } from "@noderunner/graph/cypher";
import type { AnyTool, Toolbox } from "@noderunner/tools";
import { type Log, runAgent } from "@noderunner/worker";
import type { RunScore } from "./results.ts";
import { score } from "./score.ts";

export type Deps = {
  readonly model: Model;
  readonly modelId: string;
  readonly toolbox: Toolbox;
  readonly tools: readonly AnyTool[];
  readonly db: Db;
  readonly clock: Clock;
  readonly ids: Ids;
  readonly log: Log;
};

/** One run of one agent through the production loop, scored against the labels. */
export async function once(
  deps: Deps,
  args: {
    readonly agent: "triage" | "baseline";
    readonly repo: RepoRef;
    readonly graph: GraphName;
    readonly labelled: ReadonlySet<string>;
    readonly signal: AbortSignal;
  },
): Promise<RunScore> {
  const runId = RunId.parse(deps.ids.next());
  const started = deps.clock.now();
  await deps.db
    .graph(args.graph)
    .query(
      memory.run.start,
      { id: runId, agent: args.agent, model: deps.modelId, now: started },
      args.signal,
    );
  let calls = 0;
  const outcome = await runAgent(deps, {
    repo: args.repo,
    graph: args.graph,
    runId,
    agent: args.agent,
    kickoff: {},
    hooks: { onStart: () => (calls += 1), onFinish: () => {} },
    emit: () => {},
    signal: args.signal,
  });
  const mustFix = outcome.result?.mustFix ?? [];
  const { precision, recall } = score(outcome.result === null ? null : mustFix, args.labelled);
  return {
    agent: args.agent,
    runId,
    status: outcome.status,
    unverified: outcome.unverified,
    result: outcome.result !== null,
    mustFix: [...mustFix],
    precision,
    recall,
    upgrades: outcome.result?.upgrades.length ?? 0,
    calls,
    tokensIn: outcome.tokens.input,
    tokensOut: outcome.tokens.output,
    ms: deps.clock.now() - started,
  };
}
