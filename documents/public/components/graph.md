# `packages/graph`

`packages/graph` is the FalkorDB adapter. It implements the `Db` and `G` ports defined in [core](core.md), creates
the indexes, and holds every Cypher query in the system as a named constant. Its single responsibility is to be the
only place that talks to FalkorDB and the only place Cypher text is written, so that a Step node and the UI's "show
query" drawer can record the exact text that ran, and so that the query rules below are checked in one package.

| Owner | Tasks | Layer | Depends on |
| --- | --- | --- | --- |
| Shaukat Ali | T03, T11 | Adapter | `@noderunner/core`, `falkordb` |

## Responsibility

It owns the connection, the four operations of the `G` port (`query`, `roQuery`, `batch`, `drop`), the conversion
of FalkorDB result values into plain JSON, `migrate`, and the constants under `src/cypher`. It does not decide what
a query is for: ingestion, the tools, the planner, and the worker choose which constant to run and with which
parameters. It never chooses a graph name; callers pass a `GraphName` built by `graphName` or
`verifyName` in core, and the name never appears inside query text.

Packages read the constants through a separate public entry, `@noderunner/graph/cypher`, which imports only
`@noderunner/core` and `zod`. An application package therefore uses Cypher text without loading the driver, and
depends on the `G` port from core for execution. Only a composition root imports `connect` from the main entry.

```text
packages/graph/src/
  index.ts        connect, migrate, query, write
  client.ts       the Db and G implementation over the falkordb client
  values.ts       FalkorDB nodes, edges, and paths to Json
  cypher/
    index.ts      one namespace per folder or file below
    schema.ts     index creation for repository and advisories graphs
    golden.ts     G1 to G5
    ingest/       repo.ts lockfile.ts imports.ts cache.ts advisories.ts people.ts prune.ts
    tools/        tier.ts alerts.ts chain.ts rank.ts plan.ts owners.ts decisions.ts ship.ts
    memory/       run.ts step.ts
    api/          repos.ts summary.ts subgraph.ts findings.ts plans.ts
```

A constant is written by the person whose package runs it and reviewed by Shaukat. `cache.ts` holds the queries
against the shared `advisories` graph; every other file runs against a repository or verification graph.

## Interface

```ts
// @noderunner/graph
function connect(opts: { url: string; signal: AbortSignal; onError: (error: GraphError) => void }): Promise<Db>;
function migrate(g: G, kind: "repo" | "advisories", signal: AbortSignal): Promise<void>;

// @noderunner/graph/cypher — constant constructors and the constants themselves
function query<R>(name: string, text: string, row: z.ZodType<R>): Query<R>;
function write(name: string, text: string): Query<Record<string, never>>;
export * as schema from "./schema";       // and ingest, tools, memory, api, golden
```

`connect` takes its URL from the composition root, which parsed it with the core environment schema; unlike the
LLD's `connect(url = env.FALKORDB_URL)` the package never reads configuration itself. `onError` receives the
connection failures the client reports between calls, as a `graph.unavailable` error, so that the composition root
logs them: the client emits them as `error` events, and with no listener such an event crashes the process (S1). `Db`, `G`, `Query`, and `Params`
are the core port types. A constant's `name` is `<file>.<constant>`, for example `tier.reachable`.

## Rules for every query

1. Every query is an exported constant built with `query` or `write` in `src/cypher`. Labels, relationship types,
   and property names are literal text; no file under `src/cypher` contains a `${` interpolation.
2. Every value is a parameter. Time is `$now` from the `Clock` port, never `timestamp()`, so tests are exact.
3. Every variable-length pattern has an upper bound of at most `*..15`, and tighter where the use allows.
4. Every read that feeds a tool returns, for each evidence node, `id(n)` and the node's contract key (`lock_path`,
   `path`, `id`, `key`, `handle`, `name`, or `url`), and `id(r)` with both endpoint ids for each evidence edge,
   so the tool can build `EvNode.key` and each edge's `key`, `fromKey`, and `toKey` (C4, R9).
5. Rows hold scalars, lists, and maps, never whole nodes, so each row schema is small and exact.
6. Every read that returns more than one row has an `ORDER BY` on a unique value and a `LIMIT`.
7. Every supply-chain write `MERGE`s on the contract key, stamps `snapshot_sha = $sha`, and is batched with
   `UNWIND $rows` through `batch`.
8. `DELETE` appears only in `ingest/prune.ts` and in the edge replacement of `ingest/people.ts`. No query deletes
   a memory node (`Run`, `Step`, `Finding`, `Plan`, `Upgrade`, `Decision`, `PullRequest`).

