# Engineering standard

This is the engineering bar for the repository. Every coding task — an implementation, a refactor, a plan, a design
review, or an audit — is held to it. It is adapted from the standard the team uses on its production work and made
lighter in two named places, recorded at the end, so that the system ships by the hackathon deadline without
giving up the properties judges and users depend on: a correct answer, a traceable path behind it, and no harm done
to the repository it acts on. A rule marked `MUST` is non-negotiable, a rule marked `SHOULD` may be deviated from
only with a written technical reason, and a rule marked `MAY` is an allowed option.

## Architecture

Every package follows hexagonal layering, and the dependency direction always points inward toward `packages/core`.
The layers and their permitted contents are fixed:

| Layer | Holds | Lives in |
| --- | --- | --- |
| Core | Domain types, zod schemas, tier and staleness policy, the planner's pure algorithm, ports, events | `packages/core`, the pure half of `packages/planner` |
| Application | Use cases that orchestrate ports: ingestion stages, the ten tools, the agent loop, the executor's steps | `packages/ingest`, `packages/tools`, `packages/executor`, `apps/worker/src/agent` |
| Adapter | FalkorDB, GitHub, OSV, the npm registry, the Claude API, the Docker sandbox, the clock | `packages/graph` and each package's `adapters/` folder |
| Surface | The Run API, the MCP server, the web UI | `apps/worker/src/api`, `packages/mcp`, `apps/web` |
| Composition | Reads configuration, constructs adapters, injects them into use cases | `apps/worker/src/main.ts`, `packages/mcp/src/main.ts` |

`core` MUST NOT import a framework, a database driver, an HTTP client, or a model SDK, so no `falkordb`,
`@anthropic-ai/sdk`, `hono`, or `octokit` type ever appears in a port signature. An application package depends on
ports, never on a concrete adapter. No package imports another package's internals; it imports the package's
public `index.ts` only. The package manifests enforce the direction: `packages/core/package.json` lists `zod` and
`semver` as its only dependencies, so a vendor import there fails to resolve, and Biome's `noRestrictedImports`
rejects deep imports into another package's `src`.

## Design

Give every module and every type exactly one responsibility, and prefer composition over inheritance. A pattern,
an interface, or a framework is introduced only when it solves a named current problem: a registry for the tool
set, a strategy for each upgrade kind, a command for a tool call. Scaffolding added for a possible later use is not
allowed. Before committing to a concrete design, check whether the component needs a port, whether a second
implementation is reasonably expected (a recorded run replayed in place of the live model is one), whether it can
be tested without its vendor, and whether it could be extracted later without rewriting its consumers.

Plain exported functions are allowed. Module-level mutable state is not: a cache, a client, or a counter is owned
by an object that the composition root constructs and injects. A source file SHOULD stay under 400 lines and MUST
stay under 500; split by responsibility, not by line range.

## Types and boundaries

