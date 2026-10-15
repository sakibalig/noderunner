# Tools

The ten tools are the only way the agent, an MCP client, or the UI reads or changes the graph on a run's behalf.
One implementation in `packages/tools` serves all three callers. This file fixes their names, inputs, outputs, and
the envelope every call returns; the zod schemas in `packages/core/src/tool.ts` and `packages/tools` are its
executable form.

## The envelope

```ts
type EvNode = { id: number; key: string; label: string; name: string; props?: Record<string, Json> };
type EvEdge = { id: number; key: string; type: string; from: number; to: number; fromKey: string; toKey: string };
type Evidence = { nodes: EvNode[]; edges: EvEdge[]; cypher: string[] };

type ToolOk<T> = { ok: true; data: T; summary: string; evidence: Evidence; stepId: string };
type ToolErr = { ok: false; error: string; stepId: string };
type ToolResult<T> = ToolOk<T> | ToolErr;
```

- `summary` is one line, shown in the step timeline.
- `evidence` lists the nodes and edges the call touched and the exact queries it ran. `key`, `fromKey`, and `toKey`
  are stable keys from the [graph schema](../graph/schema.md); an edge's `key` is `<fromKey>|<type>|<toKey>`. The
  numeric ids are valid within the current snapshot only, and anything stored or replayed uses the keys. Evidence is
  capped at 300 nodes and 600 edges.
- `error` is a safe message the model can act on. It never carries a stack, a path on the server, or a token.
- Every call — successful, failed, or rejected for bad input — writes exactly one `Step` node, and `stepId` names it.
  The step id is created before the tool runs, so `step.started` carries it.

**What each caller sees.** The model and MCP clients receive `data` and `summary` only, serialised and capped at
6,000 characters, with text taken from a repository or an advisory wrapped as quoted data. `evidence` goes to the
UI and to the graph, never to the model.

## Calling context

```ts
type ToolCtx = {
  graph: string;                                               // bound by the server, never by the caller
  runId: string;
  actor: "triage" | "fixer" | "baseline" | "mcp" | "ui";
  signal: AbortSignal;
};
```

Every call runs under a `Run`. An agent run owns its calls; an MCP client session is one run with agent `mcp`; each
UI action — a decision, a ship — is one short run with agent `ui`. A tool call times out after 20 seconds, except
`open_pull_request`, which allows 240 seconds for the sandbox and the verification ingest. A triage, fixer, or
baseline run makes at most 15 calls; an MCP session at most 100.

## Access

Each tool declares one access level. It decides which MCP clients see the tool; it never changes what the tool does.

| Access | Meaning | Visible to MCP |
| --- | --- | --- |
| `read` | Reads the graph and writes nothing but its own Step | always |
| `derive` | Also writes values derived deterministically from the graph: tiers, staleness, plans, reviewers | always |
| `act` | Records a human decision or changes something outside the graph | only with `MCP_ALLOW_WRITES=true` |

## The tools

| Tool | Access | Input | Output `data` | Writes |
| --- | --- | --- | --- | --- |
| `recall_decisions` | derive | `{ package?: string, vulnId?: string }` | `{ inForce: Decision[], stale: (Decision & { reason: StaleReason })[] }` | `Decision.stale_reason` |
| `list_alerts` | derive | `{ minSeverity?: Severity }` | `{ total, bySeverity, findings: Finding[] }`, the 40 most severe, the rest counted | `FOUND` |
| `reachability` | derive | `{ keys?: string[] }`, empty means all | `{ counts: Record<Tier, number>, reachable: { key, files: string[], via, chain: string[], hops }[] }` | `Finding.tier` |
| `introduced_by` | read | `{ key: string }` | `{ direct: { package, range, dev, chain: string[] }[] }` | none |
| `rank_packages` | read | `{ top?: number }`, default 10 | `{ ranked: { package, version, score, shareBelow }[] }` | none |
| `plan_upgrades` | derive | `{ tiers: Tier[], allowMajor: boolean }` | `{ planId, upgrades: Upgrade[], uncovered: string[], totalCost }` | `Plan`, `Upgrade`, `PROPOSED`, `INCLUDES`, `CLOSES`, `Finding.status` |
| `owners_for` | derive | `{ planId: string }` | `{ perUpgrade: { upgrade, reviewers: { handle, why }[] }[] }`, top two per upgrade | `REVIEW_BY` |
| `record_decision` | act | `{ key, kind, reason, expiresInDays?, by }` | `{ decisionId, superseded?: string }` | `Decision`, `ABOUT`, `MADE_BY`, `SUPERSEDES`, `Finding.status` |
| `open_pull_request` | act | `{ planId: string }` | `Shipment`, below | `PullRequest`, `SHIPPED_AS` |
| `read_only_cypher` | read | `{ query: string, params?: object }` | `{ rows, truncated }`, at most 200 rows | none; runs as a read-only query |

```ts
type Shipment =
  | { outcome: "opened"; url: string; branch: string; verification: Verification }
  | { outcome: "refused"; reason: "new reachable finding"; verification: Verification };
```

A refusal after verification is a successful call with `outcome: "refused"`, not an error, so the verification
result reaches the caller. Domain types (`Finding`, `Upgrade`, `Decision`, `Verification`, `Tier`, `Severity`,
`StaleReason`) are defined once in `packages/core/src/domain.ts` and follow the [graph schema](../graph/schema.md).

**Derived values.** `rank_packages.shareBelow` is the fraction of all installs reachable from the ranked install
through `DEPENDS_ON`. `owners_for` scores a person 3 for an `OWNS` edge plus their `CHANGED.commits` when
`CHANGED.last_at` is within 90 days of the run, and returns the top two per upgrade with the reason.

## Rules every tool holds

- `open_pull_request` fails with `unapproved` unless the plan's `approved` flag is set by
  `POST /plans/:id/approve`, and with `shipped` when the plan already has a `SHIPPED_AS` edge.
- `read_only_cypher` runs through the read-only query path with a 5-second timeout, appends `LIMIT 200` when the
  query has none, and rejects a query that calls `db.` procedures or graph-management commands.
- `callTool` validates the input itself, after creating the Step, so a malformed call from any caller is recorded.

## Who gets which tools

| Caller | Tools |
| --- | --- |
| Triage agent | every tool except `open_pull_request` |
| Fixer agent | `recall_decisions`, `list_alerts`, `owners_for`, `open_pull_request`, `read_only_cypher` |
| Baseline agent | `list_alerts`, plus `search_files { text, glob? }` and `read_file { path, offset? }`, which are baseline-only and never touch the graph |
| MCP client | `read` and `derive` tools; `act` tools only with `MCP_ALLOW_WRITES=true` |
| UI | `record_decision` through `POST /decisions`, and `open_pull_request` through `POST /plans/:id/ship` |