`api/subgraph.ts` holds one lookup constant per label, because a label cannot be a parameter and an unlabelled
`MATCH (n) WHERE n.key IN $keys` would scan every node.

A constant fetches facts and never applies a policy that core owns. `decisions.recall` in `tools/decisions.ts`
returns plain rows — each unsuperseded decision with its finding's `tier`, the advisory's `modified` and `severity`,
and the severities of the other vulnerabilities on the same installs — and core's pure `staleness()` decides the
reason over them with the injected clock (R12). `tools/ship.ts` holds the executor's plan load, verification
comparison, and `PullRequest` record; `api/plans.ts` sets `Plan.approved`, `approved_by`, and `approved_at` (R1); and
`api/findings.ts` serves the alert table and the finding drawer (R23).

## Behaviour

1. **Connect.** One client per process, created by the composition root and closed in its `finally`; `close` is
   idempotent. The client reconnects on its own after a dropped connection; a call made while it is down fails with
   `graph.unavailable`. `Db.list` returns the server's graph names that parse as a `GraphName`, sorted, and drops
   any other.
2. **Query.** Sends the constant's text with its parameters, converts each result row through `values.ts`, and
   parses it with the constant's `row` schema. The call honours its `AbortSignal`; each tool's `timeoutMs` is
   applied by the caller's signal. The client cannot cancel a sent query, so the signal releases the caller and the
   server finishes the read up to its own limit: FalkorDB's default stops reads after 1 second (S1), so every call
   sends `TIMEOUT` explicitly — `limits.toolMs` for a constant, `limits.cypherMs` for `roQuery`. FalkorDB ignores
   `TIMEOUT` on writes, which always run to completion.
3. **Batch.** Splits `rows` into chunks of `limits.batchRows` (500), runs the constant once per chunk with
   `$rows` set to the chunk and the shared `params` alongside (for example `$sha`), sequentially, and returns the
   number of rows sent. The signal is checked between chunks. Because every batched write `MERGE`s on a key, a batch
   that fails part-way is repaired by running it again.
4. **Read-only query.** `roQuery` sends free text through the client's `roQuery`, which issues `GRAPH.RO_QUERY`, so
   a write clause is refused by the server rather than by a text filter (D3). Rows come back as JSON, with nodes as
   `{id, labels, properties}`, edges as `{id, relationshipType, sourceId, destinationId, properties}`, and paths as
   `{nodes, edges}`. Rejected text raises `graph.query` with surface `invalid` and FalkorDB's reason, without its
   echo of the query, so the model can correct itself; a graph that was never written raises `graph.query` with
   surface `missing`, because `GRAPH.RO_QUERY` fails on it where `GRAPH.QUERY` would create it. The text rejection
   of `db.` procedures and the appended `LIMIT 200` stay in `read_only_cypher` in [tools](tools.md); this layer
   guarantees only that nothing is written.
5. **Drop.** `drop()` issues `GRAPH.DELETE` only on a `verify:` graph. On any other graph it raises
   `graph.protected`: a repository graph is dropped by an operator, never by code. A verification graph is built by
   a full ingest into `verify:<runId>`, not by copying the repository graph (R6), so the port has no copy operation.
   Dropping a verification graph that does not exist succeeds, so cleanup after a failed verification is safe.
