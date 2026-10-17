import type { PlanDraft } from "@noderunner/core";

export type Describable = Omit<PlanDraft, "title" | "body">;

const risk: Readonly<Record<PlanDraft["upgrades"][number]["kind"], string>> = {
  refresh: "lockfile only",
  bump: "version bump",
  override: "override (workaround)",
};

const severities = ["critical", "high", "moderate", "low", "unknown"] as const;

/** The pull request title and Markdown body for a plan, following the LLD's template; pure. */
export function describe(plan: Describable): { readonly title: string; readonly body: string } {
  const findings = plan.upgrades.flatMap((u) => u.closes);
  const keys = new Set(findings.map((f) => f.key));
  const title = `Noderunner: close ${keys.size} reachable ${keys.size === 1 ? "vulnerability" : "vulnerabilities"} in ${plan.repoId}`;

  const table = [
    "| Upgrade | Kind | Closes | Risk |",
    "| --- | --- | --- | --- |",
    ...plan.upgrades.map(
      (u) =>
        `| \`${u.package}\` ${u.from} → ${u.to} | ${risk[u.kind]} | ${u.closes.length} | ${u.jump}${u.jump === "major" ? ", possibly breaking" : ""} |`,
    ),
  ];

  const seen = new Set<string>();
  const why: string[] = [];
  const ordered = [...findings].sort(
    (a, b) => severities.indexOf(a.severity) - severities.indexOf(b.severity),
  );
  for (const f of ordered) {
    if (seen.has(f.key)) continue;
    seen.add(f.key);
    const [vuln, pkg] = f.key.split("|");
    const path = f.file === null ? "no production path recorded" : `\`${f.file}\` → ${f.chain.join(" → ")}`;
    why.push(`- **${vuln}** (${f.severity}) in \`${pkg}\`: ${path}`);
  }

  const reviewers = [...new Set(plan.upgrades.flatMap((u) => u.reviewers.map((r) => r.handle)))];
  const body = [
    `## Noderunner: close ${keys.size} reachable ${keys.size === 1 ? "vulnerability" : "vulnerabilities"}`,
    "",
    ...table,
    "",
    "### Why these alerts matter",
    "",
    "Each alert below is reachable from production code; the path is the graph's shortest chain from a file to the vulnerable install.",
    "",
    ...why,
    "",
    "### Verification",
    "",
    "The regenerated lockfile is re-ingested and every targeted alert re-checked before this pull request opens.",
    "",
    ...(plan.uncovered.length > 0 ? [`### Not covered`, "", ...plan.uncovered.map((k) => `- ${k}`), ""] : []),
    reviewers.length > 0
      ? `Reviewers suggested from CODEOWNERS and recent history: ${reviewers.join(", ")}`
      : "No reviewers found in CODEOWNERS or recent history.",
  ].join("\n");
  return { title, body };
}
