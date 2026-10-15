# `packages/core`

`packages/core` is the contract every other package builds against: the branded identifiers, the domain types,
the tool envelope, the run events, the ports that hide each vendor, the environment schema, and the two semver
policies that ingestion and the planner share. Its single responsibility is to state the shapes fixed in
[contracts](../../../contracts) as zod schemas and derived types, so that the graph half and the agent and UI half of
the team build against one executable authority. The LLD calls it `packages/shared`; it is renamed under change C1.

| Owner | Tasks | Layer | Depends on |
| --- | --- | --- | --- |
| Sakib Khan, reviewed by Shaukat Ali | T02 | Core | `zod` 4 and `semver` at runtime; `@types/node` and `@types/semver` for types only |

## Responsibility

It owns the identifiers and their constructors (`graphName`, `findingKey`, `purl`), the domain types and their
policies (severity rank, tier, staleness reasons), the `ToolResult` envelope and `ToolDef`, the `RunEvent` union, the
Run API bodies in `api.ts`, the error code table, the named limits, the ports, the environment schema, the OSV range
policies `isAffected` and `lowestFixed`, and the recorded fixture run that the UI and the worker build against.

It does not own any I/O, any Cypher text (that is [graph.md](graph.md)), any adapter, any logging, or any shape that
only one package reads. It imports no framework, driver, HTTP client, or model SDK, so no `falkordb`,
`openai`, `hono`, or `octokit` type appears in a port. `zod` 4 is required because its built-in
`z.toJSONSchema` produces the JSON Schema the model and MCP clients read, which avoids a second dependency.

```text
packages/core/src/
  index.ts      public exports
  ids.ts        branded identifiers and their constructors
  domain.ts     Tier, Severity, Finding, Upgrade, Decision, Verification, IngestReport
  range.ts      OsvRange, isAffected, lowestFixed
  evidence.ts   EvNode, EvEdge, Evidence
  tool.ts       ToolCtx, ToolDef, ToolResult
  events.ts     RunEvent
  api.ts        Run API bodies, designed in worker.md
  errors.ts     ErrorCode, Fault
  limits.ts     every cross-package cap as a named constant
  json.ts       the Json value schema
  env.ts        the environment schema
  ports/        graph.ts registry.ts forge.ts advisories.ts model.ts sandbox.ts clock.ts ids.ts
  fixtures/     run.json and osv/<id>.json, exported through the @noderunner/core/fixtures subpath only
```

## Interface

Every type below is `z.infer` of an exported schema with a `.describe()` on each field; only the types are shown.

```ts
// ids.ts
type GraphName = string & z.BRAND<"GraphName">;   // "repo:<owner>/<name>", "verify:<runId>", or "advisories"
type FindingKey = string & z.BRAND<"FindingKey">; // "<vulnId>|<package>"
type LockPath = string & z.BRAND<"LockPath">;     // "node_modules/a/node_modules/b"
type Purl = string & z.BRAND<"Purl">;
type Sha = string & z.BRAND<"Sha">;               // 40 lowercase hex characters
type RunId = string & z.BRAND<"RunId">;           // also StepId and PlanId, each its own brand
type RepoRef = { readonly owner: string; readonly name: string; readonly sha?: Sha };

function graphName(repo: RepoRef): GraphName;     // lowercased; owner and name must match [A-Za-z0-9._-]+
function verifyName(runId: RunId): GraphName;     // "verify:" + runId, lowercased
const advisoriesName: GraphName;
function findingKey(vulnId: string, pkg: string): FindingKey;
function purl(name: string, version: string): Purl; // pkg:npm/%40scope/name@1.2.3, scope and name encoded apart
```

`purl` corrects the LLD, whose single `encodeURIComponent(name)` encodes the scope separator as `%2F`.

