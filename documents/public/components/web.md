# `apps/web`

The web app is the Next.js 15 App Router site judges and developers use: the repository page with the funnel, the
run view with its step timeline, graph canvas, and report, the finding drawer, and the compare page. Its single
responsibility is presentation: it renders worker data and forwards user actions to the worker through its own
`/api/*` proxy, and it holds no domain logic beyond a pure reducer over `RunEvent`.

| Owner | Tasks | Layer | Depends on |
| --- | --- | --- | --- |
| Sakib | T10, T17, T20, T23, T26 | Surface | `packages/core` (`RunEvent`, `EvNode`, `EvEdge`, API schemas); the [Run API](../../../contracts/api/worker.md) over HTTP |

## Responsibility

It owns the routes below, the proxy with its token and the forwarded client address, the run-view state and reducer,
the canvas, and replay playback. It does not tier, plan, validate citations, enforce the rate limit (the worker does,
R22), or decide whether a pull request may open: those answers arrive from the worker, and the worker re-checks every
action the UI requests. A browser never holds `WORKER_TOKEN` and never talks to the worker directly.

## Routes

| Route | Renders | Data |
| --- | --- | --- |
| `/` | `intake`, `cards`, `progress` | `GET /repos` (server), `POST /repos`, `GET /jobs/:id/events` |
| `/r/[owner]/[name]` | `funnel`, `alerts` with a tier filter, `runs`, `launch`; `drawer` | `GET /repos/:owner/:name/summary` and `GET /repos/:owner/:name/findings?tier=&status=` (server component); `GET /repos/:owner/:name/findings/:key` for the drawer |
| `/r/[owner]/[name]/runs/[id]` | `timeline` with `query`, `canvas`, `report` with `plan`, `reviewers`, `actions`; `drawer` | `GET /runs/:id/events`, `GET /repos/:owner/:name/subgraph`, `findings/:key`; `POST /plans/:id/approve`, `POST /plans/:id/ship`, `GET /jobs/:id/events` |
| `/r/[owner]/[name]/compare` | Two `report` panes, baseline and graph agent, side by side | `?baseline=<runId>&graph=<runId>`, `GET /runs/:id` twice |
| `/api/[...path]` | The proxy | The worker |

`?replay=1` on a run route switches it to replay mode. Next.js page and route files keep the default export the
framework requires; every other module uses named exports.

## Layout

```
apps/web/
  app/          layout, the four pages, and api/[...path]/route.ts
  components/   intake.tsx, cards.tsx, progress.tsx, funnel.tsx, alerts.tsx, runs.tsx, launch.tsx,
                timeline.tsx, query.tsx, canvas.tsx, report.tsx, plan.tsx, reviewers.tsx, actions.tsx, drawer.tsx
  state/        view.ts (state and actions), reducer.ts, graph.ts (evidence union and cap),
                citations.ts, style.ts (Cytoscape stylesheet), stream.ts (SSE subscription)
  server/       config.ts (parses WORKER_URL and WORKER_TOKEN once), worker.ts (typed worker client),
                routes.ts (proxy allowlist)
```

`server/` is imported only by server components and route handlers, so the token cannot reach a client bundle.

## Interface

```ts
/** One step as the timeline shows it. */
export type StepView = Readonly<{
  stepId: string; seq: number; tool: string; input: unknown;
  outcome: { kind: "running" } | { kind: "finished"; ok: boolean; summary: string; evidence: Evidence; ms: number };
}>;

/** What the run view's reducer folds `RunEvent`s into. */
export type RunViewState = Readonly<{
  steps: Readonly<Record<string, StepView>>;
  order: readonly string[];                         // step ids by seq
  report: string;                                   // message.delta appended; replaced by run.finished.report
  selected: { kind: "step" | "citation" | "finding"; id: string } | null;
  highlight: { nodes: ReadonlySet<string>; edges: ReadonlySet<string> }; // stable keys, derived from selected
  graph: { nodes: readonly CanvasNode[]; edges: readonly CanvasEdge[]; dropped: number }; // evidence union, 400 cap
  mode: "live" | "replay";
  phase: { kind: "running" } | { kind: "finished"; status: "done" | "failed" | "capped"; unverified: boolean };
  ship: { kind: "none" } | { kind: "shipping"; jobId: string }
    | { kind: "opened"; url: string; verification: Verification }
    | { kind: "refused"; reason: string; verification: Verification | null }
    | { kind: "failed"; code: ErrorCode; message: string };
}>;

export type ViewAction = { type: "select"; target: NonNullable<RunViewState["selected"]> } | { type: "clear" }
  | { type: "shipping"; jobId: string };

/** Pure: no clock, no I/O. Unit-tested against the fixture run. */
export function reducer(state: RunViewState, event: RunEvent | ViewAction): RunViewState;
```