6. **Migrate.** Creates the nine indexes listed in the [graph schema](../../../contracts/graph/schema.md#indexes) on
   a repository graph, or the `PV.key` and `Adv.id` indexes on `advisories`. FalkorDB rejects a second
   `CREATE INDEX` on the same property (S1), so `migrate` reads `CALL db.indexes()` first and creates only the
   missing ones; it is idempotent when run alone, and two concurrent runs on one graph are not supported.

## Golden queries

Checked by hand against demo repository one in T11 before any tool is written, then kept in `cypher/golden.ts` as
the tools' first tests. Each names the outside source it is compared with.

```cypher
// G1 golden.counts — compare with the lockfile's non-root, non-link entries and `npm ls --all`
MATCH (i:Install)
WITH count(i) AS installs, sum(CASE WHEN i.dev THEN 1 ELSE 0 END) AS dev
OPTIONAL MATCH (:Repo {url: $url})-[d:DECLARES]->(:Install)
RETURN installs, dev, count(d) AS direct

// G2 golden.vulns — compare with `npm audit --json` on the same lockfile
MATCH (v:Vuln)-[:AFFECTS]->(i:Install)
WITH v, i ORDER BY i.lock_path
RETURN v.id AS vuln, v.severity AS severity, collect(i.lock_path) AS installs
ORDER BY vuln LIMIT 500

// G3 golden.chain — one vulnerability, the shortest chain from a production file; check by reading the source
MATCH (:Vuln {id: $vulnId})-[:AFFECTS]->(bad:Install)
MATCH (f:File {kind: "prod"})-[:LOADS]->(entry:Install)
WITH f, bad, entry, shortestPath((entry)-[:DEPENDS_ON*1..15]->(bad)) AS p   // projection form (D1)
WHERE p IS NOT NULL
RETURN f.path AS file, [n IN nodes(p) | n.lock_path] AS chain, length(p) AS hops
ORDER BY hops, file LIMIT 1

// G4 golden.loaders — production files that load a package
MATCH (f:File {kind: "prod"})-[:LOADS]->(:Install)-[:OF]->(:Package {name: $package})
RETURN DISTINCT f.path AS file ORDER BY file LIMIT 200

// G5 golden.owners — owners and recent authors of the files from G3
UNWIND $paths AS path
MATCH (f:File {path: path})
OPTIONAL MATCH (o:Person)-[:OWNS]->(f)
OPTIONAL MATCH (c:Person)-[:CHANGED]->(f)
RETURN f.path AS file, collect(DISTINCT o.handle) AS owners, collect(DISTINCT c.handle) AS authors
ORDER BY file
```

G3 is preceded by `golden.direct`, `(f:File {kind: "prod"})-[:LOADS]->(bad)`, because `shortestPath` needs a
minimum length of one and so cannot express the zero-hop case where a file loads the affected install itself. G3
and the tier query in [tools](tools.md) are written in the projection form shown; if S1 shows that FalkorDB accepts
`shortestPath` inside `MATCH`, or rejects both forms, both constants change together (D1).

## Failures

`GraphError extends Fault` with these codes:

| Code | When | Surface code |
| --- | --- | --- |
| `graph.unavailable` | Connection refused, lost, or authentication failed | `upstream` (R21) |
| `graph.timeout` | The caller's signal fired or FalkorDB's own timeout was hit | `upstream`; a tool reports "the query timed out" |
| `graph.query` | FalkorDB rejected the text | `internal` for a constant; `invalid` through `roQuery`, or `missing` when the graph was never written |
| `graph.readonly` | A write clause reached `roQuery` | `invalid` |
| `graph.row` | A row did not match the constant's schema | `internal`; it means the constant and its schema disagree |
| `graph.protected` | `drop()` on a graph that is not `verify:` | `internal` |

A message carries the constant's name and the error class, never parameter values, which may hold repository text.
FalkorDB reports failures only as message text and client class names, so `client.ts` holds the one table that maps
them to these codes.

## Tests

All integration tests run against a real FalkorDB container from `docker compose up falkordb`; nothing is faked.

- `migrate` run twice on an empty graph leaves exactly the nine contract indexes, and on `advisories` exactly two.
- A constant returning `{ key: string }` parses its rows; the same text paired with a schema requiring `hops` fails
  with `graph.row`.
- `batch` with 1,201 rows writes 1,201 nodes, read back with a count; with a signal aborted after the first chunk,
  it raises `graph.timeout` and exactly 500 nodes exist; a second full run leaves 1,201.
- `roQuery("CREATE (:X)")` fails with `graph.readonly` and a count of `:X` afterwards is 0 (D3).
- `drop()` on `verify:t1`, after one node was written to it, removes it from `list()`.
- `drop()` on `repo:acme/api` raises `graph.protected` and the graph is still listed.
- Static: no file under `src/cypher` contains `${`; every constant name is unique; every `*` inside a relationship
  pattern in any constant's text is followed by an upper bound.
- Golden: after ingesting `fixtures/mini-repo`, G1 returns 12 installs, G2 three vulnerabilities, and G3 for the
  reachable one returns the expected chain from its production file.

## Decisions from S1

Spike S1 ran on Oct 15 against FalkorDB 4.22.1 and the `falkordb` client 6.8.0:

- D1: `shortestPath` is accepted only in a `WITH` or `RETURN` projection, as G3 is written; inside `MATCH` it is
  rejected. Its minimum length must be 0 or 1, and `*0..15` returns a zero-length path when both ends are the same
  node. The bound, the direction, and the relationship type are respected, and no path gives `null`. G3 runs as
  written. Whether `golden.direct` and the tier query's zero-hop query fold into one `*0..15` query is for T11 and
  T12 to decide.
- D2: `CALL algo.pageRank('Install', 'DEPENDS_ON') YIELD node, score`, two positional arguments, restricted to that
  label and relationship type. A configuration map is rejected.
- D3: the client's `roQuery` issues `GRAPH.RO_QUERY`; `CREATE`, `MERGE`, `SET`, `DELETE`, and `CREATE INDEX` are
  refused and nothing is written. Read procedures such as `db.indexes` are allowed.
