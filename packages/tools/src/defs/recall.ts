import {
  type Clock,
  type Db,
  Decision,
  limits,
  Severity,
  staleness,
  Tier,
  type ToolDef,
  type ToolOutput,
} from "@noderunner/core";
import { tools } from "@noderunner/graph/cypher";
import { z } from "zod";
import { Collector } from "../evidence.ts";
import { type Quoted, quoted } from "../quoted.ts";

const { decisions } = tools;

const Input = z
  .object({
    package: z.string().min(1).optional().describe("Only decisions on this package's findings"),
    vulnId: z.string().min(1).optional().describe("Only decisions on this advisory's findings"),
  })
  .strict();

/** A decision as the model sees it: the decider's reason is free text and is marked as data. */
export type Recalled = Omit<Decision, "reason"> & { readonly reason: Quoted };
export type Data = { readonly inForce: readonly Recalled[]; readonly stale: readonly Recalled[] };

function severity(text: string): Severity {
  const parsed = Severity.safeParse(text);
  return parsed.success ? parsed.data : "unknown";
}

function tier(text: string | null): Tier | null {
  const parsed = Tier.safeParse(text);
  return parsed.success ? parsed.data : null;
}

/** Lists the decisions in force and those gone stale; core's staleness rules decide, with the injected clock. */
export function recallDecisions(deps: {
  readonly db: Db;
  readonly clock: Clock;
}): ToolDef<typeof Input, Data> {
  return {
    name: "recall_decisions",
    description:
      "Lists the decisions people have made on findings, split into those still in force and those gone stale, " +
      "with why: expired, now reachable, advisory updated, or a worse vulnerability on the same install. " +
      "A stale waiver must be raised, never silently respected.",
    input: Input,
    access: "derive",
    timeoutMs: limits.toolMs,
    async run(ctx, input): Promise<ToolOutput<Data>> {
      const g = deps.db.graph(ctx.graph);
      const now = deps.clock.now();
      const rows = await g.query(
        decisions.recall,
        { package: input.package ?? null, vulnId: input.vulnId ?? null },
        ctx.signal,
      );
      const evidence = new Collector().ran(decisions.recall.text).ran(decisions.stale.text);
      const all = rows.map((row) => {
        const decision = Decision.parse({
          id: row.id,
          key: row.key,
          kind: row.kind,
          reason: row.reason,
          by: row.by ?? "unknown",
          createdAt: row.createdAt,
          expiresAt: row.expiresAt,
          tierAtDecision: tier(row.tierAtDecision),
          staleReason: null,
        });
        const staleReason = staleness(
          {
            decision,
            tier: tier(row.tier),
            advisoryModified: row.advisoryModified,
            severity: severity(row.severity),
            others: row.others.map(severity),
          },
          now,
        );
        evidence.node({ id: row.decisionNode, key: row.id, label: "Decision", name: row.kind });
        evidence.node({ id: row.findingNode, key: row.key, label: "Finding", name: row.key });
        return { ...decision, staleReason, reason: quoted(decision.reason) };
      });
      await g.batch(
        decisions.stale,
        all.map((d) => ({ id: d.id, reason: d.staleReason })),
        {},
        ctx.signal,
      );
      const inForce = all.filter((d) => d.staleReason === null);
      const stale = all.filter((d) => d.staleReason !== null);
      return {
        data: { inForce, stale },
        summary:
          `${all.length} decisions: ${inForce.length} in force, ${stale.length} stale` +
          (stale.length > 0 ? ` (${stale.map((d) => `${d.key}: ${d.staleReason}`).join("; ")})` : ""),
        evidence: evidence.done(),
      };
    },
  };
}
