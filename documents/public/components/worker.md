# `apps/worker`

The long-running Node process behind the web app: the Run API over HTTP and server-sent events, the in-process job
runner for ingestions, runs, and shipments, and the composition root that builds every adapter and injects it. Its
single responsibility is to accept authenticated requests, schedule the work they start, and stream that work's
events, while the work itself belongs to [ingest](ingest.md), the [agent](agent.md), and the [tools](tools.md).

| Owner | Tasks | Layer | Depends on |
| --- | --- | --- | --- |
| Sakib | T09, T15 | Surface (`src/api`), application (`src/jobs`, `src/agent`), composition (`src/main.ts`) | `packages/core`, `packages/graph`, `packages/ingest`, `packages/tools`, `packages/planner`, `packages/executor`; `hono`, `@hono/node-server`, `p-queue`, `pino`, `ulid` |

## Responsibility

It owns the routes in [contracts/api/worker.md](../../../contracts/api/worker.md), bearer authentication, CORS, the
per-client rate limit (R22), the error body, the job queues and their locks, the per-run and per-job ring buffers
and their fan-out, replay of a stored run from the graph, the creation of every `Run` node except an MCP session's,
the short `ui` run behind each UI action (R8), the `tool.call.*` log events, written from the step hooks it hands to
`callTool` (R17), and process start-up and shutdown.

It does not own the event shapes ([events.md](../../../contracts/api/events.md)), the agent loop, the MCP server and
its `mcp` runs ([mcp](mcp.md)), or any Cypher text. It never takes a graph name from a request: the graph comes from
`graphName(repo)` on the run record or the path.

```text
apps/worker/src/
  main.ts          composition root
  api/             app.ts, auth.ts, limit.ts, repos.ts, findings.ts, runs.ts, plans.ts, decisions.ts,
                   progress.ts, health.ts, stream.ts
  agent/           loop.ts, tools.ts, prompt.ts, report.ts — see agent.md
  jobs/            queue.ts, ring.ts, replay.ts, hooks.ts
  adapters/        claude.ts, recorded.ts, clock.ts, ids.ts
```

## Interface

```ts
// apps/worker/src/api/app.ts
export type AppDeps = {
  readonly jobs: Jobs; readonly db: Db; readonly toolbox: Toolbox; readonly clock: Clock; readonly ids: Ids;
  readonly log: Log;
  readonly config: { readonly token: string; readonly origin: string; readonly model: string; readonly port: number };
};
export function createApp(deps: AppDeps): Hono;

// apps/worker/src/jobs/queue.ts
export interface Jobs {
  ingest(repo: RepoRef, sha?: string): { readonly jobId: string };            // BusyError if one runs
  run(runId: RunId, args: RunArgs): void;                                       // BusyError over MAX_PENDING
  ship(repo: RepoRef, planId: PlanId): { readonly jobId: string };            // BusyError if the plan is shipping
  subscribe(stream: StreamId, lastEventId: number | null, send: (e: Framed) => void): () => void;
  ingesting(repoId: string): boolean;
  stop(signal: AbortSignal): Promise<void>;
}
export type StreamId = { readonly kind: "run" | "job"; readonly id: string };
export type Framed = { readonly id: number; readonly event: RunEvent };

// apps/worker/src/jobs/ring.ts
export class Ring { push(e: RunEvent): Framed; since(id: number): readonly Framed[] | null } // null: evicted

// apps/worker/src/jobs/hooks.ts — the step hooks every callTool from the worker receives
export function stepHooks(log: Log, runId: RunId, emit: (e: RunEvent) => void): StepHooks;
```

Named constants: `RUN_CONCURRENCY = 2`, `INGEST_CONCURRENCY = 2`, `MAX_PENDING = 10`, `RING_SIZE = 500`
(`limits.ringEvents`), `RING_TTL_MS = 600_000` (how long a finished run's or job's buffer is kept),
`SUBSCRIBERS = 20` per stream, `RUN_DEADLINE_MS = 300_000`, `BODY_BYTES = 65_536`, `REPLAY_MS = 25_000`,
`SHUTDOWN_MS = 10_000`, `RATE_LIMIT = 10` per `RATE_WINDOW_MS = 3_600_000`, `RATE_CLIENTS = 10_000`.

## Behaviour

### Routes

The contract is the authority for paths, bodies, and responses; this section records only how each group is served.
Bodies and queries are parsed with the zod schemas in `packages/core/src/api.ts` before a handler runs.

