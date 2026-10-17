import type { PlanDraft } from "@noderunner/core";

/** Plans as pull requests would carry them; the graph behind it in production. */
export interface Plans {
  /** The newest plan a run proposed, drafted, or null when the run proposed none. */
  forRun(runId: string, signal: AbortSignal): Promise<PlanDraft | null>;
  /** @returns false when no repository graph holds the plan. */
  approve(planId: string, by: string, signal: AbortSignal): Promise<boolean>;
}
