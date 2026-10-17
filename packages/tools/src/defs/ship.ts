import {
  type GraphName,
  limits,
  PlanId,
  type RunId,
  type Shipment,
  type ToolDef,
  type ToolOutput,
} from "@noderunner/core";
import { z } from "zod";
import { Collector } from "../evidence.ts";

const Input = z.object({ planId: z.string().min(1).describe("The approved plan to open") }).strict();

/** The executor's ship use case, injected by the composition root. */
export type Ship = (
  req: { readonly graph: GraphName; readonly runId: RunId; readonly planId: PlanId },
  opts: { readonly signal: AbortSignal; readonly onProgress: () => void },
) => Promise<Shipment>;

/** Opens an approved plan as a pull request; the executor holds every refusal check and the verification. */
export function openPullRequest(deps: { readonly ship: Ship }): ToolDef<typeof Input, Shipment> {
  return {
    name: "open_pull_request",
    description:
      "Opens an approved plan as a pull request on the team's fork. Regenerates the lockfile, re-ingests and " +
      "re-tiers it first, and refuses when the change would make a new alert reachable. Fails unless a person " +
      "approved the plan, and when it already has a pull request.",
    input: Input,
    access: "act",
    timeoutMs: limits.shipMs,
    async run(ctx, input): Promise<ToolOutput<Shipment>> {
      const planId = PlanId.parse(input.planId);
      const shipment = await deps.ship(
        { graph: ctx.graph, runId: ctx.runId, planId },
        { signal: ctx.signal, onProgress: () => {} },
      );
      const { verification: v } = shipment;
      return {
        data: shipment,
        summary:
          shipment.outcome === "opened"
            ? `Opened ${shipment.url}: ${v.closed} of ${v.targeted} targeted alerts closed`
            : `Refused: ${v.newFindings.length} new alerts, at least one reachable from production code`,
        evidence: new Collector().done(),
      };
    },
  };
}
