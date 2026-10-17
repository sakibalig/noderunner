import { z } from "zod";
import { Decision, Finding, FindingStatus, SemverJump, Severity, Tier, Upgrade } from "./domain.ts";
import { Agent } from "./events.ts";
import { EvEdge, Evidence, EvNode } from "./evidence.ts";
import { FindingKey, JobId, PlanId, RunId, Sha, StepId, segment } from "./ids.ts";
import { Json } from "./json.ts";
import { limits } from "./limits.ts";

export const RepoId = z
  .string()
  .regex(/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/)
  .describe("A repository id, owner/name");
export type RepoId = z.infer<typeof RepoId>;

/** POST /repos. */
export const RepoCreate = z.object({
  url: z
    .url()
    .regex(/^https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/?$/)
    .describe("A public GitHub repository URL"),
  sha: Sha.optional().describe("The commit to ingest; the default branch head when absent"),
});
export type RepoCreate = z.infer<typeof RepoCreate>;

/** 202 from POST /repos. */
export const RepoAccepted = z.object({ repoId: RepoId, jobId: JobId });
export type RepoAccepted = z.infer<typeof RepoAccepted>;

const Counts = z.object({
  files: z.number().int().nonnegative(),
  installs: z.number().int().nonnegative(),
  vulns: z.number().int().nonnegative(),
  findings: z.number().int().nonnegative(),
  people: z.number().int().nonnegative(),
});

/** GET /repos. */
export const RepoList = z.object({
  repos: z.array(
    z.object({
      repoId: RepoId,
      sha: Sha,
      ingestedAt: z.number().int().describe("Epoch milliseconds"),
      counts: Counts,
    }),
  ),
});
export type RepoList = z.infer<typeof RepoList>;

/** The four bars on the repository page. */
export const Funnel = z.object({
  total: z.number().int().nonnegative().describe("All alerts"),
  production: z.number().int().nonnegative().describe("Alerts in the production tree"),
  reachable: z.number().int().nonnegative().describe("Import-reachable alerts"),
  open: z.number().int().nonnegative().describe("Import-reachable alerts still open after the latest plan"),
});
export type Funnel = z.infer<typeof Funnel>;

/** A run as listed on the repository page. */
export const RunBrief = z.object({
  runId: RunId,
  agent: Agent,
  status: z.enum(["running", "done", "failed", "capped"]),
  startedAt: z.number().int().describe("Epoch milliseconds"),
});
export type RunBrief = z.infer<typeof RunBrief>;

/** GET /repos/:owner/:name/summary. */
export const RepoSummary = z.object({ funnel: Funnel, counts: Counts, lastRun: RunBrief.nullable() });
export type RepoSummary = z.infer<typeof RepoSummary>;

/** Query of GET /repos/:owner/:name/findings. */
export const FindingQuery = z.object({ tier: Tier.optional(), status: FindingStatus.optional() });
export type FindingQuery = z.infer<typeof FindingQuery>;

/** GET /repos/:owner/:name/findings. */
export const FindingList = z.object({ findings: z.array(Finding) });
export type FindingList = z.infer<typeof FindingList>;

/** GET /repos/:owner/:name/findings/:key. */
export const FindingDetail = z.object({
  finding: Finding,
  vuln: z.object({
    id: z.string(),
    aliases: z.array(z.string()),
    severity: Severity,
    summary: z.string().describe("Advisory text; untrusted, rendered as plain text"),
    modified: z.number().int(),
  }),
  path: Evidence.nullable().describe("The shortest path from a production file, or null when not reachable"),
  decisions: z.array(Decision).describe("Newest first"),
});
export type FindingDetail = z.infer<typeof FindingDetail>;

/** Query of GET /repos/:owner/:name/subgraph. */
export const SubgraphQuery = z.object({
  keys: z
    .string()
    .min(1)
    .transform((raw) => raw.split(","))
    .describe("Comma-separated stable node keys"),
  hops: z.coerce.number().int().min(0).max(1).default(1),
});
export type SubgraphQuery = z.infer<typeof SubgraphQuery>;