| Group | Served by | Notes |
| --- | --- | --- |
| `POST /repos`, `GET /repos`, `summary`, `subgraph` | `api/repos.ts` | `subgraph` takes stable keys (C4, D10 proposed) and caps at `limits.subgraphNodes` (400) |
| `GET /repos/:owner/:name/findings`, `findings/:key` | `api/findings.ts` | The alert table and the finding drawer (R23); the drawer's path is evidence with stable node and edge keys |
| `POST /runs`, `GET /runs/:id` | `api/runs.ts` | `GET /runs/:id` is rebuilt from the graph and includes `Run.result` and the token counts |
| `POST /plans/:id/approve`, `POST /plans/:id/ship` | `api/plans.ts` | Approval lives on the plan (R1); ship answers `202 { jobId }` (R2) |
| `GET /runs/:id/events`, `GET /jobs/:id/events` | `api/stream.ts`, `api/progress.ts` | `streamSSE` from Hono |
| `POST /decisions` | `api/decisions.ts` | `record_decision` in a `ui` run |
| `GET /healthz` | `api/health.ts` | No token (R11); answers `{ ok, falkordb, model }` as booleans only: a FalkorDB ping and whether a model key is configured; no model call |

Middleware runs in this order: request id and `api.request.finished` logging, CORS, the bearer check (skipped for
`GET /healthz` only), the rate limit, the body limit, then the route. One error handler maps a `WorkerError` to
`{ error: { code, message } }` with the status from [errors.json](../../../contracts/api/errors.json); a zod
failure becomes `invalid`, anything else `internal` with the detail only in the log.

### Run kinds

Every tool call has a `Run` to hang its Step on (R8). `POST /runs` starts `triage`, `fixer`, and `baseline` runs,
which call the model and make at most `limits.runCalls` (15) calls. The worker creates a short `ui` run, with
`model` null, for each UI action: one per `POST /decisions` and one per shipment. `packages/mcp` creates one `mcp`
run per client session, capped at `limits.mcpCalls` (100) calls by the MCP server. `GET /runs/:id` and the run
stream serve all five kinds alike, so the web app shows a decision, a shipment, or an MCP session with its steps and
evidence.

### Starting a run

1. Parse `{ repoId, agent, message? }`. The repository's graph must exist (`missing`) and not be ingesting (`busy`).
2. For `agent: "fixer"`, find the repository's latest plan that is approved and has no `SHIPPED_AS` edge; with none,
   answer `unapproved` (R10). Its id goes into the fixer's kickoff.
3. Create the `Run` node with `id` from `Ids`, `agent`, `model`, `status: "running"`, `unverified: false`, and
   `started_at` from `Clock`, so the id is valid before `202 { runId }` is returned.
