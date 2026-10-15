import {
  type Clock,
  type Finding,
  type FindingQuery,
  findingKey,
  graphName,
  type IngestReport,
  LockPath,
  type RepoList,
  type RepoRef,
  type RepoSummary,
  Sha,
  type Stage,
} from "@noderunner/core";
import type { Catalog, Ingester } from "../jobs/catalog.ts";

const stages: readonly Stage[] = ["fetch", "lockfile", "imports", "advisories", "people", "prune"];
const empty = { files: 0, installs: 0, vulns: 0, findings: 0, people: 0 };

type Entry = {
  report: IngestReport;
  at: number;
  funnel: RepoSummary["funnel"];
  findings: readonly Finding[];
};

const finding = (
  vulnId: string,
  pkg: string,
  severity: Finding["severity"],
  tier: Finding["tier"],
): Finding => ({
  key: findingKey(vulnId, pkg),
  vulnId,
  package: pkg,
  installs: [LockPath.parse(`node_modules/${pkg}`)],
  severity,
  tier,
  status: "open",
});

/** The recorded mini repository of @noderunner/core/fixtures, so the UI has data before real ingestion lands. */
const demo: Entry = {
  report: {
    graph: graphName({ owner: "acme", name: "api" }),
    sha: Sha.parse("a".repeat(40)),
    counts: { files: 6, installs: 12, vulns: 3, findings: 3, people: 1 },
    warnings: [],
    ms: Object.fromEntries(stages.map((stage) => [stage, 0])) as IngestReport["ms"],
  },
  at: Date.UTC(2026, 9, 15, 9),
  funnel: { total: 3, production: 2, reachable: 1, open: 1 },
  findings: [
    finding("GHSA-hrpp-h998-j3pp", "qs", "high", "import-reachable"),
    finding("GHSA-35jh-r3h4-6jhm", "lodash", "high", "installed"),
    finding("GHSA-xvch-5gv4-984h", "minimist", "critical", "dev-only"),
  ],
};

/**
 * Stands in for `packages/ingest` and the graph until they land: emits the six stage events, records a zero-count
 * report, and serves the recorded demo repository. Replaced in main.ts, nowhere else.
 */
export class Standin implements Catalog {
  readonly #repos = new Map<string, Entry>([["acme/api", demo]]);

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
      sha: repo.sha ?? Sha.parse("0".repeat(40)),
      counts: empty,
      warnings: [],
      ms: Object.fromEntries(stages.map((stage) => [stage, this.stepMs])) as IngestReport["ms"],
    };
    this.#repos.set(`${repo.owner}/${repo.name}`, {
      report,
      at: this.clock.now(),
      funnel: { total: 0, production: 0, reachable: 0, open: 0 },
      findings: [],
    });
    return report;
  };

  async list(): Promise<RepoList["repos"]> {
    return [...this.#repos].map(([repoId, entry]) => ({
      repoId,
      sha: entry.report.sha,
      ingestedAt: entry.at,
      counts: entry.report.counts,
    }));
  }

  async summary(repo: Pick<RepoRef, "owner" | "name">): Promise<RepoSummary | null> {
    const entry = this.#repos.get(`${repo.owner}/${repo.name}`);
    return entry === undefined ? null : { funnel: entry.funnel, counts: entry.report.counts, lastRun: null };
  }

  async findings(
    repo: Pick<RepoRef, "owner" | "name">,
    filter: FindingQuery,
  ): Promise<readonly Finding[] | null> {
    const entry = this.#repos.get(`${repo.owner}/${repo.name}`);
    if (entry === undefined) return null;
    return entry.findings.filter(
      (row) =>
        (filter.tier === undefined || row.tier === filter.tier) &&
        (filter.status === undefined || row.status === filter.status),
    );
  }
}
