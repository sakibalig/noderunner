import {
  type Db,
  Finding,
  type FindingQuery,
  type G,
  graphName,
  type RepoList,
  type RepoRef,
  type RepoSummary,
  RunBrief,
  Sha,
} from "@noderunner/core";
import { api } from "@noderunner/graph/cypher";
import type { Catalog } from "../jobs/catalog.ts";

type Listed = RepoList["repos"][number];

/** The repository pages' reads, from the repository graphs. A graph never ingested is null, and is never created. */
export class GraphCatalog implements Catalog {
  constructor(private readonly db: Db) {}

  async list(signal: AbortSignal): Promise<RepoList["repos"]> {
    const names = (await this.db.list()).filter((name) => name.startsWith("repo:"));
    const repos: Listed[] = [];
    for (const name of names) {
      const listed = await this.#listed(this.db.graph(name), signal);
      if (listed !== null) repos.push(listed);
    }
    return repos.sort((a, b) => (a.repoId < b.repoId ? -1 : a.repoId > b.repoId ? 1 : 0));
  }

  async summary(repo: RepoRef, signal: AbortSignal): Promise<RepoSummary | null> {
    const g = await this.#graph(repo);
    if (g === null || (await this.#listed(g, signal)) === null) return null;
    const [funnel] = await g.query(api.summary.funnel, {}, signal);
    const [counts] = await g.query(api.repos.counts, {}, signal);
    const [last] = await g.query(api.summary.lastRun, {}, signal);
    const run = RunBrief.safeParse(last);
    return {
      funnel: funnel ?? { total: 0, production: 0, reachable: 0, open: 0 },
      counts: counts ?? { files: 0, installs: 0, vulns: 0, findings: 0, people: 0 },
      lastRun: run.success ? run.data : null,
    };
  }

  async findings(
    repo: RepoRef,
    filter: FindingQuery,
    signal: AbortSignal,
  ): Promise<readonly Finding[] | null> {
    const g = await this.#graph(repo);
    if (g === null || (await this.#listed(g, signal)) === null) return null;
    const rows = await g.query(
      api.findings.list,
      { tier: filter.tier ?? null, status: filter.status ?? null },
      signal,
    );
    return rows.map((row) =>
      Finding.parse({
        key: row.key,
        vulnId: row.vulnId,
        package: row.package,
        installs: row.installs,
        severity: row.severity,
        tier: row.tier,
        status: row.status,
      }),
    );
  }

  async #graph(repo: RepoRef): Promise<G | null> {
    const name = graphName(repo);
    return (await this.db.list()).includes(name) ? this.db.graph(name) : null;
  }

  async #listed(g: G, signal: AbortSignal): Promise<Listed | null> {
    const [repo] = await g.query(api.repos.repo, {}, signal);
    if (repo === undefined) return null;
    const [counts] = await g.query(api.repos.counts, {}, signal);
    return {
      repoId: `${repo.owner}/${repo.name}`,
      sha: Sha.parse(repo.sha),
      ingestedAt: repo.ingestedAt,
      counts: counts ?? { files: 0, installs: 0, vulns: 0, findings: 0, people: 0 },
    };
  }
}
