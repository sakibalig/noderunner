---
planStatus:
  planId: plan-noderunner
  title: Noderunner — dependency vulnerability triage agent, delivery plan
  status: ready-for-development
  planType: feature
  priority: high
  owner: tech@drizz.dev
  stakeholders: [Shaukat Ali, Sakib Khan]
  tags: [hackathon, graph-hacks, falkordb, agent, design]
  created: "2026-10-15"
  updated: "2026-10-15T00:00:00.000Z"
  progress: 0
---

# Noderunner delivery plan

Status: **design documented, implementation not started.** Graph Hacks runs from Oct 15, 12:01 AM to Oct 18,
11:59 PM IST; the team submits by **6:00 PM IST on Oct 18** and keeps the last hours for upload and form failures.
This plan fixes sequence only. Behaviour lives in [architecture.md](./architecture.md), the
[component designs](./components), and the [contracts](../../contracts).

## 1. Outcome, scope and non-goals

**Release one is** a hosted triage agent that ingests a public npm repository into FalkorDB, tiers every alert,
plans the cheapest upgrades, names reviewers, opens a verified pull request on the team's fork, remembers waivers
across sessions, and shows the graph path behind every claim — plus a three-minute video, a README, and a blog post.

**Never cut:** the tier query, the evidence highlight, the funnel, and the video.

