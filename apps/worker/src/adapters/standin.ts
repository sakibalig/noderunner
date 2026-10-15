import {
  type Clock,
  graphName,
  type IngestReport,
  type RepoList,
  type RepoSummary,
  type Stage,
} from "@noderunner/core";
import type { Catalog, Ingester } from "../jobs/catalog.ts";

const stages: readonly Stage[] = ["fetch", "lockfile", "imports", "advisories", "people", "prune"];

/**
 * Stands in for `packages/ingest` and the graph until they land: emits the six stage events, records a zero-count
 * report, and lists what it recorded. Replaced in main.ts, nowhere else.
 */
export class Standin implements Catalog {
  readonly #repos = new Map<string, { report: IngestReport; at: number }>();

  constructor(
    private readonly clock: Clock,
    private readonly stepMs = 150,
  ) {}

  readonly ingest: Ingester = async (repo, { onProgress, signal }) => {
    for (const [index, stage] of stages.entries()) {
      signal.throwIfAborted();
      await new Promise((resolve) => setTimeout(resolve, this.stepMs));
      onProgress({ type: "ingest.progress", stage, done: index + 1, total: stages.length });
    }
    const report: IngestReport = {
      graph: graphName(repo),
      sha: (repo.sha ?? "0".repeat(40)) as IngestReport["sha"],
      counts: { files: 0, installs: 0, vulns: 0, findings: 0, people: 0 },
      warnings: [],
      ms: Object.fromEntries(stages.map((stage) => [stage, this.stepMs])) as IngestReport["ms"],
    };
    this.#repos.set(`${repo.owner}/${repo.name}`, { report, at: this.clock.now() });
    return report;
  };

  async list(): Promise<RepoList["repos"]> {
    return [...this.#repos].map(([repoId, { report, at }]) => ({
      repoId,
      sha: report.sha,
      ingestedAt: at,
      counts: report.counts,
    }));
  }

  async summary(repo: { readonly owner: string; readonly name: string }): Promise<RepoSummary | null> {
    const entry = this.#repos.get(`${repo.owner}/${repo.name}`);
    if (entry === undefined) return null;
    return {
      funnel: { total: 0, production: 0, reachable: 0, open: 0 },
      counts: entry.report.counts,
      lastRun: null,
    };
  }
}
