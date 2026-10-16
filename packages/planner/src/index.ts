import {
  type Clock,
  type FindingKey,
  type G,
  type Ids,
  PlanId,
  type Registry,
  type RunId,
  type Tier,
  type Upgrade,
} from "@noderunner/core";
import { tools } from "@noderunner/graph/cypher";
import { PlannerError } from "./errors.ts";
import { prefetch } from "./fetch.ts";
import type { Majors } from "./solve/candidates.ts";
import { solve } from "./solve/cover.ts";
import { load } from "./targets.ts";

export { npm } from "./adapters/npm.ts";
export { type PlannerCode, PlannerError } from "./errors.ts";
export { BUDGET, prefetch } from "./fetch.ts";
export {
  type Candidate,
  type Chain,
  candidates,
  type Majors,
  resolves,
  type Target,
} from "./solve/candidates.ts";
export { merge, type Solution, solve } from "./solve/cover.ts";
export { compare, jump } from "./solve/jump.ts";
export { load } from "./targets.ts";

export type PlanInput = { readonly runId: RunId; readonly tiers: readonly Tier[]; readonly majors: Majors };
export type PlanDeps = { readonly registry: Registry; readonly ids: Ids; readonly clock: Clock };
export type PlanResult = {
  readonly planId: PlanId;
  readonly upgrades: readonly Upgrade[];
  readonly uncovered: readonly FindingKey[];
  readonly totalCost: number;
  readonly unavailable: readonly string[];
};

/** Plans the cheapest upgrades for the findings in the given tiers and writes the plan, unapproved. */
export async function plan(g: G, input: PlanInput, deps: PlanDeps, signal: AbortSignal): Promise<PlanResult> {
  const [run] = await g.query(tools.plan.run, { runId: input.runId }, signal);
  if ((run?.n ?? 0) === 0) throw new PlannerError("planner.run", "Unknown run");
  const [counts] = await g.query(tools.plan.tiered, {}, signal);
  if (counts !== undefined && counts.total > 0 && counts.tiered === 0) {
    throw new PlannerError("planner.untiered", "Call reachability before plan_upgrades");
  }
  const targets = await load(g, input.tiers, signal);
  const { packuments, unavailable } = await prefetch(targets, deps.registry, signal);
  const solution = solve(targets, packuments, input.majors);
  const planId = PlanId.parse(deps.ids.next());
  const upgrades: Upgrade[] = solution.upgrades.map((u) => ({ ...u, id: deps.ids.next() }));
  await g.query(
    tools.plan.save,
    {
      runId: input.runId,
      planId,
      now: deps.clock.now(),
      totalCost: solution.totalCost,
      uncovered: [...solution.uncovered],
      upgrades: upgrades.map((u) => ({ ...u, closes: [...u.closes] })),
    },
    signal,
  );
  return { planId, upgrades, uncovered: solution.uncovered, totalCost: solution.totalCost, unavailable };
}