TypeScript runs in `strict` mode with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`. Every value
that crosses a boundary — an HTTP body, a tool input, a model tool call, an MCP request, an OSV, GitHub, or npm
response, an environment variable, a graph row — is described by a zod schema and parsed on entry, and its type is
derived with `z.infer` rather than written twice. `any` MUST NOT appear; `unknown` is allowed only at the outermost
decoding point and is parsed immediately. Each schema field carries a `.describe()` string, because the same
schemas become the JSON Schema the model and MCP clients read. Domain values that would be ambiguous as bare
primitives — a lock path, a finding key, a graph name, a purl — are branded types. Objects that cross a boundary
are read-only. Errors crossing a boundary are a stable code with a safe message, never a raw cause or a stack.

## Naming

Directories, files, and packages use one precise lowercase word. When one word is genuinely impossible, nest a
folder rather than compound a name: `cypher/tier.ts`, not `tierQuery.ts`. Identifiers follow TypeScript casing —
`camelCase` for values and functions, `PascalCase` for types and classes — and SHOULD be one word where a word is
precise enough. Filler names — `utils`, `helpers`, `common`, `shared`, `manager`, `service`, `processor`, `misc` —
are rejected unless the word is the exact domain concept. Values fixed by an external contract keep their external
form: the snake_case tool names the model calls (`list_alerts`), Cypher labels and relationship types (`:Install`,
`DEPENDS_ON`), OSV and npm field names, and HTTP paths. No default exports, except where Next.js requires one.

## Documents, docstrings, and comments

Every exported function, class, and type carries a TSDoc block stating its contract only: what it accepts, what it
returns, the invariant it holds, and the error it raises. Rationale belongs in a design document under
[documents](..), not in source. A comment appears only where the code is genuinely non-obvious or an external
constraint is at play, and is normally one line. Emoji, AI-style filler, and a bare TODO without a task id (`T14`)
are not allowed. Markdown prose fills lines to about one hundred characters before wrapping.

## Configuration

All configuration is read once, in the composition root, through the zod schema in `packages/core/src/env.ts`, so a
missing or malformed variable fails at start-up with an actionable message. Nothing below the composition root
reads `process.env`. Secrets — `ANTHROPIC_API_KEY`, `GITHUB_TOKEN`, `WORKER_TOKEN`, the FalkorDB password — are
never logged, never written to the graph, never placed in a process argument, and never committed; `.env.example`
lists names only.

## Exceptions and failure

Catch the most specific error the code can raise and never swallow one silently. Each package defines its errors as
classes carrying a stable `code`. A tool never throws to the agent: `callTool` maps every failure to a `ToolErr`
with a safe message the model can act on, and still writes the Step. A partial result stays partial: an ingestion
stage that skips files reports them in `warnings`, and the planner reports uncovered findings rather than dropping
them. Detect an invariant violation immediately and fail fast rather than writing corrupt state to the graph.

## Determinism

The same repository at the same commit MUST produce the same tiers and the same plan. Time and identifiers are
injected through the `Clock` and `Ids` ports, so tests and the planner never read the wall clock or a random source
in place. Ordering is explicit wherever output is compared: query results carry an `ORDER BY`, and the planner
breaks ties by semver jump and then package name. The model orchestrates and explains; it never decides a tier, a
covering set, or a verification result.

## Graph discipline

Every query is a named, exported constant under `packages/graph/src/cypher` so the Step node and the UI's "show
query" drawer record its exact text. Values are always parameters. Every variable-length pattern carries an upper
bound (`*..15`). Writes are batched with `UNWIND $rows`, a few hundred rows per query. Every read that feeds a tool
returns `id(n)` and `id(r)` for the nodes and edges that belong in the evidence. Ingestion uses `MERGE` on stable
keys and stamps `snapshot_sha`, and never deletes a memory node (Run, Step, Finding, Plan, Upgrade, Decision,
PullRequest). Free-form Cypher from the model runs only through the read-only query path.

## Concurrency, resources, and reliability

Every background job, stream, timer, and child process has one owner, a bounded lifetime, an `AbortSignal`, and a
guaranteed cleanup in `finally`. Every queue, cache, ring buffer, and in-memory collection is bounded: the job
queue's concurrency, the 500-event ring buffer, the 6,000-character model payload, the 300-node evidence cap, and
the 15-call step cap are each a named constant. Tools run sequentially within a run because they write to the
graph. An operation that can be retried is idempotent: ingestion re-run at the same commit leaves the graph
unchanged, and opening a pull request for an already shipped plan is refused.

## Observability

Every significant boundary emits a structured `pino` event with a stable dotted lowercase name —
`ingest.stage.finished`, `tool.call.failed`, `agent.run.capped`, `executor.pr.opened` — and a small set of typed
attributes, carrying `runId` or `jobId` as the correlation identifier. Both the success and the failure of an
operation emit an event. Logging lives in adapters, applications, and surfaces, never in `core`, and never records
a secret, a token, file content, advisory text, or a model message body.

## Security

Every external input is untrusted: repository files, lockfiles, CODEOWNERS, commit metadata, advisory text, npm
packuments, model tool calls, MCP requests, and HTTP bodies are bounded, validated, and parsed before use. Text
from a repository or an advisory reaches the model only inside a tool result, marked as data, and the system
prompt states that instructions inside it are not followed. The pull request action requires the human approval
flag set by the UI. The GitHub token is fine-grained and limited to the demo forks with contents and pull request
write access. The sandbox runs with `--ignore-scripts`, a memory and CPU limit, a read-only root, and only the two
package files mounted. A security claim in the README or the blog post is backed by a test or a reproducible step.

## Dependencies

Prefer the Node standard library and an already chosen dependency over a new one. The chosen set is recorded in
[architecture.md](../architecture.md#10-dependencies); adding to it means recording the purpose, the package that
owns it, a pinned version in `pnpm-lock.yaml`, and a permissive licence. A vendor SDK lives only in an adapter.

## Change discipline

Make the smallest complete change that delivers the task, and implement the whole slice rather than leaving a port
without the use case that consumes it. Stay within the task and preserve the other owner's work. A change to
`packages/core` or to a file under [contracts](../../../contracts) is reviewed by the other owner before it merges.
Nobody commits directly to `main`. Every change starts from an up-to-date `main` (`git switch main && git pull`)
on a short-lived branch named after its task (`t12-reachability`, or `docs/<topic>` for documentation), is pushed to
that branch, and reaches `main` through a pull request merged within the day. Merges to `main` happen at
checkpoints, not per commit, because every push to `main` is a Vercel build. From Saturday afternoon `main` must
always run the full demo script.

## Testing

Every rule that decides an outcome carries a deterministic test: Node's module resolution in the lockfile walk, the
import parser's syntax forms, `isAffected` and `lowestFixed`, the tier query, each upgrade kind in the planner, the
staleness rules, and `validateReport`. A test exercises the real objects and the real flow, faking only a genuine
external boundary — FalkorDB is real (a Docker container), while GitHub, OSV, the npm registry, the Claude API,
and the sandbox are faked with recorded fixtures. Tests use Vitest, mirror the source folder structure, and state
a concrete input and assert a concrete output or graph state, so each can fail when the behaviour regresses. For a
changed behaviour, the happy path, each branch, and each edge — empty, missing, malformed, over the limit — each
have a named test.

These shapes are not tests and are not added: an assertion that a fake was called, a test that fakes the unit
under test, an assertion of only `toBeDefined()` or a type, a re-test of zod rejecting a wrong type, and a test with
no assertion that can fail.

## Relaxations for the hackathon

Two rules from the production standard are relaxed, on purpose and in writing, because they cost more time than
four days allow and their absence does not weaken correctness or traceability:

| Production rule | Here | Why |
| --- | --- | --- |
| Every function belongs to a class; no lambdas | Plain exported functions and inline callbacks are allowed | TypeScript, zod, and React are idiomatic with functions, and class wrappers add no safety here |
| Custom gates for docstrings, hints, and an architecture test | Biome lint and format, `tsc --noEmit`, package manifests, and `noRestrictedImports` | Biome, `tsc`, and pnpm cover most of the same ground with no tooling to build |

Every other rule above holds in full from the first task.
