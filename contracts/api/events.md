# Run events

The server-sent event stream between the worker and the web app, and the record from which a finished run is
replayed. The `RunEvent` union in `packages/core/src/events.ts` is its executable form; the UI's run-view reducer is
a pure function over it.

## Streams

| Stream | Route | Ends after |
| --- | --- | --- |
| A run | `GET /runs/:id/events` | `run.finished` |
| An ingestion job | `GET /jobs/:id/events` | `ingest.finished`, or `job.failed` |
| A shipment job | `GET /jobs/:id/events` | `pr.opened`, `pr.refused`, or `job.failed` |

Each event is one SSE message: `id` is a per-stream sequence number starting at 1, `event` is the event's `type`, and
`data` is the event as JSON. A client that reconnects sends `Last-Event-ID` and receives every later event. A
shipment job runs a short `ui` run, so its stream also carries that run's `step.started` and `step.finished`.

## The union

```ts
type RunEvent =
  | { type: "ingest.progress"; stage: Stage; done: number; total: number }
  | { type: "ingest.finished"; report: IngestReport }
  | { type: "run.started"; runId: string; agent: Agent; model: string | null }
  | { type: "step.started"; stepId: string; seq: number; tool: string; input: Json }
  | { type: "step.finished"; stepId: string; ok: boolean; summary: string; evidence: Evidence; ms: number }
  | { type: "message.delta"; text: string }
  | { type: "run.finished"; runId: string; status: "done" | "failed" | "capped"; unverified: boolean; report: string }
  | { type: "pr.opened"; planId: string; url: string; verification: Verification }
  | { type: "pr.refused"; planId: string; reason: string; verification: Verification | null }
  | { type: "job.failed"; code: ErrorCode; message: string };

type Stage = "fetch" | "lockfile" | "imports" | "advisories" | "people" | "prune";
type Agent = "triage" | "fixer" | "baseline" | "mcp" | "ui";
type Verification = { targeted: number; closed: number; stillOpen: string[]; newFindings: string[] };
```

`Evidence` is defined in [tools.md](../mcp/tools.md). `IngestReport` carries the commit, the counts of files,
installs, vulnerabilities, findings, and people, the per-stage timings, and typed warnings. `model` is `null` for
`mcp` and `ui` runs, which call no model.

## Ordering and storage

- Within a run, `step.started` and `step.finished` for one step are adjacent apart from `message.delta` events,
  because tools run one at a time.
- `pr.refused` is sent instead of `pr.opened` when verification finds a new import-reachable finding;
  `verification` is `null` when the refusal happened before verification.
- Every event except `message.delta` is persisted — steps on their `Step` nodes with evidence edges in
  `Step.edges`, the rest on the `Run` — so `GET /runs/:id/events` on a finished run replays it with no model call.
  `?replay=1` compresses the original timing into 25 seconds.
