import { type Db, Finding, limits, rank, Severity, type ToolDef, type ToolOutput } from "@noderunner/core";
import { tools } from "@noderunner/graph/cypher";
import { z } from "zod";
import { Collector } from "../evidence.ts";

const { alerts } = tools;

const Input = z
  .object({
    minSeverity: Severity.optional().describe("Leave out findings below this severity"),
    offset: z.number().int().min(0).optional().describe("Skip this many findings, to page through the list"),
  })
  .strict();

/** The baseline sees a finding without the graph's tier and status, which are the answers it is scored on. */
type Listed = Omit<Finding, "tier" | "status"> & Partial<Pick<Finding, "tier" | "status">>;

export type Data = {
  readonly total: number;
  readonly bySeverity: Readonly<Record<Severity, number>>;
  readonly from: number;
  readonly findings: readonly Listed[];
};

/** Leaves room in `limits.modelChars` for the result's envelope, so every listed row reaches the model. */
const PAGE_CHARS = limits.modelChars - 800;

/** Lists open findings, most severe first, and records that the run saw them. */
export function listAlerts(deps: { readonly db: Db }): ToolDef<typeof Input, Data> {
  return {
    name: "list_alerts",
    description:
      "Lists every finding that is not fixed, most severe first, with up to five affected installs each. " +
      `Returns the total, a count per severity, and a page of at most ${limits.alertRows} findings; call again ` +
      "with offset to see the next page.",
    input: Input,
    access: "derive",
    timeoutMs: limits.toolMs,
    async run(ctx, input): Promise<ToolOutput<Data>> {
      const g = deps.db.graph(ctx.graph);
      const minRank = input.minSeverity === undefined ? 0 : rank(input.minSeverity);
      const rows = await g.query(alerts.list, { minRank }, ctx.signal);
      const from = Math.min(input.offset ?? 0, rows.length);
      const listed = (row: (typeof rows)[number]): Listed => {
        const finding = Finding.parse({
          key: row.key,
          vulnId: row.vulnId,
          package: row.package,
          installs: row.installs,
          severity: row.severity,
          tier: row.tier,
          status: row.status,
        });
        if (ctx.actor !== "baseline") return finding;
        const { tier: _tier, status: _status, ...rest } = finding;
        return rest;
      };
      const findings: Listed[] = [];
      for (const row of rows.slice(from, from + limits.alertRows)) {
        const next = listed(row);
        if (findings.length > 0 && JSON.stringify([...findings, next]).length > PAGE_CHARS) break;
        findings.push(next);
      }
      const shown = rows.slice(from, from + findings.length);
      await g.batch(
        alerts.found,
        shown.map((row) => ({ key: row.key })),
        { runId: ctx.runId },
        ctx.signal,
      );

      const bySeverity: Record<Severity, number> = { critical: 0, high: 0, moderate: 0, low: 0, unknown: 0 };
      for (const row of rows) {
        const severity = Severity.safeParse(row.severity);
        bySeverity[severity.success ? severity.data : "unknown"] += 1;
      }
      const evidence = new Collector().ran(alerts.list.text).ran(alerts.found.text);
      for (const row of shown) {
        evidence.node({ id: row.findingId, key: row.key, label: "Finding", name: row.key });
        evidence.node({ id: row.vulnNode, key: row.vulnId, label: "Vuln", name: row.vulnId });
        evidence.edge({
          id: row.aboutId,
          type: "ABOUT",
          from: row.findingId,
          to: row.vulnNode,
          fromKey: row.key,
          toKey: row.vulnId,
        });
        row.installs.forEach((path, i) => {
          const id = row.installIds[i];
          const at = row.atIds[i];
          if (id === undefined) return;
          evidence.node({ id, key: path, label: "Install", name: path });
          if (at !== undefined) {
            evidence.edge({ id: at, type: "AT", from: row.findingId, to: id, fromKey: row.key, toKey: path });
          }
        });
      }
      const after = from + shown.length;
      return {
        data: { total: rows.length, bySeverity, from, findings },
        summary:
          `${rows.length} open findings: ${bySeverity.critical} critical, ${bySeverity.high} high, ` +
          `${bySeverity.moderate} moderate, ${bySeverity.low} low, ${bySeverity.unknown} unknown` +
          (shown.length === 0 && rows.length > 0
            ? `; none listed past offset ${from}`
            : shown.length < rows.length
              ? `; findings ${from + 1} to ${after} listed, most severe first` +
                (after < rows.length ? `; call again with offset ${after} for the rest` : "")
              : ""),
        evidence: evidence.done(),
      };
    },
  };
}
