import type { Clock, Db, PlanDraft } from "@noderunner/core";
import { draft } from "@noderunner/executor";
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
      if (row !== undefined) return draft(g, name.slice("repo:".length), row.planId, signal);
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
}
