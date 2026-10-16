import {
  type Clock,
  type Db,
  DecisionId,
  type Ids,
  limits,
  type ToolDef,
  type ToolOutput,
} from "@noderunner/core";
import { tools } from "@noderunner/graph/cypher";
import { z } from "zod";
import { ToolError } from "../errors.ts";
import { Collector } from "../evidence.ts";

const { decisions } = tools;
const DAY_MS = 86_400_000;

const Input = z
  .object({
    key: z.string().min(1).describe("The finding key, <vulnId>|<package>"),
    kind: z
      .enum(["waive", "accept", "reject"])
      .describe("waive the finding, or accept or reject a proposed fix"),
    reason: z.string().min(1).max(500).describe("Why, in the decider's words"),
    expiresInDays: z.number().int().min(1).max(365).optional().describe("When the decision lapses"),
    by: z.string().min(1).max(100).describe("The handle of the person deciding, such as @alice"),
  })
  .strict();

export type Data = { readonly decisionId: string; readonly superseded?: string };

/** Records a human decision on a finding; a waive marks the finding waived. */
export function recordDecision(deps: {
  readonly db: Db;
  readonly clock: Clock;
  readonly ids: Ids;
}): ToolDef<typeof Input, Data> {
  return {
    name: "record_decision",
    description:
      "Records a person's decision on a finding: waive it, or accept or reject a fix, with a reason and an " +
      "optional expiry. It replaces the finding's previous decision, and a waive sets the finding to waived.",
    input: Input,
    access: "act",
    timeoutMs: limits.toolMs,
    async run(ctx, input): Promise<ToolOutput<Data>> {
      const g = deps.db.graph(ctx.graph);
      const now = deps.clock.now();
      const id = DecisionId.parse(deps.ids.next());
      const expiresAt = input.expiresInDays === undefined ? null : now + input.expiresInDays * DAY_MS;
      const [row] = await g.query(
        decisions.record,
        { key: input.key, id, kind: input.kind, reason: input.reason, now, expiresAt, by: input.by },
        ctx.signal,
      );
      if (row === undefined) throw new ToolError("tool.missing", `No finding has the key ${input.key}`);
      const evidence = new Collector()
        .ran(decisions.record.text)
        .node({ id: row.decisionNode, key: row.decisionId, label: "Decision", name: input.kind })
        .node({ id: row.findingNode, key: input.key, label: "Finding", name: input.key });
      if (row.superseded !== null) {
        await g.query(decisions.supersede, { id: row.decisionId, old: row.superseded }, ctx.signal);
        evidence.ran(decisions.supersede.text);
      }
      return {
        data:
          row.superseded === null
            ? { decisionId: row.decisionId }
            : { decisionId: row.decisionId, superseded: row.superseded },
        summary:
          `${input.by} recorded ${input.kind} on ${input.key}` +
          (row.superseded === null ? "" : `, replacing decision ${row.superseded}`),
        evidence: evidence.done(),
      };
    },
  };
}
