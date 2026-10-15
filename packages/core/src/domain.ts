import { z } from "zod";
import { DecisionId, FindingKey, GraphName, LockPath, Sha } from "./ids.ts";

export const Tier = z
  .enum(["import-reachable", "installed", "dev-only"])
  .describe("import-reachable: loaded from production code; installed: in the production tree; dev-only");
export type Tier = z.infer<typeof Tier>;

export const Severity = z
  .enum(["critical", "high", "moderate", "low", "unknown"])
  .describe("Advisory severity");
export type Severity = z.infer<typeof Severity>;

const ranks: Readonly<Record<Severity, 0 | 1 | 2 | 3 | 4>> = {
  critical: 4,
  high: 3,
  moderate: 2,
  low: 1,
  unknown: 0,
};

export function rank(severity: Severity): 0 | 1 | 2 | 3 | 4 {
  return ranks[severity];
}

export const FindingStatus = z.enum(["open", "planned", "fixed", "waived"]).describe("Finding status");
export type FindingStatus = z.infer<typeof FindingStatus>;

export const Finding = z.object({
  key: FindingKey.describe("The finding key"),
  vulnId: z.string().min(1).describe("The OSV id"),
  package: z.string().min(1).describe("The affected package name"),
  installs: z.array(LockPath).describe("Every affected install at the current snapshot"),
  severity: Severity.describe("The advisory's severity"),
  tier: Tier.nullable().describe("The tier; null until reachability has run"),
  status: FindingStatus.describe("The finding's status"),
});
export type Finding = z.infer<typeof Finding>;

export const SemverJump = z.enum(["patch", "minor", "major"]).describe("The size of the version change");
export type SemverJump = z.infer<typeof SemverJump>;

export const Upgrade = z.object({
  id: z.string().min(1).describe("The upgrade id"),
  kind: z.enum(["refresh", "bump", "override"]).describe("Lockfile refresh, direct bump, or overrides pin"),
  package: z.string().min(1).describe("The package changed"),
  from: z.string().min(1).describe("The version or range before"),
  to: z.string().min(1).describe("The version or range after"),
  semverJump: SemverJump,
  cost: z
    .number()
    .int()
    .positive()
    .describe("The planner's cost: 1 refresh, 2 minor bump, 4 override, 5 major bump"),
  closes: z.array(FindingKey).describe("The findings this upgrade is expected to close"),
});
export type Upgrade = z.infer<typeof Upgrade>;

export const StaleReason = z
  .enum(["expired", "now reachable", "advisory updated", "worse vulnerability on same install"])
  .describe("Why a decision went stale");
export type StaleReason = z.infer<typeof StaleReason>;

export const Decision = z.object({
  id: DecisionId,
  key: FindingKey.describe("The finding decided on"),
  kind: z.enum(["waive", "accept", "reject"]).describe("The decision"),
  reason: z.string().min(1).max(2000).describe("Why, in the decider's words"),
  by: z.string().min(1).describe("The handle of the person who decided"),
  createdAt: z.number().int().describe("Epoch milliseconds"),
  expiresAt: z.number().int().nullable().describe("Epoch milliseconds, or null for no expiry"),
  tierAtDecision: Tier.nullable().describe("The finding's tier when decided; null if not yet tiered"),
  staleReason: StaleReason.nullable().describe("Why the decision is stale, or null while it holds"),
});
export type Decision = z.infer<typeof Decision>;

export type StaleFacts = {
  readonly decision: Pick<Decision, "kind" | "createdAt" | "expiresAt" | "tierAtDecision">;
  readonly tier: Tier | null;
  readonly advisoryModified: number;
  readonly severity: Severity;
  readonly others: readonly Severity[];
};

/** Why a waiver no longer holds, or null; the first matching rule wins. */
export function staleness(facts: StaleFacts, now: number): StaleReason | null {
  const { decision } = facts;
  if (decision.kind !== "waive") return null;
  if (decision.expiresAt !== null && decision.expiresAt < now) return "expired";
  if (facts.tier === "import-reachable" && decision.tierAtDecision !== "import-reachable")
    return "now reachable";
  if (facts.advisoryModified > decision.createdAt) return "advisory updated";
  if (facts.others.some((other) => rank(other) > rank(facts.severity)))
    return "worse vulnerability on same install";
  return null;
}

/** The outcome of re-tiering a regenerated lockfile. */
export const Verification = z.object({
  targeted: z.number().int().nonnegative().describe("Findings the plan claimed to close"),
  closed: z.number().int().nonnegative().describe("Targeted findings with no affected install afterwards"),
  stillOpen: z.array(FindingKey).describe("Targeted findings still affected"),
  newFindings: z.array(FindingKey).describe("Findings that appear only after the change"),
});
export type Verification = z.infer<typeof Verification>;

export const Stage = z
  .enum(["fetch", "lockfile", "imports", "advisories", "people", "prune"])
  .describe("Stage");
export type Stage = z.infer<typeof Stage>;

export const Warning = z.object({
  code: z.enum(["parse", "unresolved", "alias", "skipped", "range", "people"]).describe("What went wrong"),
  count: z.number().int().positive().describe("How many times"),
  sample: z.array(z.string()).max(5).describe("At most five example paths or names"),
});
export type Warning = z.infer<typeof Warning>;

export const IngestReport = z.object({
  graph: GraphName,
  sha: Sha,
  counts: z
    .object({
      files: z.number().int().nonnegative(),
      installs: z.number().int().nonnegative(),
      vulns: z.number().int().nonnegative(),
      findings: z.number().int().nonnegative(),
      people: z.number().int().nonnegative(),
    })
    .describe("Nodes written"),
  warnings: z.array(Warning).describe("Grouped warnings"),
  ms: z.record(Stage, z.number().nonnegative()).describe("Milliseconds per stage"),
});
export type IngestReport = z.infer<typeof IngestReport>;
