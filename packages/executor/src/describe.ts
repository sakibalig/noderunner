import type { PlanDraft, Tier, Verification } from "@noderunner/core";

export type Describable = Omit<PlanDraft, "title" | "body">;

type Closed = PlanDraft["upgrades"][number]["closes"][number];

const risk: Readonly<Record<PlanDraft["upgrades"][number]["kind"], string>> = {
  refresh: "lockfile only",
  bump: "version bump",
  override: "override (workaround)",
};

const severities = ["critical", "high", "moderate", "low", "unknown"] as const;

const tiers: Readonly<Record<Tier, string>> = {
  "import-reachable": "reachable from production code",
  installed: "in the production tree, not loaded by production code",
  "dev-only": "in development dependencies only",
};

/** Inline code that cannot be broken out of; also keeps `@scope/pkg` and handles from becoming GitHub mentions. */
function code(text: string): string {
  return `\`${text.replaceAll("`", "'")}\``;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

const BODY_CHARS = 60_000;

/** The verification section: pending until the regenerated lockfile has been re-ingested. */
function checked(v: Verification | undefined): string[] {
  if (v === undefined)
    return [
      "Pending: before this pull request opens, the regenerated lockfile is re-ingested and every targeted alert is re-checked.",
    ];
  return [
    `Re-ingested the regenerated lockfile and re-tiered every alert: **${v.closed} of ${v.targeted}** targeted alerts closed.`,
    ...(v.stillOpen.length > 0 ? ["", "Still open:", ...v.stillOpen.map((k) => `- ${code(k)}`)] : []),
    "",
    v.newFindings.length === 0
      ? "No new alerts."
      : `${plural(v.newFindings.length, "new alert", "new alerts")}, none reachable from production code: ${v.newFindings.map(code).join(", ")}`,
  ];
}

/** The pull request title and Markdown body for a plan, following the LLD's template; pure. */
export function describe(
  plan: Describable,
  verification?: Verification,
): { readonly title: string; readonly body: string } {
  const owners = new Map<string, string[]>();
  const first = new Map<string, Closed>();
  for (const u of plan.upgrades)
    for (const f of u.closes) {
      owners.set(f.key, [...(owners.get(f.key) ?? []), u.package]);
      if (!first.has(f.key)) first.set(f.key, f);
    }
  const findings = [...first.values()];
  const reachable = findings.filter((f) => f.tier === "import-reachable").length;
  const what = plural(findings.length, "vulnerability", "vulnerabilities");
  const title =
    reachable === findings.length && findings.length > 0
      ? `Noderunner: close ${plural(reachable, "reachable vulnerability", "reachable vulnerabilities")} in ${plan.repoId}`
      : `Noderunner: close ${what} in ${plan.repoId} (${reachable} reachable)`;

  if (plan.upgrades.length === 0) {
    const uncovered = plan.uncovered.map((k) => `- ${code(k)}`);
    const body = [
      "## Noderunner: no upgrade found",
      "",
      "The planner found no upgrade that closes these findings; they need a manual fix.",
      "",
      ...uncovered,
    ].join("\n");
    return { title: `Noderunner: no upgrade found in ${plan.repoId}`, body };
  }

  const table = [
    "| Upgrade | Kind | Closes | Risk |",
    "| --- | --- | --- | --- |",
    ...plan.upgrades.map(
      (u) =>
        `| ${code(u.package)} ${u.from} → ${u.to} | ${risk[u.kind]} | ${u.closes.length} | ${u.jump}${u.jump === "major" ? ", possibly breaking" : ""} |`,
    ),
  ];
  const shared = findings.filter((f) => (owners.get(f.key)?.length ?? 0) > 1).length;

  const why = [...findings]
    .sort((a, b) => severities.indexOf(a.severity) - severities.indexOf(b.severity))
    .map((f) => {
      const [vuln, pkg] = f.key.split("|");
      const path =
        f.file === null ? "no production path recorded" : [f.file, ...f.chain].map(code).join(" → ");
      const tier = f.tier === null ? "not yet tiered" : tiers[f.tier];
      const by = owners.get(f.key) ?? [];
      const joint = by.length > 1 ? `; closed only by ${by.map(code).join(" and ")} together` : "";
      return `- **${vuln}** (${f.severity}) in ${code(pkg ?? "")}, ${tier}: ${path}${joint}`;
    });

  const reviewers = [...new Set(plan.upgrades.flatMap((u) => u.reviewers.map((r) => r.handle)))];
  const body = [
    `## Noderunner: close ${what}`,
    "",
    ...table,
    ...(shared > 0
      ? ["", `${plural(shared, "alert needs", "alerts need")} more than one upgrade; see below.`]
      : []),
    "",
    "### Why these alerts matter",
    "",
    "Each path is the graph's shortest chain from a production file to the vulnerable install.",
    "",
    ...why,
    "",
    "### Verification",
    "",
    ...checked(verification),
    "",
    ...(plan.uncovered.length > 0
      ? ["### Not covered", "", ...plan.uncovered.map((k) => `- ${code(k)}`), ""]
      : []),
    reviewers.length > 0
      ? `Suggested reviewers, from CODEOWNERS and recent history: ${reviewers.map(code).join(", ")}`
      : "No reviewers found in CODEOWNERS or recent history.",
  ].join("\n");
  return { title, body: body.length > BODY_CHARS ? `${body.slice(0, BODY_CHARS)}\n\n…truncated` : body };
}
