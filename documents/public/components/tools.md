# `packages/tools`

The ten typed tools, the registry that lists them, and `callTool`, the one wrapper every call goes through. The
agent loop, the MCP server, and the Run API all reach the graph through this package, so its single responsibility is
to turn a named tool call into a parameterised, bounded graph operation that leaves a `Step` behind and returns the
[`ToolResult` envelope](../../../contracts/mcp/tools.md#the-envelope).

| Owner | Tasks | Layer | Depends on |
| --- | --- | --- | --- |
| Shaukat | T12, T13 | Application | `packages/core` (types, ports, `ToolDef`, `staleness`, `limits`), `@noderunner/graph/cypher`; planner and executor injected |

## Responsibility

It owns the tool definitions, the registry and the per-actor tool sets, `callTool` with its Step and `TOUCHED`
writes, the evidence cap, `forModel`, the serialiser that produces what a model or an MCP client reads, and the
baseline agent's two file tools under `src/baseline/` (R18).

It does not own the Cypher text (named constants under `packages/graph/src/cypher`, laid out in
[graph](graph.md)), the tier and staleness policy (`staleness()` in [core](core.md)), the set-cover algorithm
([planner](planner.md)), the pull request, its refusal checks, and its verification ([executor](executor.md)), the
model loop ([agent](agent.md)), the MCP transport ([mcp](mcp.md)), or logging. It never reads `process.env` and never
chooses a graph: the graph name arrives in `ToolCtx.graph`. Tools do not log (R17): there is no logger port, and the
worker logs `tool.call.*` from the step hooks it passes to `callTool`.

## Interface

`ToolDef`, `ToolCtx`, `Access`, `ToolResult`, `Shipment`, and `limits` are the [core](core.md) types; this package
adds no second definition of them.

```ts
// packages/tools/src/registry.ts
export type Deps = {
  readonly db: Db; readonly clock: Clock; readonly ids: Ids;
  readonly planner: Planner;    // plan() from packages/planner, bound to its Registry by the composition root
  readonly executor: Executor;  // ship() from packages/executor, bound to Forge, Sandbox, and ingest
  readonly files: (runId: RunId) => ReadonlyMap<string, string> | null;  // a baseline run's stage 1 files
};
export function createTools(deps: Deps): readonly AnyToolDef[];  // the ten in contract order, then the baseline two
export function available(actor: Actor, access: readonly Access[], defs: readonly AnyToolDef[]):
  readonly AnyToolDef[];                                          // the actor's set, filtered by access

// packages/tools/src/call.ts
export type StepHooks = {
  onStart(step: { stepId: StepId; seq: number; tool: string; input: Json }): void;
  onFinish(step: { stepId: StepId; ok: boolean; summary: string; evidence?: Evidence; ms: number;
                   code?: ErrorCode }): void;   // code: the failed Fault's surface
};
export type Toolbox = {
  callTool(name: string, input: unknown, ctx: ToolCtx, hooks: StepHooks): Promise<ToolResult<unknown>>;
};
export function createToolbox(deps: Deps, opts: { access: readonly Access[] }): Toolbox;

// packages/tools/src/payload.ts
export function forModel(result: ToolResult<unknown>): string;   // at most limits.modelChars characters
```

Each tool's `access` and `timeoutMs` follow [the contract table](../../../contracts/mcp/tools.md#the-tools) (R3, R5):

| Tool | Access | `timeoutMs` |
| --- | --- | --- |
| `recall_decisions`, `list_alerts`, `reachability`, `plan_upgrades`, `owners_for` | `derive` | `limits.toolMs`, 20 s |
| `introduced_by`, `rank_packages`, `read_only_cypher` | `read` | `limits.toolMs`, 20 s |
| `record_decision` | `act` | `limits.toolMs`, 20 s |
| `open_pull_request` | `act` | `limits.shipMs`, 240 s |
| `search_files`, `read_file` (baseline only) | `read` | `limits.toolMs`, 20 s |

The per-actor sets are the contract's [who gets which tools](../../../contracts/mcp/tools.md#who-gets-which-tools).
`opts.access` is `["read", "derive", "act"]` for the worker, and `["read", "derive"]` for the MCP server unless
`MCP_ALLOW_WRITES=true`, so read-only MCP still offers `reachability` (R5). The baseline tools are plain `ToolDef`s
in `src/baseline/`, registered by `createTools` and in the baseline actor's set only (R18), so they get a Step and
a citable `stepId` like every other call. Limits come from core's
`limits`: `toolMs`, `shipMs`, `evidenceNodes` 300, `evidenceEdges` 600, `modelChars` 6,000, `cypherMs` 5,000,
`cypherRows` 200, and `alertRows` 40. One limit is local: `INPUT_CHARS = 4_000`, the stored Step input. Files:
`src/registry.ts`, `src/call.ts`, `src/evidence.ts`, `src/payload.ts`, one file per tool under `src/defs/`
(`recall`, `alerts`, `reachability`, `origin`, `rank`, `plan`, `owners`, `decide`, `ship`, `query`), and
`src/baseline/` (`search`, `read`).

## Behaviour

### callTool

1. Create the Step first (R7): take a `stepId` from `ids`, and run `step.start` (`cypher/memory/step.ts`), which
   writes the `Step` with `tool`, `input` (the raw input as JSON, cut to `INPUT_CHARS`), and `seq` computed in the
   same query as one more than the run's existing steps, linked by `HAS_STEP` from `Run {id: ctx.runId}`. Every call
   runs under a run: an agent's own, the MCP session's `mcp` run, or a short `ui` run per UI action (R8). Then call
   `hooks.onStart` with the stored values; the worker's hooks emit `step.started` and log `tool.call.started`.
2. Resolve the definition. An unknown name, or a tool not in `available(ctx.actor, opts.access, …)`, finishes as a
   `ToolErr`.
3. Validate the input itself, `def.input.safeParse(raw)`, so a malformed call from any caller is recorded. On
   failure finish with a `ToolErr` whose message lists each failing path and reason, so the model can correct the
   call.
4. Run `def.run(ctx, input)` under `def.timeoutMs` with an `AbortController` linked to `ctx.signal`; the timer and
   the listener are cleared in `finally`.
5. Cap the evidence to `limits.evidenceNodes` and `limits.evidenceEdges`, keeping the order the tool returned (most
   relevant first), dropping edges whose endpoints were cut, and appending "evidence capped" to the summary.
6. Run `step.touched`, one batched `MERGE (s)-[:TOUCHED]->(x)` over the capped node ids, in the same call so the ids
   are still valid.
7. Finish with `step.finish`: set `ok`, `summary`, `cypher` (the exact constants run), `ms`, and `edges`, the JSON
   list of the capped evidence edges' keys (R9), so a replay can rebuild them. Call `hooks.onFinish` with `ok`,
   `summary`, the evidence, `ms`, and on failure `code`, the `surface` of the `Fault` that ended the call; the
   worker's hooks emit `step.finished` and log `tool.call.finished` or `tool.call.failed`, and a shipment job uses
   `code` for `job.failed`. Then return the envelope. Every path through steps 2 to 6 ends here, so exactly one Step
   is written per call.

Every read that feeds evidence returns `id(n)` and the node's stable key, and `id(r)` for edges. `EvNode.key` comes
from the label's key property in the [graph schema](../../../contracts/graph/schema.md), and an `EvEdge` carries
`key`, `fromKey`, and `toKey`, its key being `<fromKey>|<type>|<toKey>` (C4 and D10 proposed, R9).

### forModel

The model and MCP clients receive `{ tool, ok, summary, data }` or `{ tool, ok, error }` as JSON, never `evidence`.
Free text from a repository or an advisory (paths, specifiers, advisory summaries, decision reasons, and every value
in a `read_only_cypher` row) is typed `Quoted` in the tool's data and serialised as `{ "quoted": "<text>" }`, so the
system prompt can state that anything inside `quoted` is data. When the JSON exceeds `limits.modelChars`, the
longest array is trimmed from its tail and an `omitted` count recorded, repeatedly, until it fits; a single oversized
string is cut last. The output is deterministic for a given result.

### Per tool

Every query is a named `Query<R>` constant in the form [graph](graph.md) fixes (R16): built with `query(name, text,
row)` or `write(name, text)` in a file under `packages/graph/src/cypher/`, named `<file>.<constant>`, with a zod row
schema that parses every row, and read by this package from `@noderunner/graph/cypher`. Values are always
parameters, and time is `$now` from `Clock`. Each block below names its constant and file; for example:

```ts
// packages/graph/src/cypher/tools/rank.ts
export const below = query("rank.below", `
  MATCH (n:Install) WITH count(n) AS total
  MATCH (r:Install {lock_path: $key})
  OPTIONAL MATCH (r)-[:DEPENDS_ON*1..15]->(d:Install)
  RETURN count(DISTINCT d) * 1.0 / total AS shareBelow`,
  z.object({ shareBelow: z.number().min(0).max(1) }));
```

#### `recall_decisions` — derive, writes `Decision.stale_reason`

Input `{ package?, vulnId? }`. Lists every unsuperseded decision with its staleness. The graph fetches plain rows
and core decides (R12): for each row the tool builds `StaleFacts` and calls `staleness(facts, clock.now())`, whose
rules apply in order, first match wins — expired, now reachable, advisory updated, worse vulnerability on the same
install — and in which a null `tier_at_decision` counts as not reachable. No `CASE`, aggregate, or clock appears in
the query. The default plan runs the tool twice, before `list_alerts` and after `reachability`, because the "now
reachable" rule reads the `Finding.tier` that `reachability` sets (C2, D8 proposed).

```cypher
// decisions.recall — cypher/tools/decisions.ts
MATCH (d:Decision)-[:ABOUT]->(x:Finding)-[:ABOUT]->(v:Vuln)
WHERE NOT (d)<-[:SUPERSEDES]-(:Decision)
  AND ($package IS NULL OR x.package = $package) AND ($vulnId IS NULL OR x.vuln_id = $vulnId)
OPTIONAL MATCH (d)-[:MADE_BY]->(p:Person)
OPTIONAL MATCH (x)-[:AT]->(:Install)<-[:AFFECTS]-(other:Vuln) WHERE other.id <> v.id
WITH d, x, v, p, collect(DISTINCT other.severity) AS others
RETURN d.id AS id, d.kind AS kind, d.reason AS reason, p.handle AS by, d.created_at AS createdAt,
       d.expires_at AS expiresAt, d.tier_at_decision AS tierAtDecision, x.key AS key, x.tier AS tier,
       v.modified AS advisoryModified, v.severity AS severity, others,
       id(d) AS dId, id(x) AS xId, id(v) AS vId
ORDER BY key, createdAt, id LIMIT 500
```

Data `{ inForce, stale }`, split by whether `staleness` returned a reason. `decisions.stale` then writes
`stale_reason` on every returned decision (null when no longer stale) with one `UNWIND`. The rules apply to every
kind of decision, not only the LLD's `waive`.

#### `list_alerts` — derive, writes `FOUND`

Input `{ minSeverity? }`. Every finding not `fixed`, with up to five installs, sorted by `severity_rank` descending
and then key. `total` and `bySeverity` count every row; `findings` holds the first `limits.alertRows`, the 40 most
severe, so the payload fits the model's 6,000 characters (R14). `alerts.found` then writes `MERGE (r)-[:FOUND]->(x)`
from `Run {id: $runId}` for every key in `findings`.

```cypher
// alerts.list — cypher/tools/alerts.ts
MATCH (x:Finding)-[:ABOUT]->(v:Vuln) WHERE x.status <> "fixed" AND v.severity_rank >= $minRank
OPTIONAL MATCH (x)-[:AT]->(i:Install)
WITH x, v, i ORDER BY i.lock_path
WITH x, v, collect(i.lock_path)[0..5] AS installs, collect(id(i))[0..5] AS installIds
RETURN x.key AS key, x.vuln_id AS vulnId, x.package AS package, x.severity AS severity, x.tier AS tier,
       x.status AS status, v.severity_rank AS rank, installs, installIds, id(x) AS xId, id(v) AS vId
ORDER BY rank DESC, key LIMIT 5000
```

#### `reachability` — derive, writes `Finding.tier`

Input `{ keys? }`, empty meaning every finding. Runs the three tier queries from the LLD, then writes every tier
with `tier.write`, one `UNWIND $rows AS r MATCH (x:Finding {key: r.key}) SET x.tier = r.tier`. A finding is
`import-reachable` when `tier.reachable` or `tier.direct` returns it; otherwise `tier.rest` decides `dev-only` or
`installed`. The model never decides a tier.

```cypher
// tier.reachable — cypher/tools/tier.ts: a production file loads an install that reaches the affected install
MATCH (x:Finding)-[:AT]->(bad:Install)
WHERE size($keys) = 0 OR x.key IN $keys
MATCH (f:File {kind: "prod"})-[l:LOADS]->(entry:Install)
WITH x, bad, entry, f, l ORDER BY f.path
WITH x, bad, entry, collect({path: f.path, id: id(f), edge: id(l)})[0..3] AS files
MATCH p = shortestPath((entry)-[:DEPENDS_ON*..15]->(bad))   // VERIFY D1: placement and min length
WITH x, files, entry, p ORDER BY length(p) ASC, entry.lock_path ASC
WITH x, head(collect({files: files, entry: entry, p: p})) AS best
RETURN x.key AS key, best.files AS files, best.entry.name AS via, length(best.p) AS hops,
       [n IN nodes(best.p) | n.lock_path] AS chain,
       [n IN nodes(best.p) | id(n)] AS nodeIds, [r IN relationships(best.p) | id(r)] AS edgeIds
ORDER BY key LIMIT 5000

// tier.direct — zero hops: the production file loads the affected install itself
MATCH (x:Finding)-[:AT]->(bad:Install)<-[l:LOADS]-(f:File {kind: "prod"})
WHERE size($keys) = 0 OR x.key IN $keys
WITH x, bad, f, l ORDER BY f.path
RETURN x.key AS key, collect({path: f.path, id: id(f), edge: id(l)})[0..3] AS files, id(bad) AS nodeId
ORDER BY key LIMIT 5000

// tier.rest — not import-reachable: dev-only if every affected install is dev, else installed
MATCH (x:Finding)-[:AT]->(i:Install)
WHERE (size($keys) = 0 OR x.key IN $keys) AND NOT x.key IN $reachableKeys
WITH x, collect(i.dev) AS devs
RETURN x.key AS key, all(v IN devs WHERE v) AS devOnly ORDER BY key LIMIT 5000
```

When `tier.reachable` and `tier.direct` both return a key, the shorter chain wins, so the zero-hop result is
preferred. Data `{ counts, reachable: { key, files, via, chain, hops }[] }`, where `files` is the array of up to
three production file paths (their ids and the `LOADS` edges go to the evidence). The ordering and the
`entry.lock_path` tie-break are additions to the LLD text so the same commit gives the same chain. If `shortestPath`
cannot sit in `MATCH`, the fallback is one query per entry install using `algo.BFS` or a bounded match with
`LIMIT 1` (D1).

**Performance risk.** `tier.reachable` pairs every affected install with every production-loaded install before
`shortestPath`, so its cost grows with findings times entries. T12 measures it on the largest demo repository;
above 500 ms it switches to one query per finding with the same text and `$keys` of one, which is the plan's
mitigation.

**As built (T12).** S1 showed that FalkorDB accepts `shortestPath` only as a `WITH` or `RETURN` projection and
allows a minimum length of 0, so `tier.reachable` is written in the projection form with `*0..15` and also covers
the zero-hop case: `tier.direct` is not needed, and the chain of a file loading the affected install itself has
one element and `hops: 0`. The reads in this file written as `MATCH p = shortestPath(...)` must take the same form
when they are built. `tier.known` checks the requested keys first, so an unknown key is `missing`, and the write is
`tier.save`. On `nestjs/nest` (56 findings) the single query takes about 0.55 s and the per-finding fallback 2.07 s
for the same 12 rows, so the single query stays: the 500 ms line assumed the fallback would be faster, and the
tool's 20-second budget is far away. Three of its chains were checked by hand against the lockfile and the source.
The Step's `cypher` property is written from a parameter named `queries`, because the client sends parameters as
a `CYPHER name=value` prefix and a parameter named `cypher` breaks it. `forModel(tool, result)` takes the tool name,
and wrapping repository text as `quoted` arrives with the tools that return such text, from T13. Nothing in the
tools creates a `Run`: `run.start` in `cypher/memory/run.ts` is for whoever starts the run, and a call under a run
that does not exist ends with "The step could not be recorded" and no `onStart`.

#### `introduced_by` — read

Input `{ key }`. For each affected install, the direct dependencies whose `DECLARES` edge reaches it, with the chain.

```cypher
// chain.introduced — cypher/tools/chain.ts
MATCH (:Finding {key: $key})-[:AT]->(bad:Install)
MATCH (:Repo)-[d:DECLARES]->(top:Install)
MATCH p = shortestPath((top)-[:DEPENDS_ON*..15]->(bad))     // VERIFY D1
RETURN top.name AS package, d.range AS range, d.dev AS dev, [n IN nodes(p) | n.lock_path] AS chain,
       [n IN nodes(p) | id(n)] AS nodeIds, [r IN relationships(p) | id(r)] AS edgeIds
ORDER BY length(p), package LIMIT 50
```

A second constant, `chain.direct`, covers zero hops, `(:Repo)-[d:DECLARES]->(bad)`. Data
`{ direct: { package, range, dev, chain }[] }`, ordered by chain length and then package.

#### `rank_packages` — read

Input `{ top? }`, default 10, clamped to 1–25. PageRank over `Install` and `DEPENDS_ON`, then `rank.below`, shown
above, once per result.

```cypher
// rank.pagerank — cypher/tools/rank.ts
CALL algo.pageRank('Install', 'DEPENDS_ON') YIELD node, score   // VERIFY D2: name, signature, edge filter
RETURN id(node) AS id, node.lock_path AS key, node.name AS package, node.version AS version, score
ORDER BY score DESC, key LIMIT $top
```

Data `{ ranked: { package, version, score, shareBelow }[] }`. `shareBelow` is the contract's: the fraction of all
installs reachable from the ranked install through `DEPENDS_ON`, that is, the share of the tree below it (R13).

#### `plan_upgrades` — derive, writes through the planner

Input `{ tiers, allowMajor }`. Refuses with a `ToolErr` when any finding in the requested tiers has no `tier` yet,
naming `reachability` as the call to make first. Otherwise calls the planner's `plan` with `allowMajor` mapped to
`majors`, which writes `Plan` (with `approved: false`), `Upgrade`, `PROPOSED`, `INCLUDES`, `CLOSES`, and
`Finding.status = "planned"` with its own constants in `cypher/tools/plan.ts` ([planner](planner.md)). Data
`{ planId, upgrades, uncovered, totalCost }`. A cold registry cache can approach the 20-second timeout; the demo runs
warm.

#### `owners_for` — derive, writes `REVIEW_BY`

Input `{ planId }`. For each upgrade, the production files that load an install reaching a finding it closes, then
their people. Scoring is the contract's (R13): per upgrade, a person scores 3 for each `OWNS` edge to one of those
files plus their `CHANGED.commits` on each file whose `CHANGED.last_at` is within 90 days of the run (`$since` is
`clock.now()` less 90 days). The top two per upgrade, ties broken by handle, are written by `owners.write` as
`(u)-[:REVIEW_BY {why}]->(p)`, where `why` names the owned files and the recent commit count.

```cypher
// owners.files — cypher/tools/owners.ts
MATCH (:Plan {id: $planId})-[:INCLUDES]->(u:Upgrade)-[:CLOSES]->(:Finding)-[:AT]->(bad:Install)
MATCH (f:File {kind: "prod"})-[:LOADS]->(entry:Install)
WHERE entry = bad OR (entry)-[:DEPENDS_ON*..15]->(bad)        // VERIFY D1: pattern predicate cost
WITH DISTINCT u, f
OPTIONAL MATCH (o:Person)-[:OWNS]->(f)
OPTIONAL MATCH (c:Person)-[ch:CHANGED]->(f) WHERE ch.last_at >= $since
RETURN u.id AS upgrade, f.path AS file, collect(DISTINCT o.handle) AS owners,
       collect({handle: c.handle, commits: ch.commits}) AS changed ORDER BY upgrade, file LIMIT 2000
```

An upgrade that closes only non-reachable findings has no production file and gets no reviewers, which the summary
says. Data `{ perUpgrade: { upgrade, reviewers: { handle, why }[] }[] }`.

#### `record_decision` — act, writes `Decision`, `ABOUT`, `MADE_BY`, `SUPERSEDES`, `Finding.status`

Input `{ key, kind: "waive" | "accept" | "reject", reason (1–500 chars), expiresInDays? (1–365), by }`. Stores
`tier_at_decision` from the finding's current tier so the "now reachable" rule can fire later, and `expires_at` from
`Clock`. The newest unsuperseded decision on the same finding is linked by `(new)-[:SUPERSEDES]->(old)`. The UI's
`POST /decisions` calls it in a short `ui` run (R8).

```cypher
// decisions.record — cypher/tools/decisions.ts
MATCH (x:Finding {key: $key})
OPTIONAL MATCH (old:Decision)-[:ABOUT]->(x) WHERE NOT (old)<-[:SUPERSEDES]-(:Decision)
WITH x, old ORDER BY old.created_at DESC
WITH x, head(collect(old)) AS old
MERGE (p:Person {handle: $by}) ON CREATE SET p.kind = "user"
CREATE (d:Decision {id: $id, kind: $kind, reason: $reason, created_at: $now, expires_at: $expiresAt,
                    tier_at_decision: x.tier})-[:ABOUT]->(x)
CREATE (d)-[:MADE_BY]->(p)
SET x.status = CASE WHEN $kind = "waive" THEN "waived"
                    WHEN x.status = "waived" THEN "open" ELSE x.status END
RETURN d.id AS decisionId, old.id AS superseded
```

A second constant, `decisions.supersede`, creates `SUPERSEDES` when `superseded` is not null. Data
`{ decisionId, superseded? }`.

#### `open_pull_request` — act, writes `PullRequest`, `SHIPPED_AS`

Input `{ planId }`, `timeoutMs` 240 s (R3), enough for the 120-second sandbox and the verification ingest. The tool
makes no check of its own: it calls the executor's `ship`, which holds every refusal check — `Plan.approved` set by
`POST /plans/:id/approve` (R1), else `unapproved`; no `SHIPPED_AS`, else `shipped`; no other ship of the plan in
flight, else `busy` — and then regenerates, verifies, and writes ([executor](executor.md)). Data is the `Shipment`
union (R4): `{ outcome: "opened", url, branch, verification }`, or `{ outcome: "refused", reason: "new reachable
finding", verification }`, which is a successful call so the verification reaches the caller. It does not write
`Finding.status`: findings stay `planned` while the pull request is open, until a later ingest sets them `fixed`.
It runs in a fixer run, or in the short `ui` run of the shipment job that `POST /plans/:id/ship` starts (R2, R8;
D9 proposed).

#### `read_only_cypher` — read

Input `{ query (at most 4,000 chars), params? (JSON scalars and arrays) }`. Guard rules, all before the query runs:

1. Reject a query containing `CALL db.`, a `GRAPH.` command, `LOAD CSV`, or more than one statement.
2. Reject the write clauses `CREATE`, `MERGE`, `DELETE`, `SET`, `REMOVE`, and `DROP` outside string literals, so the
   model gets a clear message; the read-only query path (D3) is the guarantee, this check is the explanation.
3. Append `LIMIT 201` when the query has no trailing `LIMIT`; lower a trailing `LIMIT` above 201 to 201.
4. Run on `ctx.graph` only, through `roQuery`, under `limits.cypherMs`.

Data `{ rows, truncated }`: at most `limits.cypherRows` (200) rows, `truncated` when a 201st came back. Node and edge
values in the rows become evidence; every scalar is `Quoted`. This is the one query that is not a named constant,
and the Step records its text.

#### `search_files` and `read_file` — read, baseline only

`search_files { text, glob? }` and `read_file { path, offset? }` live in `packages/tools/src/baseline/` (R18). They
read the repository files that ingestion stage 1 fetched for the baseline run, through `deps.files(ctx.runId)`,
never touch the graph, and write nothing but their Step; a path outside the fetched set is a `ToolErr`. Their
output limits are set in [eval](eval.md#baseline-tools).

## Failures

Each failure is a `Fault` from [core](core.md): `ToolError` here, `GraphError`, `PlannerError`, and
`ExecutorError` from the packages behind the tools, each with a dotted `code` and a `surface` code from
[errors.json](../../../contracts/api/errors.json). `callTool` catches it, finishes the Step with `ok: false` and the
safe message as `summary`, passes the `surface` to `hooks.onFinish` as `code`, and returns `ToolErr`; it never
throws to its caller and never logs. The worker logs `tool.call.*` from the hooks (R17).

| Case | Surface code | What the caller sees |
| --- | --- | --- |
| Unknown tool, or not in the actor's set or the toolbox's access levels | `invalid` | "Tool `x` is not available to this agent" |
| Input fails its schema; `read_only_cypher` guard rejects | `invalid` | Each failing path and reason, or the rejected clause |
| Finding, plan, or run not found | `missing` | The key that was not found |
| Plan not approved; already shipped; ship in flight, all raised by the executor | `unapproved`, `shipped`, `busy` | The refusal; the shipment job ends in `pr.refused` with `verification: null` |
| A dependency range the executor cannot rewrite | `range` | The package and its range form |
| FalkorDB, registry, GitHub, OSV, or sandbox failure; timeout | `upstream` | "The graph query timed out after 20 s", with the tool's own `timeoutMs`; retryable |
| Run aborted through `ctx.signal` | `internal` | "The run was cancelled" |
| The Step write itself fails | `internal` | A `ToolErr` whose `stepId` names no stored Step; `onStart` is not called, `onFinish` is |

A refusal after verification is not a failure: `open_pull_request` returns `ok: true` with `outcome: "refused"`.

## Tests

FalkorDB is real (the Docker container); the planner's registry and the executor's GitHub and sandbox adapters are
faked with recorded fixtures; `Clock` and `Ids` are fixed. Tests mirror `src/` under `test/`.

- `fixtures/mini-repo`: 6 files, 12 installs, 3 vulnerabilities, one per tier. `reachability` returns
  `{ import-reachable: 1, installed: 1, dev-only: 1 }`, the expected chain, `files`, and `hops`, and sets
  `Finding.tier`.
- `reachability` zero hops: a production file loading the affected install directly gives `hops: 0`.
- `reachability` with `keys` of one finding writes only that finding's tier.
- Snapshot tests: every tool's `data`, `summary`, and `evidence` against checked-in JSON on mini-repo; every
  evidence edge carries `key`, `fromKey`, and `toKey`, and the Step's `edges` equals the list of edge keys.
- `callTool` with bad input returns `ok: false`, and the graph holds one Step with `ok: false` and the same `stepId`.
- `callTool` with an unknown name and with a tool outside the actor's set each still write one Step.
- `callTool` passes `onStart` the `stepId` and `seq` of a Step that already exists in the graph when the hook runs,
  and a call failing with `missing` passes `onFinish` `ok: false` and `code: "missing"`.
- `callTool` with a tool that exceeds its timeout returns `upstream`, and the Step records `ok: false`; a tool
  declaring `timeoutMs` of 240 s is not cut at 20 s.
- `available` with `["read", "derive"]` for the `mcp` actor holds `reachability` and `list_alerts` and neither
  `record_decision` nor `open_pull_request`.
- Evidence of 400 nodes is capped to 300, edges to cut nodes are dropped, and 300 `TOUCHED` edges exist.
- `forModel` on a 9,000-character result returns at most 6,000 characters of valid JSON with an `omitted` count;
  an advisory summary containing "ignore previous instructions" appears only inside `quoted`.
- `list_alerts` over 45 open findings returns 40 in `findings`, the 40 most severe, with `total` 45.
- `read_only_cypher` with `CREATE` and with `DELETE` fails and the node count is unchanged; a query without `LIMIT`
  returns at most 200 rows with `truncated: true` on a 250-row result; `CALL db.labels()` is rejected.
- `record_decision` twice on one finding links `SUPERSEDES`, stores `tier_at_decision`, and sets `waived`.
- `recall_decisions` staleness, one case per rule through core's `staleness`: expired, now reachable (including a
  null `tier_at_decision`), advisory updated, and a worse vulnerability on the same install; each writes its
  `stale_reason`, and a superseded decision is absent.
- `rank_packages` on mini-repo: `shareBelow` of an install with three of the twelve installs below it is 0.25.
- `owners_for`: an owner of one file with no recent commits scores 3 and outranks an author with two recent
  commits; commits older than 90 days score nothing.
- `open_pull_request` on a plan with `approved: false` returns `unapproved`, and no `verify:` graph and no
  `PullRequest` node exist afterwards; on a shipped plan it returns `shipped` and the plan still has one
  `PullRequest`.
- `open_pull_request` whose verification finds a new reachable finding returns `ok: true` with
  `outcome: "refused"` and the verification; every `CLOSES` target is still `planned`.

## Open points

Decisions are tracked in the [delivery plan](../plan.md#8-decisions).

- **D1, D2, D3** (S1). `shortestPath` placement and zero length, `algo.pageRank`, and the read-only path. If the Node
  client has no read-only query, the text guard in `read_only_cypher` is the only defence, which the P0 rules do not
  accept; the tool is then withheld from every caller until a read-only path exists.
- **D8, D9, D10** (proposed). The second `recall_decisions` call, the UI's ship route calling `open_pull_request`,
  and stable keys on evidence nodes and edges.
- **D15.** Whether any visitor to the hosted build may approve and ship; the tool's checks are unchanged either way.