/** GET /repos/:owner/:name/subgraph. */
export const Subgraph = z.object({
  nodes: z.array(EvNode).max(limits.subgraphNodes),
  edges: z.array(EvEdge),
});
export type Subgraph = z.infer<typeof Subgraph>;

/** POST /runs. */
export const RunCreate = z.object({
  repoId: RepoId,
  agent: z.enum(["triage", "fixer", "baseline"]),
  message: z.string().max(2000).optional().describe("An optional instruction from the user"),
});
export type RunCreate = z.infer<typeof RunCreate>;

/** 202 from POST /runs. */
export const RunAccepted = z.object({ runId: RunId });
export type RunAccepted = z.infer<typeof RunAccepted>;

/** A plan as shown in the run view. */
export const PlanView = z.object({
  planId: PlanId,
  upgrades: z.array(Upgrade),
  uncovered: z.array(FindingKey),
  totalCost: z.number().int().nonnegative(),
  approved: z.boolean(),
  shipped: z.url().nullable().describe("The pull request URL once shipped"),
});
export type PlanView = z.infer<typeof PlanView>;

/** GET /runs/:id. */
export const RunView = z.object({
  run: RunBrief.extend({
    model: z.string().nullable(),
    finishedAt: z.number().int().nullable(),
    unverified: z.boolean(),
  }),
  steps: z.array(
    z.object({
      stepId: StepId,
      seq: z.number().int().positive(),
      tool: z.string(),
      input: Json,
      ok: z.boolean(),
      summary: z.string(),
      cypher: z.array(z.string()),
      ms: z.number().nonnegative(),
    }),
  ),
  report: z.string(),
  plan: PlanView.optional(),
});
export type RunView = z.infer<typeof RunView>;

/** POST /plans/:id/approve. */
export const PlanApprove = z.object({ by: z.string().regex(segment).describe("The approver's handle") });
export type PlanApprove = z.infer<typeof PlanApprove>;

/** 202 from POST /plans/:id/ship. */
export const ShipAccepted = z.object({ jobId: JobId });
export type ShipAccepted = z.infer<typeof ShipAccepted>;

/** POST /decisions. */
export const DecisionCreate = z.object({
  repoId: RepoId,
  key: FindingKey,
  kind: z.enum(["waive", "accept", "reject"]),
  reason: z.string().min(1).max(2000),
  expiresInDays: z.number().int().positive().max(365).optional(),
  by: z.string().regex(segment).describe("The decider's handle"),
});
export type DecisionCreate = z.infer<typeof DecisionCreate>;

/** GET /healthz. */
export const Health = z.object({ ok: z.boolean(), falkordb: z.boolean(), model: z.boolean() });
export type Health = z.infer<typeof Health>;

/** One upgrade of a plan, with the path behind each finding it closes. */
export const DraftUpgrade = z.object({
  kind: z.enum(["refresh", "bump", "override"]),
  package: z.string(),
  from: z.string(),
  to: z.string(),
  jump: SemverJump,
  cost: z.number(),
  closes: z.array(
    z.object({
      key: FindingKey,
      severity: Severity,
      tier: Tier.nullable(),
      file: z.string().nullable().describe("The production file the shortest path starts from; null if none"),
      chain: z.array(z.string()).describe("name@version steps from the loaded install to the vulnerable one"),
    }),
  ),
  reviewers: z.array(z.object({ handle: z.string(), why: z.string() })),
});
export type DraftUpgrade = z.infer<typeof DraftUpgrade>;

/** A plan as a pull request would carry it. */
export const PlanDraft = z.object({
  planId: PlanId,
  runId: RunId,
  repoId: RepoId,
  approved: z.boolean(),
  totalCost: z.number(),
  uncovered: z.array(z.string()),
  upgrades: z.array(DraftUpgrade),
  title: z.string(),
  body: z.string().describe("Markdown"),
});
export type PlanDraft = z.infer<typeof PlanDraft>;
