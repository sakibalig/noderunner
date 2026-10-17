import type { DecisionCreate, FindingDetail, RepoRef } from "@noderunner/core";

/** One finding in detail, and human decisions on it; the graph and the tools behind it in production. */
export interface Findings {
  /** Null when the repository has no finding with this key. */
  detail(repo: RepoRef, key: string, signal: AbortSignal): Promise<FindingDetail | null>;
  /** Records a decision through `record_decision` in a short `ui` run; null when the finding does not exist. */
  decide(
    repo: RepoRef,
    input: DecisionCreate,
    signal: AbortSignal,
  ): Promise<{ readonly decisionId: string } | null>;
}
