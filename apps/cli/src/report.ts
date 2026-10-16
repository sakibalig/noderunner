import type { IngestReport, Severity, Tier, Upgrade } from "@noderunner/core";

export type Cited = { readonly tool: string; readonly stepId: string; readonly summary: string };

/** Everything the triage gathered, in the shape the report prints. */
export type Report = {
  readonly repo: string;
  readonly runId: string;
  readonly ingest: IngestReport;
  readonly ingestMs: number;
  readonly alerts: { readonly total: number; readonly bySeverity: Readonly<Record<Severity, number>> };
  readonly severities: ReadonlyMap<string, string>;
  readonly tiers: Readonly<Record<Tier, number>>;
  readonly reachable: readonly {
    readonly key: string;
    readonly files: readonly string[];
    readonly chain: readonly string[];
    readonly hops: number;
  }[];
  readonly origins: ReadonlyMap<string, readonly { readonly package: string; readonly range: string }[]>;
  readonly stale: readonly {
    readonly key: string;
    readonly kind: string;
    readonly staleReason: string | null;
  }[];
  readonly inForce: number;
  readonly plan: {
    readonly upgrades: readonly Upgrade[];
    readonly uncovered: readonly string[];
    readonly totalCost: number;
  } | null;
  readonly reviewers: ReadonlyMap<string, readonly { readonly handle: string; readonly why: string }[]>;
  readonly steps: readonly Cited[];
};

const n = (value: number) => value.toLocaleString("en-US");

/** The package a lock path installs: the part after its last `node_modules/`. */
export function pkg(lockPath: string): string {
  const at = lockPath.lastIndexOf("node_modules/");
  return at === -1 ? lockPath : lockPath.slice(at + "node_modules/".length);
}

function cite(steps: readonly Cited[], tool: string): string {
  const step = [...steps].reverse().find((s) => s.tool === tool);
  return step === undefined ? "" : `  [s:${step.stepId}]`;
}

/** Renders the triage as plain text; every section names the step it came from, stored in the graph. */
export function render(report: Report): string {
  const { ingest, alerts, tiers, steps } = report;
  const lines: string[] = [];
  const sev = alerts.bySeverity;
  lines.push(
    `${report.repo} @ ${ingest.sha.slice(0, 7)}`,
    `  ingested ${n(ingest.counts.files)} files, ${n(ingest.counts.installs)} installs, ` +
      `${n(ingest.counts.people)} people in ${(report.ingestMs / 1000).toFixed(1)} s`,
    "",
    "ALERTS",
    `  ${alerts.total} open: ${sev.critical} critical, ${sev.high} high, ${sev.moderate} moderate, ${sev.low} low${cite(steps, "list_alerts")}`,
    `  ${tiers["import-reachable"]} import-reachable, ${tiers.installed} installed only, ${tiers["dev-only"]} dev-only` +
      cite(steps, "reachability"),
    "",
  );

  lines.push(`REACHABLE FROM PRODUCTION CODE (${tiers["import-reachable"]})`);
  if (report.reachable.length === 0) lines.push("  None: no production file loads a vulnerable install.");
  for (const finding of report.reachable) {
    const [vulnId, name] = finding.key.split("|");
    const severity = report.severities.get(finding.key) ?? "";
    lines.push(`  ${vulnId}  ${name}${severity === "" ? "" : `  (${severity})`}`);
    lines.push(`    ${[finding.files[0] ?? "?", ...finding.chain.map(pkg)].join(" → ")}`);
    const origins = report.origins.get(finding.key) ?? [];
    if (origins.length > 0) {
      const named = origins.slice(0, 3).map((o) => `${o.package} (${o.range})`);
      const more = origins.length > 3 ? ` and ${origins.length - 3} more` : "";
      lines.push(`    comes in through ${named.join(", ")}${more}`);
    }
  }
  lines.push("");

  const { plan } = report;
  if (plan === null) {
    lines.push("PLAN", "  No plan: nothing import-reachable to fix.", "");
  } else {
    const closed = new Set(plan.upgrades.flatMap((u) => u.closes)).size;
    lines.push(
      `PLAN  ${plan.upgrades.length} upgrade${plan.upgrades.length === 1 ? "" : "s"}, cost ${plan.totalCost}, ` +
        `closes ${closed} of ${closed + plan.uncovered.length}${cite(steps, "plan_upgrades")}`,
    );
    plan.upgrades.forEach((u, i) => {
      const label = u.kind === "override" ? "override (workaround)" : u.kind;
      lines.push(
        `  ${i + 1}. ${label} ${u.package} ${u.from} → ${u.to}  ${u.semverJump}, closes ${u.closes.length}`,
      );
      for (const r of report.reviewers.get(u.id) ?? []) lines.push(`       review: ${r.handle}, ${r.why}`);
    });
    if (plan.uncovered.length > 0) lines.push(`  left open: ${plan.uncovered.join(", ")}`);
    lines.push("");
  }

  lines.push(`DECISIONS${cite(steps, "recall_decisions")}`);
  lines.push(`  ${report.inForce} in force, ${report.stale.length} stale`);
  for (const d of report.stale) lines.push(`  stale: ${d.kind} on ${d.key}, ${d.staleReason}`);
  lines.push("");

  lines.push(`STEPS  stored in the graph as Run ${report.runId}`);
  steps.forEach((s, i) => {
    lines.push(`  ${String(i + 1).padStart(2)}. ${s.tool.padEnd(17)} ${s.summary}`);
  });
  return `${lines.join("\n")}\n`;
}
