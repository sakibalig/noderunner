import type {
  Finding,
  FindingQuery,
  IngestReport,
  RepoList,
  RepoRef,
  RepoSummary,
  RunEvent,
} from "@noderunner/core";

/** Ingests one repository; `packages/ingest` behind it once it lands. */
export type Ingester = (
  repo: RepoRef,
  options: { readonly onProgress: (event: RunEvent) => void; readonly signal: AbortSignal },
) => Promise<IngestReport>;

/** Reads what has been ingested; the graph behind it once `packages/graph` lands. */
export interface Catalog {
  list(signal: AbortSignal): Promise<RepoList["repos"]>;
  summary(repo: RepoRef, signal: AbortSignal): Promise<RepoSummary | null>;
  /** Null when the repository was never ingested. */
  findings(repo: RepoRef, filter: FindingQuery, signal: AbortSignal): Promise<readonly Finding[] | null>;
}
