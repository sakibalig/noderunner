import {
  type Clock,
  type Db,
  type ErrorCode,
  type GraphName,
  type Ids,
  type PlanId,
  type RunEvent,
  RunId,
  Shipment,
} from "@noderunner/core";
import { api, memory } from "@noderunner/graph/cypher";
import type { Toolbox } from "@noderunner/tools";
import type { Shipments } from "../jobs/shipments.ts";
import type { Log } from "../log.ts";

const refusals = new Set<ErrorCode>(["unapproved", "shipped", "busy"]);
const empty = { nodes: [], edges: [], cypher: [] };
const FINISH_MS = 10_000;

/** Ships through the same open_pull_request tool a fixer run would call, so every shipment is a traced run. */
export class GraphShipments implements Shipments {
  constructor(
    private readonly deps: {
      readonly db: Db;
      readonly clock: Clock;
      readonly ids: Ids;
      readonly toolbox: Toolbox;
      readonly log: Log;
    },
  ) {}

  async locate(planId: string, signal: AbortSignal) {
    for (const graph of await this.deps.db.list()) {
      if (!graph.startsWith("repo:")) continue;
      const [head] = await this.deps.db.graph(graph).query(api.plans.header, { planId }, signal);
      if (head !== undefined) return { graph, approved: head.approved === true, shipped: head.shipped };
    }
    return null;
  }

  async ship(
    graph: GraphName,
    planId: PlanId,
    emit: (event: RunEvent) => void,
    signal: AbortSignal,
  ): Promise<void> {
    const { db, clock, log } = this.deps;
    const g = db.graph(graph);
    const runId = RunId.parse(this.deps.ids.next());
    await g.query(memory.run.start, { id: runId, agent: "ui", model: null, now: clock.now() }, signal);
    let code: ErrorCode = "internal";
    const result = await this.deps.toolbox.callTool(
      "open_pull_request",
      { planId },
      { graph, runId, actor: "ui", signal },
      {
        onStart: (step) => emit({ type: "step.started", ...step }),
        onFinish: (step) => {
          if (step.code !== undefined) code = step.code;
          emit({
            type: "step.finished",
            stepId: step.stepId,
            ok: step.ok,
            summary: step.summary,
            evidence: step.evidence ?? empty,
            ms: step.ms,
          });
        },
      },
    );
    await g.query(
      memory.run.finish,
      {
        id: runId,
        status: result.ok ? "done" : "failed",
        report: result.ok ? result.summary : result.error,
        result: null,
        unverified: false,
        tokensIn: 0,
        tokensOut: 0,
        now: clock.now(),
      },
      // The run must not be left running because the job's deadline passed.
      AbortSignal.timeout(FINISH_MS),
    );
    if (!result.ok) {
      log.warn({ runId, planId, code }, "executor.ship.failed");
      emit(
        refusals.has(code)
          ? { type: "pr.refused", planId: planId, reason: result.error, verification: null }
          : { type: "job.failed", code, message: result.error },
      );
      return;
    }
    const shipment = Shipment.parse(result.data);
    log.info(
      { runId, planId, outcome: shipment.outcome },
      shipment.outcome === "opened" ? "executor.pr.opened" : "executor.pr.refused",
    );
    emit(
      shipment.outcome === "opened"
        ? { type: "pr.opened", planId: planId, url: shipment.url, verification: shipment.verification }
        : {
            type: "pr.refused",
            planId: planId,
            reason: shipment.reason,
            verification: shipment.verification,
          },
    );
  }
}
