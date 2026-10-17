import {
  type Clock,
  type Db,
  type DraftUpgrade,
  FindingKey,
  type G,
  PlanDraft,
  Severity,
  Tier,
} from "@noderunner/core";
import { describe } from "@noderunner/executor";
import { api } from "@noderunner/graph/cypher";
import type { Plans } from "../jobs/plans.ts";

/** Reads plans from whichever repository graph holds them; FalkorDB queries do not span graphs. */
export class GraphPlans implements Plans {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  async forRun(runId: string, signal: AbortSignal): Promise<PlanDraft | null> {
    for (const name of await this.#repos()) {
      const g = this.db.graph(name);
      const [row] = await g.query(api.plans.ofRun, { runId }, signal);
      if (row !== undefined) return this.#draft(g, name.slice("repo:".length), row.planId, signal);
    }
    return null;
  }

  async approve(planId: string, by: string, signal: AbortSignal): Promise<boolean> {
    for (const name of await this.#repos()) {
      const rows = await this.db
        .graph(name)
        .query(api.plans.approve, { planId, by, now: this.clock.now() }, signal);
      if (rows.length > 0) return true;
    }
    return false;
  }

  async #repos() {
    return (await this.db.list()).filter((name) => name.startsWith("repo:"));
  }

  async #draft(g: G, repoId: string, planId: string, signal: AbortSignal): Promise<PlanDraft | null> {
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
      totalCost: head.totalCost,
      uncovered: head.uncovered ?? [],
      upgrades,
    };
    return PlanDraft.parse({ ...base, ...describe(PlanDraft.omit({ title: true, body: true }).parse(base)) });
  }
}