```ts
// domain.ts
type Tier = "import-reachable" | "installed" | "dev-only";
type Severity = "critical" | "high" | "moderate" | "low" | "unknown";
function rank(s: Severity): 0 | 1 | 2 | 3 | 4;   // critical 4 down to unknown 0, written as Vuln.severity_rank (C5)
type FindingStatus = "open" | "planned" | "fixed" | "waived";
type Finding = { key: FindingKey; vulnId: string; package: string; installs: readonly LockPath[];
                 severity: Severity; tier: Tier | null; status: FindingStatus };
type Upgrade = { id: string; kind: "refresh" | "bump" | "override"; package: string; from: string; to: string;
                 semverJump: "patch" | "minor" | "major"; cost: number; closes: readonly FindingKey[] };
type StaleReason = "expired" | "now reachable" | "advisory updated" | "worse vulnerability on same install";
type StaleFacts = { decision: Decision; tier: Tier | null; advisoryModified: number;
                    severity: Severity; others: readonly Severity[] };   // others: vulns on the same installs
function staleness(facts: StaleFacts, now: number): StaleReason | null;  // R12: pure, first matching rule wins
type Decision = { id: string; key: FindingKey; kind: "waive" | "accept" | "reject"; reason: string; by: string;
                  createdAt: number; expiresAt: number | null; tierAtDecision: Tier | null;
                  staleReason: StaleReason | null };
type Verification = { targeted: number; closed: number; stillOpen: readonly FindingKey[];
                      newFindings: readonly FindingKey[] };
type Stage = "fetch" | "lockfile" | "imports" | "advisories" | "people" | "prune";
type Warning = { code: "parse" | "unresolved" | "alias" | "skipped" | "range" | "people";
                 count: number; sample: readonly string[] };   // at most five sample paths or names
type IngestReport = { graph: GraphName; sha: Sha;
                      counts: { files: number; installs: number; vulns: number; findings: number; people: number };
                      warnings: readonly Warning[]; ms: Readonly<Record<Stage, number>> };

// range.ts — OSV semantics over semver.compare, never over semver ranges
type OsvEvent = { introduced: string } | { fixed: string } | { last_affected: string } | { limit: string };
type OsvRange = { type: "SEMVER" | "ECOSYSTEM" | "GIT"; events: readonly OsvEvent[] };
function isAffected(version: string, ranges: readonly OsvRange[]): boolean;
function lowestFixed(version: string, ranges: readonly OsvRange[]): string | null;
function rangesFor(record: OsvRecord, pkg: string): readonly OsvRange[]; // merges every npm `affected` entry
function severityOf(record: OsvRecord): Severity;                      // GitHub's word; MEDIUM is moderate
```

