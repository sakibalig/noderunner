import {
  type Clock,
  type Db,
  type Ids,
  limits,
  PlanId,
  type Registry,
  Tier,
  type ToolDef,
  type ToolOutput,
  type Upgrade,
} from "@noderunner/core";
import { tools } from "@noderunner/graph/cypher";
import { plan } from "@noderunner/planner";
import { z } from "zod";
import { Collector } from "../evidence.ts";

const Input = z
  .object({
    tiers: z.array(Tier).min(1).describe('Which tiers to plan for, usually ["import-reachable"]'),
    allowMajor: z.boolean().default(false).describe("Whether a major version bump may be proposed"),
  })
  .strict();

export type Data = {
  readonly planId: string;
  readonly upgrades: readonly Upgrade[];
  readonly uncovered: readonly string[];
  readonly totalCost: number;
};

/** Plans the cheapest upgrades for the findings in the given tiers; the planner decides, never the model. */
export function planUpgrades(deps: {
  readonly db: Db;
  readonly clock: Clock;
  readonly ids: Ids;
  readonly registry: Registry;
}): ToolDef<typeof Input, Data> {
  return {
    name: "plan_upgrades",
    description:
      "Proposes the cheapest set of upgrades that closes the open findings in the given tiers, and saves it as an " +
      "unapproved plan. refresh (cost 1) updates the lockfile within declared ranges; bump (2, or 5 when major) " +
      "raises a direct dependency; override (4) pins a fixed version as a workaround. Call reachability first.",
    input: Input,
    access: "derive",
    timeoutMs: limits.toolMs,
    async run(ctx, input): Promise<ToolOutput<Data>> {
      const g = deps.db.graph(ctx.graph);
      const result = await plan(
        g,
        { runId: ctx.runId, tiers: input.tiers, majors: input.allowMajor ? "allow" : "skip" },
        { registry: deps.registry, ids: deps.ids, clock: deps.clock },
        ctx.signal,
      );
      const rows = await g.query(tools.plan.read, { planId: result.planId }, ctx.signal);
      const evidence = new Collector()
        .ran(tools.plan.targets.text)
        .ran(tools.plan.chains.text)
        .ran(tools.plan.save.text)
        .ran(tools.plan.read.text);
      for (const row of rows) {
        evidence.node({ id: row.planNode, key: result.planId, label: "Plan", name: "plan" });
        const upgrade = result.upgrades.find((u) => u.id === row.upgrade);
        const name = upgrade === undefined ? row.upgrade : `${upgrade.kind} ${upgrade.package} ${upgrade.to}`;
        evidence.node({ id: row.upgradeNode, key: row.upgrade, label: "Upgrade", name });
        evidence.edge({
          id: row.includesId,
          type: "INCLUDES",
          from: row.planNode,
          to: row.upgradeNode,
          fromKey: result.planId,
          toKey: row.upgrade,
        });
        for (const close of row.closes) {
          if (close.key === null || close.node === null || close.edge === null) continue;
          evidence.node({ id: close.node, key: close.key, label: "Finding", name: close.key });
          evidence.edge({
            id: close.edge,
            type: "CLOSES",
            from: row.upgradeNode,
            to: close.node,
            fromKey: row.upgrade,
            toKey: close.key,
          });
        }
      }
      const closed = new Set(result.upgrades.flatMap((u) => u.closes)).size;
      return {
        data: {
          planId: PlanId.parse(result.planId),
          upgrades: result.upgrades,
          uncovered: result.uncovered,
          totalCost: result.totalCost,
        },
        summary:
          `${result.upgrades.length} upgrade${result.upgrades.length === 1 ? "" : "s"} close${result.upgrades.length === 1 ? "s" : ""} ${closed} finding${closed === 1 ? "" : "s"} at cost ${result.totalCost}` +
          (result.uncovered.length > 0 ? `; ${result.uncovered.length} left open` : "") +
          (result.unavailable.length > 0
            ? `; npm could not give ${result.unavailable.slice(0, 3).join(", ")}`
            : ""),
        evidence: evidence.done(),
      };
    },
  };
}
