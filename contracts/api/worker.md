# Worker API

The HTTP contract between the web app and the worker. The worker is a long-running Hono server on Node; the web app
on Vercel proxies every call through its `/api/*` route handlers, so a browser never talks to the worker directly.
Bodies are JSON and are parsed with the zod schemas in `packages/core/src/api.ts`.

## Authentication and limits

- Every request except `GET /healthz` carries `Authorization: Bearer <WORKER_TOKEN>`. The web app's proxy adds it;
  it is never sent to a browser. A missing or wrong token answers `unauthorized`.
- CORS allows only `WEB_ORIGIN`. The worker listens on `PORT`.
- The worker limits `POST /runs`, `POST /repos`, and `POST /plans/:id/ship` to 10 per hour per client. The proxy
  forwards the visitor's address in `X-Forwarded-For`, which the worker trusts only on a request that carries the
  worker token. Over the limit answers `limited`.
- Errors use the body `{ "error": { "code": string, "message": string } }` with the codes in
  [errors.json](errors.json).

## Routes

| Method and path | Body or query | Success | Notes |
| --- | --- | --- | --- |
| `POST /repos` | `{ url, sha? }` | `202 { repoId, jobId }` | Starts ingestion. `repoId` is `owner/name`. A second ingest of the same repository while one runs answers `busy` |
| `GET /repos` | — | `200 { repos: { repoId, sha, ingestedAt, counts }[] }` | From the list of graphs and each `Repo` node |
| `GET /repos/:owner/:name/summary` | — | `200 { funnel, counts, lastRun }` | `funnel` is `{ total, production, reachable, open }`: all alerts, in the production tree, import-reachable, still open after the latest plan |
| `GET /repos/:owner/:name/findings` | `?tier=&status=` | `200 { findings: Finding[] }` | The alert table |
| `GET /repos/:owner/:name/findings/:key` | — | `200 { finding, vuln, path, decisions }` | The finding drawer: advisory, tier, shortest path as evidence, decision history newest first |
| `GET /repos/:owner/:name/subgraph` | `?keys=…&hops=1` | `200 { nodes: EvNode[], edges: EvEdge[] }` | Evidence nodes by stable key plus neighbours, capped at 400 nodes |
| `POST /runs` | `{ repoId, agent, message? }` | `202 { runId }` | `agent` is `triage`, `fixer`, or `baseline`. Refused with `busy` while the repository is ingesting. A fixer run needs an approved, unshipped plan, else `unapproved` |
| `GET /runs/:id` | — | `200 { run, steps, report, plan? }` | Rebuilt from the graph, so it survives a worker restart |
| `GET /runs/:id/plan` | — | `200 PlanDraft` | The run's newest plan as the pull request it would open: title, Markdown body, and each upgrade with the production path behind every finding it closes. `missing` when the run proposed none |
| `GET /runs/:id/events` | `Last-Event-ID` header, `?replay=1` | `text/event-stream` | Replays stored events, then streams live ones. See [events.md](events.md) |
| `POST /plans/:id/approve` | `{ by }` | `200 { approved: true }` | Sets `Plan.approved`, `approved_by`, `approved_at`. The human approval step |
| `POST /plans/:id/ship` | — | `202 { jobId }` | Starts a `ui` run that calls `open_pull_request`; the outcome arrives on the job stream. `unapproved` or `shipped` when refused up front |
| `POST /decisions` | `{ repoId, key, kind, reason, expiresInDays?, by }` | `201 { decisionId }` | Calls `record_decision` in a `ui` run |
| `GET /jobs/:id/events` | — | `text/event-stream` | Ingestion progress ending in `ingest.finished`, or a shipment ending in `pr.opened` or `pr.refused` |
| `GET /healthz` | — | `200 { ok, falkordb, model }` | No token. Booleans only: whether FalkorDB answers and whether a model key is configured |

## Jobs

Ingestion, runs, and shipments execute on an in-process queue: at most two runs at once, at most one ingestion per
repository, and at most one shipment per plan. Live events are held in a ring buffer of the last 500 per run or
job and fanned out to subscribers. Every `step.finished` event is also stored in the graph, so a run view rebuilt
after a restart is complete apart from the streamed text deltas.