`rangesFor` exists because real advisories list one package in several `affected` entries: GHSA-hrpp-h998-j3pp
gives `qs` nine. `IngestReport` replaces the LLD's `warnings: string[]` with a typed `Warning`, so the UI can group warnings without
parsing text. `rank`, `Tier`, and `StaleReason` are the tier and staleness policy that
[architecture.md](../architecture.md#3-layering) places in core; the queries that apply them live in `packages/graph`.

```ts
// evidence.ts and tool.ts — the envelope of contracts/mcp/tools.md, with EvNode.key from change C4
type EvNode = { id: number; key: string; label: string; name: string; props?: Readonly<Record<string, Json>> };
type EvEdge = { id: number; key: string; type: string; from: number; to: number; fromKey: string; toKey: string };
type Evidence = { nodes: readonly EvNode[]; edges: readonly EvEdge[]; cypher: readonly string[] };
type ToolOk<T> = { ok: true; data: T; summary: string; evidence: Evidence; stepId: StepId };
type ToolErr = { ok: false; error: string; stepId: StepId };
type ToolResult<T> = ToolOk<T> | ToolErr;
type Agent = "triage" | "fixer" | "baseline" | "mcp" | "ui";   // one enum for runs and tool callers
type ToolCtx = { graph: GraphName; runId: RunId; actor: Agent; signal: AbortSignal };
type Access = "read" | "derive" | "act";  // R5; "act" is hidden from MCP unless MCP_ALLOW_WRITES=true
type ToolDef<I extends z.ZodType, O> = {
  name: ToolName;                 // the ten snake_case names plus the baseline's search_files and read_file
  description: string;            // written for the model
  input: I;                       // converted with z.toJSONSchema for the model and MCP
  access: Access;
  timeoutMs: number;              // R3: limits.toolMs, or limits.shipMs for open_pull_request
  run(ctx: ToolCtx, input: z.infer<I>): Promise<{ data: O; summary: string; evidence: Evidence }>;
};
// packages/tools builds its ToolDefs from injected ports (createTools(deps)), so run() takes no dependencies.
type Shipment =
  | { outcome: "opened"; url: string; branch: string; verification: Verification }
  | { outcome: "refused"; reason: "new reachable finding"; verification: Verification };
```

`RunEvent` in `events.ts` is a `z.discriminatedUnion("type", …)` of exactly the ten members in
[events.md](../../../contracts/api/events.md), including `ingest.finished`, `pr.refused`, and `job.failed`;
`step.started.input` is `Json`, not `unknown`. `limits.ts` exports one frozen object: `evidenceNodes` 300,
`evidenceEdges` 600, `modelChars` 6,000, `runCalls` 15, `mcpCalls` 100, `toolMs` 20,000, `shipMs` 240,000,
`cypherMs` 5,000, `cypherRows` 200, `alertRows` 40, `ringEvents` 500, `subgraphNodes` 400, `batchRows` 500,
`maxTokens` 16,000.

### Ports

Each port names a boundary that has a vendor behind it and a fake or recorded double in tests. Nothing else is a port.

```ts
// ports/graph.ts — implemented by packages/graph
type Param = string | number | boolean | null | readonly Param[] | { readonly [k: string]: Param };
type Params = Readonly<Record<string, Param>>;
type Query<R> = { readonly name: string; readonly text: string; readonly row: z.ZodType<R> };
interface G {
  readonly name: GraphName;
  query<R>(q: Query<R>, params: Params, signal: AbortSignal): Promise<readonly R[]>;
  roQuery(text: string, params: Params, signal: AbortSignal): Promise<readonly Json[]>;
  batch(q: Query<unknown>, rows: readonly Params[], params: Params, signal: AbortSignal): Promise<number>;
  drop(): Promise<void>;   // verification graphs only; R6 removed copyTo
}
interface Db { graph(name: GraphName): G; list(): Promise<readonly GraphName[]>; close(): Promise<void> }

// ports/registry.ts — implemented in packages/planner/src/adapters/npm.ts
type Packument = { readonly name: string;
                   readonly versions: Readonly<Record<string, { readonly deps: Readonly<Record<string, string>> }>> };
interface Registry { packument(name: string, signal: AbortSignal): Promise<Packument | null> }

// ports/advisories.ts — OSV; OsvRecord is the parsed subset ingestion reads
type Pair = { readonly name: string; readonly version: string };
type Hit = { readonly id: string; readonly modified: number };
interface Advisories {
  query(pairs: readonly Pair[], signal: AbortSignal): Promise<readonly (readonly Hit[])[]>; // aligned with pairs
  record(id: string, signal: AbortSignal): Promise<OsvRecord | null>;
}

// ports/forge.ts — GitHub
type Commit = { readonly sha: Sha; readonly login: string | null; readonly name: string; readonly at: number;
                readonly files: readonly string[] };
type Change = { readonly base: Sha; readonly branch: string; readonly message: string; readonly title: string;
                readonly body: string; readonly files: readonly { path: string; content: string }[] };
interface Forge {
  head(repo: RepoRef, signal: AbortSignal): Promise<{ branch: string; sha: Sha }>;
  tarball(repo: RepoRef, sha: Sha, signal: AbortSignal): AsyncIterable<Uint8Array>;
  history(repo: RepoRef, sha: Sha, limit: number, signal: AbortSignal): Promise<readonly Commit[]>;
  read(repo: RepoRef, sha: Sha, path: string, signal: AbortSignal): Promise<string | null>;
  propose(repo: RepoRef, change: Change, signal: AbortSignal): Promise<{ url: string; number: number }>;
}

// ports/model.ts, ports/sandbox.ts, ports/clock.ts, ports/ids.ts
// The Model port is vendor-neutral; see llm.md for Carry and the per-provider mapping.
type Carry = { provider: Provider; raw: Json };
type Block = { type: "text"; text: string; carry?: Carry }
           | { type: "tool_use"; id: string; name: string; input: Json; carry?: Carry }
           | { type: "tool_result"; toolUseId: string; name: string; content: string; isError: boolean }
           | { type: "opaque"; carry: Carry };
type Message = { role: "user" | "assistant"; content: readonly Block[] };
type Turn = { stop: "tool_use" | "end" | "limit" | "refusal"; content: readonly Block[];
              usage: { input: number; output: number; cached: number } };
interface Model {
  readonly provider: Provider;
  turn(req: { system: string; tools: readonly { name: string; description: string; schema: Json }[];
              messages: readonly Message[]; maxTokens: number },
       onText: (text: string) => void, signal: AbortSignal): Promise<Turn>;
}
interface Sandbox {
  regenerate(files: { manifest: string; lock: string }, refresh: readonly string[], signal: AbortSignal):
    Promise<{ lock: string }>;
}
interface Clock { now(): number }   // epoch milliseconds
interface Ids { next(): string }    // a ULID; callers brand it
```

| Port | Why it exists | Real adapter | Test double |
| --- | --- | --- | --- |
| `Db`, `G` | FalkorDB is the one database; `Query<R>` parses every row and only accepts named constants | `packages/graph` | none: tests use a real FalkorDB container |
| `Registry` | One packument holds every version and its dependencies, so one call is one fetch the planner can count | npm with memory and disk cache | recorded packuments |
| `Advisories` | OSV batch lookup and full records; the adapter owns chunking (D5) and pagination | OSV HTTP | recorded S2 responses |
| `Forge` | Ingestion, people, and the executor all reach GitHub; `history` hides the partial clone and returns no e-mail addresses | GitHub API and `git` | recorded tarball and commit list |
| `Model` | The agent loop and a recorded run replayed in place of the live model | one adapter per LLM provider ([llm.md](llm.md)) | recorded turns |
| `Sandbox` | Lockfile regeneration in a container with `--ignore-scripts` | Docker | a fixed regenerated lockfile |
| `Clock`, `Ids` | Determinism: no wall clock or random source below the composition root | system clock, `ulid` | fixed sequence |

There is no logger port: core never logs, and application packages report through return values, warnings, and
`onProgress`, which the composition root logs.

### Environment

`env.ts` exports `parseEnv(surface, source)` for the surfaces `worker`, `mcp`, `web`, and `eval`, so each process
validates only what it reads; empty strings count as unset. It is parsed once in a composition root; nothing else reads `process.env`.

| Variable | Read by | Schema | Secret |
| --- | --- | --- | --- |
| `FALKORDB_URL` | worker, mcp, eval | `redis://` or `rediss://` URL; may carry the FalkorDB password | yes |
| `LLM_PROVIDER` | worker, eval | `openai`, `anthropic`, or `gemini`, default `openai` | no |
| `LLM_MODEL` | worker, eval | any model id; the provider's default when unset ([llm.md](llm.md)) | no |
| `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY` | worker, eval | only the selected provider's key is required | yes |
| `GITHUB_TOKEN` | worker | fine-grained token, non-empty | yes |
| `PR_TARGET_OWNER` | worker | GitHub owner name | no |
| `WORKER_URL` | web | URL | no |
| `WORKER_TOKEN` | web, worker | at least 32 characters | yes |
| `PORT` | worker | integer, default 8787; the name hosts set | no |
| `WEB_ORIGIN` | worker | URL, the only CORS origin | no |
| `MCP_GRAPH` | mcp | parsed into a `GraphName` of the `repo:` form | no |
| `MCP_ALLOW_WRITES` | mcp | exactly `true` or `false`, default `false`; `true` also exposes `act` tools | no |
| `MCP_HTTP_PORT` | mcp | optional integer, mapped to transport `{ kind: "stdio" } \| { kind: "http"; port }` | no |
| `MCP_TOKEN` | mcp | at least 32 characters; required when `MCP_HTTP_PORT` is set, checked as a bearer token | yes |
| `SANDBOX_IMAGE` | worker | image reference, default `noderunner-sandbox:1` | no |
| `CACHE_DIR` | worker, eval | path, default `.cache`; holds `registry/` | no |
| `LOG_LEVEL` | worker, mcp | pino level, default `info` | no |

## Behaviour

1. `isAffected(version, ranges)` ignores `GIT` ranges and treats `ECOSYSTEM` like `SEMVER`, since npm versions are
   semver. Within one range the events are sorted by version; an `introduced` opens an interval (`"0"` is the
   lowest version), and the next `fixed` or `limit` closes it exclusively and `last_affected` inclusively. The
   version is affected when any interval of any range contains it. An unparseable version is not affected, and
   ingestion counts it as a `range` warning. Prereleases compare by `semver.compare`, so `1.2.0-rc.1` is below
   `1.2.0`. `// VERIFY` against the S2 fixtures that npm GitHub advisories use `SEMVER` ranges (D5).
2. `lowestFixed(version, ranges)` returns the lowest `fixed` event above `version` that is not itself affected by
   any range, or `null` when none exists, for instance a range closed only by `last_affected`.
3. `graphName`, `verifyName`, and `findingKey` are the only constructors of their brands; each rejects input
   outside its character set rather than escaping it, so a graph name is never built from unchecked text.
4. `fixtures/run.json` is one recorded triage run on `fixtures/mini-repo` as a `RunEvent[]`, with evidence that
   carries real ids and keys. The web reducer and the worker's replay are tested against it from Day 1.

## Failures

`errors.ts` exports `ErrorCode`, the union of the eleven codes in [errors.json](../../../contracts/api/errors.json),
and a table of status and retryability that a test keeps equal to the file. It also exports the abstract base every
package error extends:

```ts
abstract class Fault extends Error {
  abstract readonly code: string;     // stable and dotted, e.g. "ingest.lockfile"
  abstract readonly surface: ErrorCode; // what an HTTP or tool surface answers with
}
```

Core raises one error of its own: `EnvError` (`env.invalid`), thrown by the environment parse with the names of
every missing or malformed variable and never their values; the composition root prints it and exits non-zero.
Constructors such as `graphName` throw a zod error that a surface maps to `invalid`.

## Tests

- `ids`: `graphName({ owner: "Acme", name: "API" })` is `repo:acme/api`; an owner of `a}b` is rejected;
  `purl("@babel/core", "7.24.0")` is `pkg:npm/%40babel/core@7.24.0`; `findingKey` round-trips through its parser.
- `range`, table-driven over two real OSV records in `fixtures/osv`: introduced `0` with fixed `4.17.21`;
  `last_affected` inclusive; two disjoint ranges; a prerelease below a fix; a `GIT` range ignored; an invalid
  version. `lowestFixed` across two ranges skips a fix that a later range still affects, and returns `null` for a
  range with only `last_affected`.
- `domain`: `rank` maps all five severities, and the five values are distinct.
- `events`: every element of `fixtures/run.json` parses as `RunEvent`; each `step.finished` follows its
  `step.started`; the last event is `run.finished`; every evidence node carries a non-empty `key`.
- `env`: a missing `WORKER_TOKEN` and an `MCP_ALLOW_WRITES` of `yes` both fail with both names in one `EnvError`,
  and the message never contains a supplied value.
- `errors`: the `ErrorCode` table equals `contracts/api/errors.json`, read from disk.

Nothing is faked: core has no I/O.

## Open points

- `EvNode.key`, `EvEdge` keys, and `subgraph` taking keys are change C4, still *proposed* as
  [D10](../plan.md#8-decisions).
- `isAffected` against real npm advisories waits on the S2 fixtures (D5).
