import { type Db, Finding, limits, rank, Severity, type ToolDef, type ToolOutput } from "@noderunner/core";
import { tools } from "@noderunner/graph/cypher";
import { z } from "zod";
import { Collector } from "../evidence.ts";

const { alerts } = tools;

const Input = z
  .object({ minSeverity: Severity.optional().describe("Leave out findings below this severity") })
  .strict();

export type Data = {
  readonly total: number;
  readonly bySeverity: Readonly<Record<Severity, number>>;
  readonly findings: readonly Finding[];
};

/** Lists open findings, most severe first, and records that the run saw them. */
export function listAlerts(deps: { readonly db: Db }): ToolDef<typeof Input, Data> {
  return {
    name: "list_alerts",
    description:
      "Lists every finding that is not fixed, most severe first, with up to five affected installs each. " +
      `Returns the total, a count per severity, and the ${limits.alertRows} most severe findings.`,
    input: Input,
    access: "derive",
    timeoutMs: limits.toolMs,
    async run(ctx, input): Promise<ToolOutput<Data>> {
      const g = deps.db.graph(ctx.graph);
      const minRank = input.minSeverity === undefined ? 0 : rank(input.minSeverity);
      const rows = await g.query(alerts.list, { minRank }, ctx.signal);
      const shown = rows.slice(0, limits.alertRows);
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
      const findings = shown.map((row) =>
        Finding.parse({
          key: row.key,
          vulnId: row.vulnId,
          package: row.package,
          installs: row.installs,
          severity: row.severity,
          tier: row.tier,
          status: row.status,
        }),
      );
      const more = rows.length - shown.length;
      return {
        data: { total: rows.length, bySeverity, findings },
        summary:
          `${rows.length} open findings: ${bySeverity.critical} critical, ${bySeverity.high} high, ` +
          `${bySeverity.moderate} moderate, ${bySeverity.low} low, ${bySeverity.unknown} unknown` +
          (more > 0 ? `; the ${shown.length} most severe listed` : ""),
        evidence: evidence.done(),
      };
    },
  };
}
