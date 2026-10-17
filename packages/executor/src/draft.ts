import {
  type DraftUpgrade,
  FindingKey,
  type G,
  PlanDraft,
  Severity,
  Tier,
  type Verification,
} from "@noderunner/core";
import { api } from "@noderunner/graph/cypher";
import { describe } from "./describe.ts";

/** The plan as the pull request would carry it, with the production path behind every finding it closes. */
export async function draft(
  g: G,
  repoId: string,
  planId: string,
  signal: AbortSignal,
  verification?: Verification,
): Promise<PlanDraft | null> {
  const [head] = await g.query(api.plans.header, { planId }, signal);
  if (head === undefined) return null;
  const rows = await g.query(api.plans.detail, { planId }, signal);
  const paths = new Map((await g.query(api.plans.paths, { planId }, signal)).map((p) => [p.key, p]));
  const upgrades: DraftUpgrade[] = rows.map((row) => ({
    kind: row.kind,
    package: row.package,
    from: row.from,
    to: row.to,
    jump: row.jump,
    cost: row.cost,
    closes: row.closes.flatMap((c) => {
      if (c.key === null) return [];
      const path = paths.get(c.key);
      const severity = Severity.safeParse(c.severity);
      const tier = Tier.safeParse(c.tier);
      return [
        {
          key: FindingKey.parse(c.key),
          severity: severity.success ? severity.data : "unknown",
          tier: tier.success ? tier.data : null,
          file: path?.file ?? null,
          chain: path?.chain ?? [],
        },
      ];
    }),
    reviewers: row.reviewers.flatMap((r) =>
      r.handle === null ? [] : [{ handle: r.handle, why: r.why ?? "" }],
    ),
  }));
  const base = {
    planId,
    runId: head.runId,
    repoId,
    approved: head.approved === true,
    shipped: head.shipped,
    totalCost: head.totalCost,
    uncovered: head.uncovered ?? [],
    upgrades,
  };
  const plan = PlanDraft.omit({ title: true, body: true }).parse(base);
  return PlanDraft.parse({ ...base, ...describe(plan, verification) });
}
