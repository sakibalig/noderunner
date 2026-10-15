# Agent instructions

These instructions are mandatory for every contributor and every coding agent — human or model — working in this
repository. Read them in full before you change any tracked or untracked file, and never rely on remembered context
in their place. After a context reset, a handoff, a correction, or a material change of scope, rebuild your
understanding from the repository itself rather than from a summary of it.

Three documents carry the detailed rules, and all three are binding. Read them before you design or edit anything:

- [documents/public/standards/engineering.md](documents/public/standards/engineering.md) — the engineering
  standard: architecture, design, types, naming, documentation, configuration, failure, determinism, observability,
  security, dependencies, change discipline, and testing. It is the bar every change is held to.
- [documents/public/standards/review.md](documents/public/standards/review.md) — the review a change is judged
  against before it merges, and how to run an independent pass over a branch.
- [documents/public/architecture.md](documents/public/architecture.md) — the high-level design: what the system
  is, how it is layered, and how ingestion, a triage run, and the pull request action flow through it.

When this file and a linked standard disagree, the standard wins. When a rule is genuinely unclear, or a material
product or architecture decision underneath it is unresolved, the single correct action is to stop and ask the
owner rather than to guess and proceed as though the matter were settled. Open decisions are listed in the
[delivery plan](documents/public/plan.md#8-decisions); an open row there blocks the work that depends on it.

## Rule strength and authority

Three words fix how strong a rule is. `MUST` is non-negotiable: a change that violates it does not merge without an
explicit, recorded owner exception. `SHOULD` allows deviation only with a written technical reason. `MAY` describes
an allowed option with no obligation either way.

When two sources of truth conflict, they resolve in a fixed order: the two owners approve scope and these standards;
the documents under [contracts](contracts) define behaviour that crosses a process or a team boundary; the
engineering standard defines how that behaviour is built; the component designs under
[documents/public/components](documents/public/components) define each package; and the delivery plan defines
sequence only and never approves behaviour or architecture. A conflict between two authorities is stopped on and
resolved explicitly. Correctness, security, tenant isolation, and any destructive action against a repository or a
graph are never waived implicitly.

## Ownership

The repository has two owners and one boundary between them. The boundary is `packages/core`: its types, schemas,
ports, and events are shared by both halves. For the hackathon, the author merges their own PR once the CI checks
pass; a change to `packages/core` or `contracts/` also gets an independent review pass (review.md) first, and the
other owner is told at the next call.

| Owner | Packages and documents |
| --- | --- |
| Shaukat Ali | `packages/graph`, `packages/ingest` (stages 1–4 and 6), `packages/tools`, `packages/planner`, `packages/executor`, `eval/` labels and runner |
| Sakib Khan | `packages/core`, `packages/ingest` stage 5, `apps/worker` (Run API and agent loop), `packages/mcp`, `apps/web`, `eval/` baseline tools, deployment |

## The P0 rules

These are blockers. A change that violates any of them does not merge regardless of what else it accomplishes.

- **Hexagonal layering is mandatory.** `packages/core` holds the domain types, the policies, and the ports, and
  imports no framework, database driver, HTTP client, or model SDK. FalkorDB, GitHub, OSV, the npm registry, the
  LLM provider, and Docker live behind adapters, and every dependency points inward toward `core`.
- **A typed contract at every boundary.** Every value that crosses a package, process, network, or model boundary
  is described by a zod schema and parsed on entry. `any` is forbidden; `unknown` is allowed only at the outermost
  decoding point and is parsed into a typed value immediately.
- **The graph is bound by the server, never by the model.** No tool, endpoint, or MCP handler accepts a graph name
  from a caller. The name comes from server configuration or the run record.
- **Parameterised, bounded Cypher only.** No value is ever concatenated into a query string, every query is a
  named constant under `packages/graph/src/cypher`, and every variable-length pattern carries an upper bound.
- **No execution of scanned code.** Ingestion parses text only. The one command ever run against repository
  content is lockfile regeneration with `--ignore-scripts` inside the throwaway sandbox container.
- **No ad-hoc flags steering behaviour.** State that drives a decision is a discriminated union or a string-literal
  union with explicit transitions, never a loose boolean threaded through calls.
- **Single-word names.** Directories, files, and packages each use one precise word; a multi-word concept is
  expressed through folder nesting, never a long compound name. Filler names such as `utils`, `helpers`, `common`,
  `manager`, and `service` are rejected.
- **Structured logging only, and never in `core`.** Every significant boundary emits a structured event with a
  stable dotted name; logging lives in adapters and apps, and never records a token, a secret, or file content.

## 1. Understand the work

Before changing tracked files: read the request and identify the expected outcome and the non-goals; inspect the
current working tree; read the component design and the contract that own the affected behaviour; read the
applicable standards; identify the boundaries, state, failures, security, and tests the change touches; and stop
and ask when a material product or architecture decision is unresolved. Never treat remembered context as
repository evidence.

## 2. Design before editing

Resolve every design question below for the next slice before writing a line of it. Give every module and type one
clear responsibility, and do not introduce a dependency, an abstraction, or a framework without a demonstrated
current requirement. Every slice fixes each field of this inventory, and an unresolved field blocks implementation:

| Field | Decision it fixes |
| --- | --- |
| Capability | The one observable outcome the slice delivers |
| Owner | The package and the person responsible for it |
| Layer | Core, application, adapter, surface, or composition |
| Contract | Typed inputs, outputs, invariants, and the zod schema that enforces them |
| Dependencies | The ports required and the direction of every dependency |
| State | Graph nodes and edges written, their keys, lifecycle, and cleanup |
| Failures | Expected failures, how they propagate, and the caller-visible result |
| Files | Files created or changed and the single responsibility of each |
| Tests | The real objects and flow the tests exercise, and the boundary they fake |
| Verification | The focused checks and the merge gate that prove the slice |

## 3. Make the smallest complete change

Deliver the whole cohesive slice — a port and the use case that consumes it land together — but stay within the
requested task and preserve unrelated work. Never commit to `main`: start every change on a new branch cut from an
up-to-date `main`, and merge it through a pull request. Keep policy in `core`, queries in `packages/graph`, and vendor calls in
adapters. Add no speculative feature or future-facing scaffolding; the delivery plan's cut order decides what is
built, and anything past the current day's exit condition waits. Write a comment only where the code is genuinely
non-obvious.

## 4. Verify with evidence

Run the narrowest relevant checks while editing, then the merge gate: `pnpm check` runs Biome lint and format
checks and `tsc --noEmit` across the workspace, and `pnpm test` runs Vitest. A change to ingestion, tools, or the
planner also runs against `fixtures/mini-repo` and, before a day's exit, against demo repository one.

Never label a failure pre-existing, flaky, or unrelated without reproduction. A required check that does not yet
exist is reported as unavailable, never simulated through prose. A scoped run is labelled scoped and is not a
full-suite result, and a test that fakes the unit under test is not evidence of real behaviour.

## 5. Report honestly

Report the outcome, the changed files, the decisions made, the checks run and their exact scope, and any unresolved
risk or blocked check. Distinguish verified fact from inference, proposal, and open risk. Do not claim approval,
completeness, or readiness that has not been demonstrated, and tell the other owner at the next daily call.
