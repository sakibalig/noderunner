import {
  type Clock,
  type Db,
  Decision,
  type DecisionCreate,
  type ErrorCode,
  type EvEdge,
  type Evidence,
  type EvNode,
  edgeKey,
  Finding,
  FindingDetail,
  type G,
  type GraphName,
  graphName,
  type Ids,
  type RepoRef,
  RunId,
  Severity,
} from "@noderunner/core";
import { api, memory } from "@noderunner/graph/cypher";
import type { Toolbox } from "@noderunner/tools";
import { WorkerError } from "../errors.ts";
import type { Findings } from "../jobs/findings.ts";

type Route = NonNullable<Awaited<ReturnType<typeof pathOf>>>;

const severity = Severity.catch("unknown");

async function pathOf(g: G, key: string, signal: AbortSignal) {
  const [row] = await g.query(api.findings.path, { key }, signal);
  return row;
}

/** Findings from the repository graph; decisions go through the same `record_decision` tool the agent calls. */
export class GraphFindings implements Findings {
  constructor(
    private readonly deps: {
      readonly db: Db;
      readonly clock: Clock;
      readonly ids: Ids;
      readonly toolbox: Toolbox;
    },
  ) {}

  async detail(repo: RepoRef, key: string, signal: AbortSignal): Promise<FindingDetail | null> {
    const graph = graphName(repo);
    if (!(await this.#exists(graph))) return null;
    const g = this.deps.db.graph(graph);
    const [row] = await g.query(api.findings.detail, { key }, signal);
    if (row === undefined) return null;
    const route = await pathOf(g, key, signal);
    const history = await g.query(api.findings.decisions, { key }, signal);
    return FindingDetail.parse({
      finding: Finding.parse({
        key: row.key,
        vulnId: row.vulnId,
        package: row.package,
        installs: row.installs,
        severity: severity.parse(row.severity),
        tier: row.tier,
        status: row.status,
      }),
      vuln: {
        id: row.id,
        aliases: row.aliases ?? [],
        severity: severity.parse(row.vulnSeverity),
        summary: row.summary ?? "",
        modified: row.modified ?? 0,
      },
      path: route === undefined ? null : evidence(route),
      decisions: history.map((d) =>
        Decision.parse({
          id: d.id,
          key: row.key,
          kind: d.kind,
          reason: d.reason,
          by: d.by ?? "unknown",
          createdAt: d.createdAt,
          expiresAt: d.expiresAt ?? null,
          tierAtDecision: d.tierAtDecision ?? null,
          staleReason: d.staleReason ?? null,
        }),
      ),
    });
  }

  async decide(
    repo: RepoRef,
    input: DecisionCreate,
    signal: AbortSignal,
  ): Promise<{ readonly decisionId: string } | null> {
    const graph = graphName(repo);
    if (!(await this.#exists(graph))) return null;
    const g = this.deps.db.graph(graph);
    if ((await g.query(api.findings.detail, { key: input.key }, signal)).length === 0) return null;
    const runId = RunId.parse(this.deps.ids.next());
    await g.query(
      memory.run.start,
      { id: runId, agent: "ui", model: null, now: this.deps.clock.now() },
      signal,
    );
    let code: ErrorCode = "internal";
    const result = await this.deps.toolbox.callTool(
      "record_decision",
      {
        key: input.key,
        kind: input.kind,
        reason: input.reason,
        by: `@${input.by}`,
        ...(input.expiresInDays === undefined ? {} : { expiresInDays: input.expiresInDays }),
      },
      { graph, runId, actor: "ui", signal },
      {
        onStart: () => {},
        onFinish: (step) => {
          if (step.code !== undefined) code = step.code;
        },
      },
    );
    await g.query(
      memory.run.finish,
      {
        id: runId,
        status: result.ok ? "done" : "failed",
        report: result.ok ? result.summary : result.error,
        result: null,
        unverified: false,
        tokensIn: 0,
        tokensOut: 0,
        now: this.deps.clock.now(),
      },
      signal,
    );
    if (!result.ok) throw new WorkerError(code, "decision.failed", result.error);
    return { decisionId: (result.data as { readonly decisionId: string }).decisionId };
  }

  async #exists(graph: GraphName): Promise<boolean> {
    return (await this.deps.db.list()).includes(graph);
  }
}

/** The path as evidence: the file, each install on the chain, and the advisory, joined by stable keys. */
function evidence(route: Route): Evidence {
  const file = { id: route.fileNode, key: route.file };
  const vuln = { id: route.vulnNode, key: route.vulnId };
  const nodes: EvNode[] = [
    { ...file, label: "File", name: route.file },
    ...route.chain.map((n) => ({ id: n.id, key: n.key, label: "Install", name: n.name })),
    { ...vuln, label: "Vuln", name: route.vulnId },
  ];
  const edges: EvEdge[] = [];
  const link = (id: number, type: string, from: typeof file, to: typeof file) =>
    edges.push({
      id,
      key: edgeKey(from.key, type, to.key),
      type,
      from: from.id,
      to: to.id,
      fromKey: from.key,
      toKey: to.key,
    });
  const [entry] = route.chain;
  const bad = route.chain.at(-1);
  if (entry !== undefined) link(route.loads, "LOADS", file, entry);
  route.hops.forEach((id, i) => {
    const from = route.chain[i];
    const to = route.chain[i + 1];
    if (from !== undefined && to !== undefined) link(id, "DEPENDS_ON", from, to);
  });
  if (bad !== undefined) link(route.affects, "AFFECTS", vuln, bad);
  return { nodes, edges, cypher: [api.findings.path.text] };
}