**Not claimed:** function-level reachability, exploitability, any ecosystem other than npm lockfile v2 or v3, and
private repositories. See [Known gaps](./architecture.md#15-known-gaps).

## 2. Sources

These documents are carried into this repository's design and remain the history of how it was reached:

| Source | What it holds |
| --- | --- |
| [graph-hacks-plan.html](../../../graph-hacks-plan.html) | The hackathon brief, the idea shortlist and scoring, the winning approach, the schedule |
| [hld-vuln-triage-agent.pdf](../../../hld-vuln-triage-agent.pdf) | The high-level design, draft 1, Oct 14 |
| [lld-vuln-triage-agent.pdf](../../../lld-vuln-triage-agent.pdf) | The low-level design and task split, draft 1, Oct 14 |
| [graph-hacks-session.json](../../../graph-hacks-session.json) | The cleaned planning conversation, including the prior-art search |

## 3. Changes from the LLD

Writing the design into this repository changed eight things. Each is reflected in the contracts and components; the
ones marked *proposed* wait on the other owner's agreement (section 8).

| # | LLD said | This repository does | Why |
| --- | --- | --- | --- |
| C1 | `packages/shared` | `packages/core` | "shared" is a filler name under the [naming rule](./standards/engineering.md#naming); `core` names its role as the contract every package depends on |
| C2 | `recall_decisions` runs once, first | It runs again after `reachability` | The "now reachable" staleness rule reads `Finding.tier`, which `reachability` sets, so a single first call lags one run behind. *Proposed* (D8) |
| C3 | `open_pull_request` only in the fixer's tool set | The UI's `POST /plans/:id/ship` also calls it, in a `ui` run | The fixer is first in the cut order; without it nothing could open the pull request. *Proposed* (D9) |
| C4 | Evidence nodes carry the FalkorDB id only | Evidence nodes also carry the node's stable `key`; `subgraph` takes keys | Internal ids can be reused after a prune, so a stored id can point at the wrong node. *Proposed* (D10) |
| C5 | `severity_rank` used in the staleness query, never defined | `Vuln.severity_rank` is written at ingest, `critical` 4 to `unknown` 0 | The query could not run without it |
| C6 | Prune deletes stale `IMPORTS`, `LOADS`, `DEPENDS_ON` | It also deletes stale `DECLARES` and `AFFECTS` | A dependency removed from `package.json` but still installed transitively would keep a stale `DECLARES` edge and stay "direct" |
| C7 | HLD says `list_alerts` writes Findings | Ingestion stage 4 creates Findings; `list_alerts` writes `FOUND` only | One writer per node; the LLD already moved creation to stage 4 |
| C8 | `pr.opened` is the only action event | `pr.refused` added; `ingest.finished` added | The executor's refusal and the end of ingestion are both outcomes the UI must show |

## 4. Tasks

Hours are estimates for focused work. Pre-event tasks (S) are throwaway spikes outside this repository. "Status" is
updated at each evening call.

### Wed Oct 14 — spikes and setup

| ID | Task | Owner | Hours | Needs | Done when | Status |
| --- | --- | --- | --- | --- | --- | --- |
| S1 | FalkorDB in Docker; verify `shortestPath`, `algo.pageRank`, read-only queries, indexes, from the Node client | Shaukat | 2.5 | — | Every `VERIFY` in the component designs has an answer (D1–D4) | done (D1–D3 resolved) |
| S2 | OSV `querybatch` and `/vulns` on 5 packages; npm packument shape; batch size limit | Shaukat | 1 | — | Sample responses saved as fixtures (D5) | done (OSV part; `fixtures/osv`); the npm packument moves to T14 |
| S3 | OpenAI tool-calling loop with one fake tool and streaming; MCP hello-world added to an MCP client | Sakib | 2 | — | Both work end to end | unknown |
| S4 | Pick and fork 3 demo repositories (lockfile v2 or v3, under 1,500 installs, a mix of tiers, CODEOWNERS on one); fine-grained token; FalkorDB Cloud account | Sakib | 2 | — | Repositories listed with pinned commits (D6) | unknown |
| S5 | Read the design together; agree `packages/core` types | Both | 1 | — | Open decisions resolved or assigned | unknown |

### Thu Oct 15 — Day 1, data in the graph

Exit: one real repository in the graph, golden queries G1 to G5 correct.

| ID | Task | Owner | Hours | Needs | Done when | Status |
| --- | --- | --- | --- | --- | --- | --- |
| T01 | Monorepo, tsconfig, Biome, Vitest, docker-compose with FalkorDB, `.env.example` | Sakib | 1.5 | — | `pnpm test` and `docker compose up falkordb` work | done (PR merged) |
| T02 | `packages/core`: types, schemas, events, ports, env loader, fixture run | Sakib | 2 | T01 | Merged by noon | done (PR merged) |
| T03 | `packages/graph`: connect, query, roQuery, batch, migrate | Shaukat | 1.5 | T01 | Integration test creates and reads nodes | done (PR merged) |
| T04 | Ingest stage 1: tarball fetch and filter | Shaukat | 1.5 | T03 | Demo repository 1 fetched in under 10 s | done (PR merged); `nestjs/nest` as a stand-in for D6 fetched in 2.1 s |
| T05 | Ingest stage 2: lockfile parser, Node resolution, writes | Shaukat | 3 | T04 | Nested-lockfile test passes; G1 matches | done (PR merged); G1 equals the raw lockfile on `nestjs/nest` (1,638 installs, 97 direct) |
| T06 | Ingest stage 3: imports, resolution, classification, `LOADS` | Shaukat | 3 | T04 | Syntax-form tests pass; G4 correct | done (PR merged); G4 equals a text search on `nestjs/nest` for `rxjs` (121 files) and `reflect-metadata` (6) |
| T07 | Ingest stage 4: OSV, advisory cache, `isAffected`, Findings | Shaukat | 2.5 | T05 | G2 matches `npm audit` within explained differences | done (PR merged); cache deferred; G2 and `npm audit` agree on all 56 advisories of `nestjs/nest` |
| T08 | Ingest stage 5: CODEOWNERS and git history | Sakib | 2 | T03 | G5 correct on demo repository 1 | done (PR merged) |
| T09 | Worker: Hono, `/healthz`, `POST /repos` with job queue and job SSE, `GET /repos`, `summary` | Sakib | 3 | T02 | Ingest triggered over HTTP with live progress | in review (feat/t09-worker) |
| T10 | Web shell: home, repository page, funnel and alert table on fixture data | Sakib | 3 | T02 | Pages render from fixtures | in review (feat/t10-web) |
| T11 | Golden queries G1 to G5 checked by hand | Shaukat | 1 | T05–T07 | Day 1 exit met | todo |

### Fri Oct 16 — Day 2, the agent works from the command line

Exit: a CLI run on demo repository 1 gives a correct plan with citations and a stored trail.

| ID | Task | Owner | Hours | Needs | Done when | Status |
| --- | --- | --- | --- | --- | --- | --- |
| T12 | `callTool`, Step writes, `reachability` with the tier query | Shaukat | 3 | T11 | Tier counts on mini-repo and demo repository 1 match labels | done (PR merged); mini-repo tiers exact; demo repository 1 waits on D6 and labels on T24; on `nestjs/nest` 12 reachable, 44 dev-only, three chains checked by hand |
| T13 | Remaining read tools and `record_decision`, `read_only_cypher` | Shaukat | 4 | T12 | Snapshot tests pass | done (PR merged); five tools built and tested on mini-repo and `nestjs/nest`; `owners_for` moves to T14, `rank_packages` deferred |
| T14 | Planner with registry client and cache; `plan_upgrades` | Shaukat | 5 | T12 | Unit cases pass; plan on demo repository 1 checked by hand | done (PR merged); with `owners_for`; on `nestjs/nest` 4 upgrades close 12 findings at cost 7, checked by hand |
| T15 | Run endpoints: `POST /runs`, run SSE with replay, `GET /runs/:id`, `subgraph`, `approve`, `ship`, `decisions` | Sakib | 2.5 | T09 | curl can start a run and stream it | todo |
| T16 | Agent loop, triage system prompt, step cap, report validator | Sakib | 5 | T02, then T12 | Day 2 exit met | todo |
| T17 | Run view: reducer, step timeline, report panel with citations, live SSE | Sakib | 3.5 | T15 | A live run renders end to end | todo |
| T18 | MCP server, stdio and HTTP, read-only by default | Sakib | 1.5 | T13 | An MCP client answers "which alerts are reachable" through it | todo |

### Sat Oct 17 — Day 3, visible, acting, deployed

Exit: the full demo script runs on the hosted build; feature freeze at midnight.

| ID | Task | Owner | Hours | Needs | Done when | Status |
| --- | --- | --- | --- | --- | --- | --- |
| T19 | Ingest stage 6: prune, re-ingest, Finding status; staleness rules | Shaukat | 2 | T13 | Re-ingest at a newer commit keeps decisions and flags stale ones | done (PR merged), with `ingest()` and the worker's real ingester and graph catalog; staleness rules shipped in T13 |
| T20 | Graph canvas: layout, styles, highlight, citation linking | Sakib | 4 | T17 | Clicking a citation highlights the right path | todo |
| T21 | Executor: `package.json` edit, sandbox image, lockfile regeneration, Git Data API push, pull request | Shaukat | 4 | T14 | A real pull request on fork 1 | todo |
| T22 | Verification re-ingest and the pull request description | Shaukat | 2 | T21 | The description shows correct closed counts | todo |
| T23 | Finding drawer, waive with reason, approve and ship buttons | Sakib | 2.5 | T17 | Waive in the UI; a new run respects it | todo |
| T24 | Eval: labels for 3 repositories, baseline tools, runner, results table | Both | 3 | T16 | `eval/results.md` generated | todo |
| T25 | Deploy worker, web, and FalkorDB Cloud; pre-load demo repositories and runs | Sakib | 2 | T17 | Hosted smoke check passes | todo |
| T26 | Replay mode and compare page | Sakib | 1.5 | T20 | Replay plays a finished run with no model call | todo |
| T27 | Fixer agent and "Hand to fixer" button (should) | Shaukat | 2 | T21 | A fresh session opens the pull request from graph state alone | todo |
| T28 | Run the full demo script on the hosted build; bug list | Both | 1 | all | Day 3 exit met | todo |

### Sun Oct 18 — Day 4, ship by 6:00 PM IST

| ID | Task | Owner | Hours | Needs | Done when | Status |
| --- | --- | --- | --- | --- | --- | --- |
| T29 | Bug fixes from T28 only; no new features | Both | 3 | T28 | The demo script runs three times in a row | todo |
| T30 | README: problem, schema diagram, setup, FalkorDB features used, eval table, prior art | Shaukat | 2 | T24 | A new reader can run it from the README | in review (feat/t30-triage), with `pnpm triage` as its runnable quickstart; real results on `nestjs/nest` stand in for the eval table until T24 |
| T31 | Record and edit the demo video, about 3 minutes | Sakib | 3 | T29 | Uploaded; the link works when logged out | todo |
| T32 | Blog post for the side prize | Shaukat | 2.5 | T24 | Published and linked from the README | todo |
| T33 | Submission form, track selection, final checks | Both | 0.5 | T30–T32 | Submitted by 6:00 PM IST, confirmation saved | todo |

## 5. Load and critical path

| Day | Shaukat (h) | Sakib (h) | Critical path |
| --- | --- | --- | --- |
| Wed Oct 14 | 4.5 | 5 | S1, because the tier query depends on it |
| Thu Oct 15 | 12.5 | 11.5 | T03 → T04 → T05 → T07 → T11 |
| Fri Oct 16 | 12 | 12.5 | T12 → T14, with T16 waiting on T12 |
| Sat Oct 17 | 14 | 14 | T14 → T21 → T22 |
| Sun Oct 18 | 8 | 6.5 | T29 → T31 → T33 |

Shared tasks are counted in full for each person. On Thursday, if T05 or T06 overruns, Sakib takes T07 after T09,
since it touches only the graph package and OSV. Saturday is the heaviest day for both, and T27 is its release
valve.

## 6. Cut order

If a day's exit condition is missed at the evening call, cut the next morning in this order:

1. T27, the fixer agent. Two-agent handoff becomes future work in the README.
2. T26, the compare page. The eval table goes in the README and the video instead.
3. Stage 5 history. CODEOWNERS only.
4. Two-hop bump candidates. One hop plus override.
5. T21, the executor. Show the plan and a generated pull request description without opening it.

## 7. Working agreement

- Two 10-minute calls a day, at 10:00 and 18:00 IST: done, next, blocked. The evening call checks the day's exit.
- The author merges their own PR once CI passes. Changes to `packages/core` or `contracts/` get an independent
  review pass first and are announced at the next call.
- No direct commits to `main`: branch from an up-to-date `main` per task (`feat/t12-reachability`), push the branch,
  and merge through a pull request within the day.
- Definition of done: the task's tests pass with `pnpm test`, `pnpm check` is clean, any new Cypher is in
  `packages/graph/src/cypher`, and the other owner is told at the next call.

## 8. Decisions

| # | Decision | Owner | Status |
| --- | --- | --- | --- |
| D1 | `shortestPath` placement inside `MATCH`, and its minimum length; fallback is `algo.BFS` or a bounded match with `LIMIT 1` | Shaukat | **Resolved** on Oct 15 (S1): projection only (`WITH` or `RETURN`), minimum length 0 or 1, bound respected; see [graph.md](./components/graph.md#decisions-from-s1) |
| D2 | `algo.pageRank` name, signature, and whether it can be limited to `DEPENDS_ON` | Shaukat | **Resolved** on Oct 15 (S1): `algo.pageRank('Install', 'DEPENDS_ON')`, restricted to that label and type |
| D3 | How the Node client runs a read-only query | Shaukat | **Resolved** on Oct 15 (S1): the client's `roQuery` sends `GRAPH.RO_QUERY`, and the server refuses every write clause |
| D4 | How verification builds its graph | Both | **Resolved** on Oct 15: a fresh ingest into `verify:<runId>` with both package files overridden; `GRAPH.COPY` is not used (R6) |
| D5 | OSV `querybatch` size limit (500 assumed) | Shaukat | **Resolved** on Oct 17 (S2): 1,000 queries per batch; 1,001 is rejected with "too many queries" |
| D6 | The three demo repositories and their pinned commits; one must have a waivable finding whose install a more severe advisory also affects, for the memory segment of the demo | Sakib | **Open — S4** |
| D7 | The hackathon rules: judging weights, whether pre-event code is allowed, whether a deployment is required, one track or several, what the submission form asks | Both | **Open** — the Rules and Schedule tabs and the FAQ were never read |
| D8 | Re-check staleness after `reachability` (C2) | Both | **Proposed** |
| D9 | The UI's ship route calls `open_pull_request` when no fixer runs (C3) | Both | **Proposed** |
| D10 | Stable keys on evidence nodes (C4) | Both | **Proposed** |
| D11 | Name the project and the package scope `noderunner` | Both | **Resolved** on Oct 15 |
| D12 | Engineering standard: the production standard, adapted and lighter for the hackathon | Sakib | **Resolved** on Oct 15 |
| D13 | Fill one of the two empty team seats with someone for video or design | Both | **Open** |
| D14 | Where the sandbox runs on the hosted build. Fly.io and Railway give the worker no Docker daemon. Options: a second machine with Docker; npm as an unprivileged child process in a temporary directory holding only the two package files; or regenerate locally and ship from a laptop for the demo | Both | **Open** — recommended: the child process, since `--ignore-scripts` and the absent repository code carry the safety, not the container |
| D15 | Whether any visitor to the hosted build may approve and ship. The token is limited to the demo forks | Both | **Open** — recommended: gate approve and ship behind a demo passphrase |
| D16 | The LLM provider | Both | **Superseded by D17** — was, on Oct 15: OpenAI through the `openai` SDK and the Responses API, `gpt-5` by default and `gpt-5-mini` as the fallback; the `Model` port keeps the agent loop provider-neutral |
| D17 | Vendor-neutral LLM providers | Sakib | **Resolved** on Oct 15: one provider per deployment via `LLM_PROVIDER`; the port supports OpenAI, Anthropic, and Gemini; only the OpenAI adapter is built before the deadline; one hand-written adapter per provider ([llm.md](components/llm.md)) |

## 9. Risks

| Risk | Mitigation |
| --- | --- |
| Ingestion takes all of Day 1 and Day 2 | npm only; import-level only; hand-load one repository if the parser is not working by Thursday evening |
| Model-written Cypher fails live | Typed tools for every step of the demo; free-form Cypher is never on the demo path |
| The hosted demo breaks during judging | The video is the primary artefact; pre-loaded graphs and replayable runs need no model call |
| The tier query is slow on a large tree | It pairs every finding with every production-loaded install before `shortestPath`; measure it on the largest demo repository during T12 and switch to per-finding queries if it exceeds 500 ms |
| The UI gets no time | The funnel, the run view, and the path highlight are musts; everything else in the UI is optional |
| Sakib carries 11.5 to 14 hours a day plus the video | D13; otherwise the cut order |

## 10. Reconciliation, Oct 15

Writing the twelve component designs in parallel surfaced conflicts between the LLD, the contracts, and the
designs themselves. Each was settled as below; the contracts moved to version 0.2.0, and `core.md` is the canonical
statement of every type and port. Where a component design still disagrees with a row here, the row wins.

| # | Conflict | Resolution |
| --- | --- | --- |
| R1 | Approval was a flag on the run, but the fixer acts in a later run | Approval lives on the plan: `Plan.approved`, `approved_by`, `approved_at`, set by `POST /plans/:id/approve` |
| R2 | The ship result had no stream: the run stream ends at `run.finished` | `POST /plans/:id/ship` starts a job; its stream ends in `pr.opened`, `pr.refused`, or `job.failed` |
| R3 | A 20 s tool timeout cannot cover the sandbox and verification | Each `ToolDef` declares `timeoutMs`; 20 s by default, 240 s for `open_pull_request` |
| R4 | A refusal after verification could not carry the verification | `open_pull_request` returns the `Shipment` union; a refusal is a successful call |
| R5 | Every state-changing tool counted as "writes", so read-only MCP hid `reachability` | `access` is `read`, `derive`, or `act`; MCP shows `read` and `derive` by default |
| R6 | Copy-then-partial-re-ingest verification pruned nothing and lost `LOADS`; the lockfile override ignored `package.json` | Verification is a full ingest into `verify:<runId>` with `override: { manifest, lock }`, re-streaming the tarball at the repository's `snapshot_sha` so the source files are identical; `G.copyTo` is removed |
| R7 | `step.started` needed a step id before `callTool` made one | `callTool` creates the Step first and takes `StepHooks` — `onStart` and `onFinish`, the latter with the fault's error code — from which the worker emits events and logs |
| R8 | UI decisions and MCP calls had no run for their Steps | Each UI action is a short `ui` run; each MCP session is one `mcp` run capped at 100 calls |
| R9 | Replay could not rebuild evidence edges | `EvEdge` carries `key`, `fromKey`, `toKey`; `Step.edges` stores the edge keys |
| R10 | The fixer could neither wait for approval nor find its plan without free-form Cypher | A fixer run can only start for an approved, unshipped plan, and the worker puts the plan id in its kickoff message |
| R11 | `/healthz` needed the token that host checks never send | `/healthz` is unauthenticated and answers booleans only |
| R12 | The staleness query mixed aggregates in `CASE`, read the wall clock, and ignored a null `tier_at_decision` | `graph` fetches plain rows; the staleness rule is a pure function in `core` over them and the injected clock; a null tier counts as not reachable |
| R13 | `owners_for` weighting and `shareBelow` were undefined | Defined in [tools.md](../../contracts/mcp/tools.md#the-tools) |
| R14 | 100 alert rows overflow the 6,000-character model payload | `list_alerts` returns the 40 most severe and counts the rest |
| R15 | 4,096 output tokens is too low once reasoning counts toward the limit; reasoning items must be returned unchanged | `max_output_tokens` 16,000; the `Model` port carries an `opaque` block passed back verbatim and a `refusal` stop |
| R16 | Cypher form differed between `graph.md` and `tools.md` | `graph.md` is canonical: named `Query<R>` constants with row schemas under `cypher/` |
| R17 | `tools.md` injected a logger; `core.md` has no logger port | Tools do not log; the worker logs `tool.call.*` from the step hooks |
| R18 | Baseline tools were placed and named differently | `packages/tools/src/baseline/`, `search_files { text, glob? }`, `read_file { path, offset? }` |
| R19 | Scoring needed a structured answer and token usage | Every agent report ends in a fenced `result` block stored as `Run.result`; `Run.tokens_in` and `tokens_out` are recorded |
| R20 | The compare page would need `eval/results.json`, outside the web app's dependencies | The compare page shows two runs side by side; the eval table lives in the README and the video |
| R21 | FalkorDB failures had no error code | `upstream` covers FalkorDB and the sandbox; `range` added for an unrewritable dependency range |
| R22 | The rate limit in a Vercel proxy is per instance | The worker enforces it, keyed on `X-Forwarded-For` from an authenticated proxy |
| R23 | The alert table and the finding drawer had no routes | `GET /repos/:owner/:name/findings` and `findings/:key` added |
| R24 | The LLD's `sh -c "... $REFRESH_PKGS"` put lockfile text into a shell string | Package names are checked and passed as arguments to a fixed script, with no shell |
| R25 | Sandbox egress and memory: unrestricted bridge network; `--memory 1g` on a 1 GB host | Egress recorded as a known gap; the sandbox gets 768 MB and the worker host 2 GB, pending D14 |
| R26 | `semver` in core contradicted "zod only" | Core depends on `zod` and `semver`; the standard is amended |
| R27 | A finding whose install kept its lock path but moved to a fixed version kept its `AT` edge and never became `fixed` | `AT` carries `snapshot_sha` and is pruned with the other supply-chain edges; `Vuln.ranges` is keyed by package name |
