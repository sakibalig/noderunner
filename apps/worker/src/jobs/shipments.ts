import type { GraphName, PlanId, RunEvent } from "@noderunner/core";

/** Where a plan lives and whether it may ship; the graph and the open_pull_request tool behind it in production. */
export interface Shipments {
  /** Null when no repository graph holds the plan. */
  locate(
    planId: string,
    signal: AbortSignal,
  ): Promise<{
    readonly graph: GraphName;
    readonly approved: boolean;
    readonly shipped: string | null;
  } | null>;
  /** Calls open_pull_request in a short `ui` run, emitting its steps and the shipment's outcome. */
  ship(graph: GraphName, planId: PlanId, emit: (event: RunEvent) => void, signal: AbortSignal): Promise<void>;
}