4. Enqueue on the run queue. Over `MAX_PENDING` waiting runs answers `busy`. The job owns an `AbortController`
   combining `RUN_DEADLINE_MS` and shutdown, and calls `runAgent` with `emit` bound to the run's `Ring`, the kickoff
   (the message, or the fixer's plan id), and `stepHooks` for logging. The loop writes `result`, `tokens_in`, and
   `tokens_out` on the `Run` when it finishes (R19).

### Approve and ship

`POST /plans/:id/approve { by }` answers `missing` for an unknown plan, then sets `Plan.approved`, `approved_by`,
and `approved_at` from `Clock` and logs `api.plan.approved` (R1). `POST /plans/:id/ship` is the C3 route
(D9 proposed), which lets the UI open the pull request when no fixer runs:

1. Answer `missing` for an unknown plan, `unapproved` unless `Plan.approved` is set, `shipped` if the plan has
   `SHIPPED_AS`, and `busy` while the same plan is shipping. These checks happen before anything is enqueued.
2. Create a job and a `ui` run, enqueue the shipment, and answer `202 { jobId }` at once (R2).
3. The job calls `callTool("open_pull_request", { planId }, { graph, runId, actor: "ui", signal }, hooks)`, whose
   hooks push the `ui` run's `step.started` and `step.finished` into the job's `Ring` and log `tool.call.*`.
4. The job's stream then ends with exactly one outcome: `pr.opened` for an `opened` shipment, `pr.refused` with the
   verification for a `refused` one (R4), `pr.refused` with `verification: null` when the tool refused before
   verification (a race on `unapproved` or `shipped`), or `job.failed` for any other `ToolErr` or a thrown fault.
5. The `ui` run finishes `done` or `failed`, and the job logs `job.ship.finished` or `job.ship.failed` with `jobId`,
   `runId`, and `planId`.

### Jobs

Runs, ingestions, and shipments use `p-queue` instances with `RUN_CONCURRENCY` and `INGEST_CONCURRENCY`; a shipment
counts as a run. At most one ingestion per repository and at most one shipment per plan: a lock keyed by `repoId` or
`planId` is taken before enqueueing and released in `finally`, and a second request for a locked key answers `busy`.
Every job has one owner, an `AbortSignal`, and cleanup in `finally`, and logs `job.run.started`, `job.run.finished`,
`job.ingest.started`, `job.ingest.finished`, `job.ingest.failed`, `job.ship.started`, `job.ship.finished`, or
`job.ship.failed` with its `runId` or `jobId`.

### Step hooks and logging

Tools do not log (R17). Every `callTool` the worker makes, from an agent run or a `ui` run, receives the hooks from
`stepHooks`: `onStart` logs `tool.call.started` with `runId`, `stepId`, and `tool`, and the finish hook logs
`tool.call.finished` or `tool.call.failed` with `ms`. Neither logs an input, a result, or an error's cause. The
agent loop wraps them to also emit `step.started` and `step.finished` ([agent](agent.md#the-loop)).

### Streams and replay

1. Each run, ingestion job, and shipment job has a `Ring` of the last `RING_SIZE` events. `push` assigns the next
   sequence number, starting at 1, and fans the framed event out to at most `SUBSCRIBERS` listeners.
2. A subscriber sends `Last-Event-ID`. When the ring still holds the next id, the stream resumes from it exactly.
3. When a run's ring does not (evicted, expired, or a worker restart), `jobs/replay.ts` rebuilds the run from the
   graph: `run.started` from the `Run`, `step.started` and `step.finished` per `Step` in `seq` order with evidence
   rebuilt from its `TOUCHED` nodes and the edge keys in `Step.edges` (R9), and `run.finished` from the `Run`. Text
   deltas are not stored, so the replay starts at `run.started`, and the web reducer resets on it.
4. `?replay=1` plays the rebuilt events with the original step durations scaled so the whole run takes `REPLAY_MS`;
   no model call is made.
5. A run stream ends after `run.finished`, an ingestion stream after `ingest.finished` or `job.failed`, and a
   shipment stream after `pr.opened`, `pr.refused`, or `job.failed`. A job's ring is not rebuilt after it expires;
   the shipment's outcome stays in the graph as `SHIPPED_AS` and its `ui` run. The Hono abort hook removes the
   listener when the client goes away.

### Authentication, CORS, and the rate limit

Every route except `GET /healthz` requires `Authorization: Bearer <WORKER_TOKEN>`, compared in constant time; a
missing or wrong token answers `unauthorized` and logs `api.request.rejected` without the header. `GET /healthz`
answers booleans only, so a host health check needs no token (R11). CORS allows only `WEB_ORIGIN`. The browser
never reaches the worker, so CORS is a second fence.

The worker enforces the rate limit (R22), because Vercel instances share no memory and the worker is one process:
`POST /runs`, `POST /repos`, and `POST /plans/:id/ship` are limited to `RATE_LIMIT` per hour per client. The client
is the first address in `X-Forwarded-For`, trusted only on a request that passed the bearer check, since only the
web proxy holds the token; without the header the client is the proxy itself. The window is a bounded map of at
most `RATE_CLIENTS` clients, oldest evicted. Over the limit answers `limited` and logs `api.request.limited`.

### Composition root

`main.ts` is the only file that reads `process.env`:

1. Parse the `worker` pick of the schema in `packages/core/src/env.ts`, which includes `PORT` and `WEB_ORIGIN`; on
   failure print the actionable message and exit non-zero.
2. Build the adapters: `pino`, FalkorDB through `connect`, the clock, `ulid` ids, the GitHub, OSV, and npm registry
   clients, the sandbox, the executor, and the `claude` model adapter with `ANTHROPIC_API_KEY` and `MODEL`.
3. Build the toolbox with the planner, the executor, and the baseline tools from `packages/tools/src/baseline/`
   (R18); then the jobs; then the app.
4. Serve with `@hono/node-server` on `PORT`, and log `worker.started` with the port and model id, never a secret.
5. On `SIGTERM` or `SIGINT`: stop accepting, abort every job, wait up to `SHUTDOWN_MS` for the queues to drain,
   close FalkorDB, and log `worker.stopped`. Aborted runs finish `failed`.

## Failures

| Case | Code | Status | Caller sees |
| --- | --- | --- | --- |
| Body or query fails its schema; body over `BODY_BYTES` | `invalid` | 400 | The failing field |
| Missing or wrong bearer token | `unauthorized` | 401 | No detail |
| Ship, or a fixer run, without an approved unshipped plan | `unapproved` | 403 | "The plan has not been approved" |
| Unknown repository, run, plan, job, or finding | `missing` | 404 | The id that was not found |
| Repository ingesting; plan shipping; queue full | `busy` | 409 | Retryable |
| Plan already shipped | `shipped` | 409 | The existing pull request URL |
| No lockfile v2 or v3 | `unsupported` | 422 | Raised by ingestion, reported on the job stream as `job.failed` |
| A dependency range the executor cannot rewrite | `range` | 422 | Raised during a shipment, reported on the job stream as `job.failed` |
| Over the per-client limit | `limited` | 429 | Retryable after the window |
| FalkorDB, GitHub, OSV, registry, sandbox, or model down | `upstream` | 502 | Retryable |
| Anything else | `internal` | 500 | A safe message; detail in the log |

Failures inside a run never become an HTTP error: they end the run `failed` and arrive as `run.finished`. Failures
inside a job arrive as `job.failed` on its stream.

## Tests

FalkorDB is real; the model is the `recorded` adapter; GitHub, OSV, the npm registry, and the sandbox are faked with
recorded fixtures. Requests go through `createApp(...).request()`, so routing, middleware, and parsing are real.

- `auth`: no token and a wrong token each answer 401 with code `unauthorized`; `/runs` with the token answers 202;
  `GET /healthz` with no token answers 200 with exactly the keys `ok`, `falkordb`, and `model`, all booleans.
- `rate limit`: the 11th `POST /runs` within an hour with one `X-Forwarded-For` answers `limited` while another
  address and a `GET` still pass; an `X-Forwarded-For` on a request without the token is never counted as a client.
- `POST /runs`: an invalid body answers `invalid`; an unknown repository `missing`; during an ingestion `busy`; a
  fixer run with no approved plan `unapproved`, and with one, a kickoff naming its id.
- `findings`: on `fixtures/mini-repo` the list filtered by `tier` matches the tier counts, and `findings/:key`
  returns the advisory, the path as evidence with edge keys, and the decisions newest first.
- `run stream`: a recorded triage run streams `run.started`, step pairs, and `run.finished` with ids from 1.
- `resume`: reconnecting with `Last-Event-ID: 3` receives event 4 onward and nothing earlier.
- `restart`: a fresh app with empty rings replays a finished run from the graph, identical apart from deltas.
- `ring`: 600 pushes keep ids 101 to 600; `since(50)` returns null and the stream falls back to replay.
- `queue`: with two runs active a third waits; the eleventh waiting run answers `busy`.
- `ingest lock`: a second `POST /repos` for the same repository answers `busy`; a different repository is accepted.
- `approve`: an unknown plan answers `missing`; a known one sets `Plan.approved`, `approved_by`, and `approved_at`.
- `ship`: unapproved answers 403; approved answers `202 { jobId }`, then the job stream carries the `ui` run's step
  pair and ends with `pr.opened`, and the graph has `SHIPPED_AS`; a second ship answers `shipped`; a recorded
  regression ends the stream with `pr.refused` and its verification; a sandbox failure ends it with `job.failed`.
- `decisions`: `POST /decisions` answers 201, and the graph holds the `Decision`, its `MADE_BY`, and one `ui` run
  with one Step.
- `logging`: one tool call logs `tool.call.started` and `tool.call.finished` with the same `stepId`, and no log line
  carries the input or the token.
- `shutdown`: aborting during a run finishes it `failed` with `finished_at` set, and no listener remains.
- `env`: a missing `WORKER_TOKEN` fails start-up with a message naming the variable.

## Open points

Decisions are tracked in the [delivery plan](../../../nimbalyst-local/plans/noderunner.md#8-decisions).

- **D9** (proposed): the ship route. **D10** (proposed): `subgraph` by stable key.
- **D15** (open): whether any visitor to the hosted build may approve and ship. The recommendation, a demo
  passphrase, would gate `POST /plans/:id/approve` and `POST /plans/:id/ship` here.
- **The code in `job.failed`.** A `ToolErr` carries a safe message but no `ErrorCode`, so a shipment that fails
  inside `open_pull_request` cannot name `range` or `upstream` from the envelope alone. Proposed: the finish hook
  receives the fault's `surface`; a change to [tools](tools.md).
- **Replay timing.** A `Step` stores `ms` but not its start time, so gaps between steps are not replayed.