The LLD's `highlight: Set<number>` and single `status` field are replaced: element ids are the stable keys of
[C4](../plan.md#3-changes-from-the-lld) — `EvNode.key` for a node and `EvEdge.key`
(`<fromKey>|<type>|<toKey>`) for an edge (R9) — and the mode and the outcome are two separate unions instead of one
value that mixed them. The shipment's events arrive on the job stream, not the run stream, and fold into `ship`
through the same reducer.

## Behaviour

### Proxy

1. `app/api/[...path]/route.ts` accepts only the method and path pairs in
   [worker.md](../../../contracts/api/worker.md), listed in `server/routes.ts`; anything else answers `missing`.
2. It drops the caller's `Authorization` and cookies, adds `Authorization: Bearer <WORKER_TOKEN>`, forwards
   `Last-Event-ID` and `?replay=1`, caps request bodies at 16 KB, and streams `text/event-stream` responses through
   unbuffered.
3. It sets `X-Forwarded-For` to the visitor's address, the first `x-forwarded-for` entry Vercel sets, replacing any
   value the browser sent. The proxy keeps no rate-limit state: the worker enforces 10 `POST /runs`, `POST /repos`,
   and `POST /plans/:id/ship` per hour per client, keyed on this header, which it trusts only because the request
   carries the token (R22). A `limited` answer passes through like any other error.
4. Worker error bodies pass through unchanged, since they are already safe. An unreachable worker answers `upstream`.
   The proxy logs `web.proxy.failed` with the route and status, never a body or the token.

### Run view

1. On mount, `state/stream.ts` opens an `EventSource` on `/api/runs/:id/events`. The worker replays stored events
   and then streams live ones; on a drop the browser reconnects with `Last-Event-ID`, and the stream closes after
   `run.finished`.
2. The reducer is idempotent per step: a repeated `step.started` or `step.finished` for a known `stepId` replaces
   rather than duplicates. `message.delta` appends to `report`, and `run.finished` replaces `report` with the stored
   final text, since deltas are not persisted and a reconnect may have missed some.
3. `step.finished` merges its evidence into `graph`. A node's element id is its `EvNode.key`, and an edge's is its
   `EvEdge.key`, with `fromKey` and `toKey` as its endpoints, so ids never depend on FalkorDB internal ids and a
   replay after a restart draws the same elements (C4, R9). Past 400 nodes the union stops growing and `dropped`
   counts the rest; the canvas shows the count.
4. Selecting a step or clicking a `[s:<stepId>]` citation highlights that step's evidence by those keys. Selecting a
   finding highlights the evidence of the latest step whose evidence holds the finding's node. A citation naming a
   step not in the run renders as plain text.
5. The ship stream's `pr.opened`, `pr.refused`, and `job.failed` set `ship`; the actions pane shows the link, the
   refusal with its verification, or the failure.

### Graph canvas

Cytoscape.js with `cytoscape-dagre`, left to right, File → Install → Vuln. The layout re-runs, animated, only when
nodes are added, so the graph grows as steps finish. `state/style.ts` maps labels to styles: `File` a grey square,
`Install` a circle sized by PageRank score when `rank_packages` evidence carries one, `Vuln` a diamond coloured by
severity, `Person` a circle with the handle, `Decision` a tag shape, `Package` a rounded rectangle. Selected
elements take the accent colour at full opacity and everything else drops to 15%. The canvas never renders the whole
repository graph: only the evidence union, plus one hop fetched on demand through `subgraph?keys=…&hops=1`, capped
at 400 nodes.

### Funnel

Four horizontal bars from `summary.funnel`: all alerts, in the production tree, import-reachable, and still open
after the plan, each labelled with its number and linking to the alert table filtered to that tier. It is the first
screen in the video, so it is polished before any other component.

### Alert table and finding drawer

The alert table reads `GET /repos/:owner/:name/findings?tier=&status=` (R23), with the funnel's links setting the
filters. Opening a row loads `GET /repos/:owner/:name/findings/:key`: the drawer shows the advisory, severity, tier,
the shortest path as evidence, drawn and highlighted by stable keys like any step's, and the decision history newest
first. Its "Waive with reason" form posts
`POST /decisions { repoId, key, kind: "waive", reason, expiresInDays?, by }`; a reason is required, and the worker
records it in a `ui` run.

### Approve and ship

Approval lives on the plan (R1). The actions pane has two buttons, in order: "Approve plan" posts
`POST /plans/:id/approve { by }`; "Open pull request" is enabled only after approval and posts
`POST /plans/:id/ship`, which answers `202 { jobId }` (R2). The button then subscribes to `/api/jobs/:jobId/events`
and shows progress until the stream ends in `pr.opened`, `pr.refused`, or `job.failed`; the stream also carries the
`ui` run's step pair, which the timeline shows
([C3, D9](../plan.md#8-decisions)). If the fixer agent ships (T27), a "Hand to
fixer" button starts `POST /runs { repoId, agent: "fixer" }` instead, which the worker accepts only for an approved,
unshipped plan, and the view follows the new run.

### Replay and compare

With `?replay=1`, the stream is requested with the same flag; the worker plays the stored events with the timing
compressed to 25 seconds, and the same reducer runs with `mode: "replay"`. No model call is made, which makes replay
the fallback when the live model or network fails during judging. The compare page renders two finished runs side by
side, baseline and graph agent, from `GET /runs/:id`: their reports, step counts, and funnels. It does not read
`eval/results.json` and shows no eval scores; the eval table lives in the README and the video (R20).

## Failures

The UI shows the contract code's message from [errors.json](../../../contracts/api/errors.json) inline where the
action was taken: `limited` on the start and ship buttons with the retry hint, `busy` while the repository ingests,
`unapproved` and `shipped` in the actions pane, a `job.failed` on the ship stream with its code beside the ship
button, `missing` as a not-found page, and `upstream` or `internal` as a
banner suggesting replay. A run that finishes with `unverified: true` shows the report with a visible "unverified
citations" flag rather than hiding it. A dropped stream reconnects automatically; after three failed reconnects
the view offers the replay link.

## Tests

The reducer and the pure modules are tested against the fixture run in `packages/core/src/fixtures`; the proxy is
tested against a local fake worker over HTTP. React rendering is not unit-tested beyond the funnel's widths.

- Folding the fixture run gives its step count in `seq` order, `phase` `finished` with the fixture's status, and a
  `report` equal to the fixture's `run.finished.report`.
- The fixture folded twice from a replayed stream (every event delivered twice) equals the single fold.
- A stream missing every `message.delta` still ends with the full report.
- Selecting the reachability step yields exactly that step's evidence node and edge keys; `clear` empties
  `highlight`.
- The same evidence delivered with different internal ids yields the same element ids.
- Evidence totalling 450 distinct nodes leaves 400 in `graph` and `dropped` at 50.
- `pr.refused` with a verification sets `ship.kind` to `refused` and keeps the new finding keys; with
  `verification: null` it still sets `refused`; `job.failed` sets `failed` with its code.
- `citations.ts` splits `"3 alerts [s:01J9Z…] remain"` into text and one citation, and leaves `[s:]` as text.
- `style.ts` gives a `critical` Vuln the critical colour and a `File` the square shape.
- Proxy: a browser request with no token reaches the fake worker with the bearer token; the response omits it; a
  browser-sent `X-Forwarded-For` is replaced by the visitor's address; a `limited` answer from the fake worker
  passes through as 429; an unlisted path answers `missing`; an SSE response arrives event by event.

## Open points

Decisions are tracked in the [delivery plan](../plan.md#8-decisions).

- **D10** (proposed): stable keys on evidence (C4). The element ids above depend on it.
- **D15** (open): whether any visitor to the hosted build may approve and ship. The token limits the damage to the
  demo forks; the recommendation is a demo passphrase in front of both buttons.
- **`by` is self-asserted.** There is no user identity, so the approver and the waiver's author are typed by the user.
- **`// VERIFY`:** the maximum duration Vercel allows a streamed route handler; a cut stream reconnects, so this
  only costs a reconnect per window.
