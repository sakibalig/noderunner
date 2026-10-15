import { z } from "zod";

export const segment = /^[A-Za-z0-9._-]+$/;
const ulid = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export const GraphName = z
  .string()
  .regex(/^(repo:[a-z0-9._-]+\/[a-z0-9._-]+|verify:[0-9a-z]{26}|advisories)$/)
  .brand<"GraphName">()
  .describe("A FalkorDB graph name, bound by the server and never chosen by a caller");
export type GraphName = z.infer<typeof GraphName>;

export const FindingKey = z
  .string()
  .regex(/^[^|\s]+\|[^|\s]+$/)
  .brand<"FindingKey">()
  .describe("A finding key: the vulnerability id and the package name joined by a pipe");
export type FindingKey = z.infer<typeof FindingKey>;

export const LockPath = z
  .string()
  .regex(/^(?:[^\s/]+\/)*node_modules\/\S+$/)
  .brand<"LockPath">()
  .describe("An install path from package-lock.json");
export type LockPath = z.infer<typeof LockPath>;

export const Purl = z
  .string()
  .regex(/^pkg:npm\/\S+@\S+$/)
  .brand<"Purl">()
  .describe("An npm package URL");
export type Purl = z.infer<typeof Purl>;

export const Sha = z
  .string()
  .regex(/^[0-9a-f]{40}$/)
  .brand<"Sha">()
  .describe("A 40-character lowercase git commit id");
export type Sha = z.infer<typeof Sha>;

export const RunId = z.string().regex(ulid).brand<"RunId">().describe("A run id (ULID)");
export type RunId = z.infer<typeof RunId>;

export const StepId = z.string().regex(ulid).brand<"StepId">().describe("A step id (ULID)");
export type StepId = z.infer<typeof StepId>;

export const PlanId = z.string().regex(ulid).brand<"PlanId">().describe("A plan id (ULID)");
export type PlanId = z.infer<typeof PlanId>;

export const JobId = z.string().regex(ulid).brand<"JobId">().describe("A job id (ULID)");
export type JobId = z.infer<typeof JobId>;

export const DecisionId = z.string().regex(ulid).brand<"DecisionId">().describe("A decision id (ULID)");
export type DecisionId = z.infer<typeof DecisionId>;

export const RepoRef = z.object({
  owner: z.string().regex(segment).describe("The GitHub owner"),
  name: z.string().regex(segment).describe("The GitHub repository name"),
  sha: Sha.optional().describe("The commit to read; the default branch head when absent"),
});
export type RepoRef = z.infer<typeof RepoRef>;

export function graphName(repo: Pick<RepoRef, "owner" | "name">): GraphName {
  const checked = RepoRef.pick({ owner: true, name: true }).parse(repo);
  return GraphName.parse(`repo:${checked.owner}/${checked.name}`.toLowerCase());
}

export function verifyName(runId: RunId): GraphName {
  return GraphName.parse(`verify:${runId.toLowerCase()}`);
}

export const advisoriesName: GraphName = GraphName.parse("advisories");

export function findingKey(vulnId: string, pkg: string): FindingKey {
  return FindingKey.parse(`${vulnId}|${pkg}`);
}

export function parseFindingKey(key: string): { readonly vulnId: string; readonly pkg: string } {
  const checked = FindingKey.parse(key);
  const at = checked.indexOf("|");
  return { vulnId: checked.slice(0, at), pkg: checked.slice(at + 1) };
}

/** Builds the package URL of an npm install, encoding a scope and a name separately. */
export function purl(name: string, version: string): Purl {
  const parts = name.startsWith("@") ? name.split("/") : [name];
  const encoded = parts.map((part) => encodeURIComponent(part)).join("/");
  return Purl.parse(`pkg:npm/${encoded}@${encodeURIComponent(version)}`);
}
