# Deployment and configuration

> **As built (D14):** the demo runs locally only; see the [runbook](../runbook/deploy.md). The hosted parts of
> this design (FalkorDB Cloud, Fly.io, Vercel) were not built.

How Noderunner is configured, run locally, and hosted for judging, and how the demo is protected on the day. Its
single responsibility is that the three-minute demo script below runs on the hosted build from `main`, and that a
failure of the model, the network, or GitHub during judging degrades to a replay instead of a broken screen. This is
C13 in the LLD.

| Owner | Tasks | Layer | Depends on |
| --- | --- | --- | --- |
| Sakib | T25 | Composition and hosting | `packages/core/src/env.ts`; the composition roots of `apps/worker`, `packages/mcp`, `apps/web`, and `eval` |

## Responsibility

It owns the environment schema's variable list, `docker-compose.yml`, `.env.example`, the hosted topology, the
sandbox image's build and placement, pre-loading, the smoke check, and the runbook. It does not own any behaviour:
each component reads only the variables listed for it, once, in its composition root.

## Configuration

Every variable is parsed by the zod schema in `packages/core/src/env.ts`; each composition root parses the subset
it needs, so a missing or malformed variable fails at start-up with the variable named. Nothing below a composition
root reads `process.env`. `.env.example` lists names only.

| Variable | Read by | Secret | Example or default |
| --- | --- | --- | --- |
| `FALKORDB_URL` | worker, mcp, eval | Yes; it may carry the FalkorDB password (hosted) | `redis://localhost:6379` |
| `LLM_PROVIDER` | worker, eval | No | `openai`; or `anthropic`, `gemini` |
| `LLM_MODEL` | worker, eval | No | the provider's default, see [llm.md](llm.md) |
| `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY` | worker, eval | The selected provider's | — |
| `GITHUB_TOKEN` | worker | Yes | Fine-grained, the demo forks only, contents and pull requests write |
| `PR_TARGET_OWNER` | worker | No | The team account that holds the forks |
| `WORKER_URL` | web | No, but server-side only | `http://localhost:8787` |
| `WORKER_TOKEN` | web, worker | Yes | At least 32 characters; a random value, different per environment |
| `PORT` | worker | No | `8787`, the default; hosts set it themselves |
| `WEB_ORIGIN` | worker | No | `http://localhost:3001`; the Vercel domain when hosted; the only CORS origin |
| `MCP_GRAPH` | mcp | No | `repo:acme/api` |
| `MCP_ALLOW_WRITES` | mcp | No | `false`, the default; `true` also shows the `act` tools |
| `MCP_HTTP_PORT` | mcp | No | Unset means stdio |
| `MCP_TOKEN` | mcp | Yes | At least 32 characters; required when `MCP_HTTP_PORT` is set, checked as a bearer token |
| `SANDBOX_IMAGE` | worker | No | `noderunner-sandbox:1`, the default |
| `CACHE_DIR` | worker, eval | No | `.cache`, the default; holds `registry/` |
| `LOG_LEVEL` | worker, mcp | No | `info`, the default |

The table is the one in [core](core.md#environment), which is canonical. `MCP_ALLOW_WRITES` is parsed as the literal
`"true"` or `"false"`, never with a truthiness coercion, so the string `"false"` cannot expose the `act` tools.
Secrets live in `.env` locally and in each host's secret store; they are never logged, written to the graph, passed
to the sandbox, or placed in a process argument.

## Local

`docker compose up` brings up three services:

| Service | Image or build | Ports | Notes |
| --- | --- | --- | --- |
| `falkordb` | `falkordb/falkordb`, pinned by digest | 6379, 3000 (the FalkorDB Browser) | A named volume for its data, so pre-loaded graphs survive a restart |
| `worker` | `apps/worker`, run with `tsx` | 8787 (`PORT`) | `FALKORDB_URL=redis://falkordb:6379`, `WEB_ORIGIN=http://localhost:3001`; mounts the Docker socket for the sandbox |
| `web` | `apps/web`, `next dev` | 3001 | `WORKER_URL=http://worker:8787` |

The sandbox image is built once with `docker build -t noderunner-sandbox:1 docker/sandbox` and is not a service; the
worker starts one container per lockfile regeneration ([executor](executor.md#the-sandbox)).

**The Docker socket.** Mounting `/var/run/docker.sock` into the worker gives it root-equivalent control of the
host's Docker daemon. That is acceptable only on a developer machine with the worker bound to localhost. The
alternative is to run the worker on the host with `tsx watch` and only FalkorDB in Compose, which needs no mount.

## Hosted

| Piece | Where | Notes |
| --- | --- | --- |
| Web | Vercel, deploying from `main` only | Other branches are disabled with `git.deploymentEnabled` in `vercel.json`, because every push is a build |
| Worker | One 2 GB machine on Fly.io or Railway (R25) | Long-running, so a one-to-two-minute run is not cut off by function limits; `WORKER_TOKEN` shared with Vercel only; the host's health check calls `GET /healthz` with no token |
| FalkorDB | FalkorDB Cloud | TLS URL with a password; holds the three demo graphs and the `advisories` cache |
| Sandbox | Open, [D14](../plan.md#8-decisions); see below | Limited to 768 MB of memory (R25) |

CORS on the worker allows only `WEB_ORIGIN`, the Vercel domain, and the browser reaches the worker only through the
[web proxy](web.md#proxy). The worker enforces the rate limit, keyed on the `X-Forwarded-For` the proxy sends with
the worker token (R22); nothing is configured on Vercel for it.

**The sandbox on the host (D14, open).** Neither a Fly.io Machine nor a Railway service gives the worker a Docker
daemon. The options recorded in the plan:

1. A second machine with Docker, reached through a remote `Sandbox` adapter. New code and a second host.
2. npm as an unprivileged child process of the worker, in a temporary directory holding only the two package files,
   with `--ignore-scripts`, behind the same `Sandbox` port.
3. Regenerate locally and ship from a laptop for the demo, with shipping disabled on the hosted build.

The plan's recommendation is option 2, since `--ignore-scripts` and the absence of any repository code carry the
safety, not the container. Whichever is chosen, the sandbox gets 768 MB and the worker host 2 GB, so a regeneration
cannot starve the worker (R25). Sandbox egress is not restricted to the npm registry; it is recorded as a
[known gap](../architecture.md#15-known-gaps), and the README makes no claim otherwise.

## Pre-loading

Before judging, the hosted build holds, so judges see results without waiting:

- The three demo repositories ([D6](../plan.md#8-decisions)), ingested at their
  pinned commits with `POST /repos { url, sha }`.
- One finished triage run on each, with `status: done` and `unverified: false`, so the home page and the repository
  page show a funnel and a last run.
- One finished baseline run on the repository used in the compare segment.
- No approved or shipped plan on the runs used live, since a shipped plan cannot be shipped again. Each rehearsal
  starts a new run; rehearsal pull requests are closed and their branches deleted before recording.

## Smoke check

Run against the hosted worker before every recording and before judging. `/healthz` needs no token and answers
booleans only (R11); every other request reads the bearer header from a file with mode `0600`, so the token never
appears in a process argument:

```sh
H=@$HOME/.noderunner/header        # contains: Authorization: Bearer <WORKER_TOKEN>
J='content-type: application/json'
curl -fsS "$WORKER_URL/healthz"                                  # { ok: true, falkordb: true, model: true }
curl -fsS -H "$H" -H "$J" -d '{"url":"<fork url>","sha":"<sha>"}' "$WORKER_URL/repos"
curl -NsS -H "$H" "$WORKER_URL/jobs/<jobId>/events"              # ends with ingest.finished
curl -fsS -H "$H" -H "$J" -d '{"repoId":"<owner/name>","agent":"triage"}' "$WORKER_URL/runs"
curl -NsS -H "$H" "$WORKER_URL/runs/<runId>/events"              # run.finished, status done, unverified false
curl -NsS -H "$H" "$WORKER_URL/runs/<runId>/events?replay=1"     # finishes in about 25 seconds
```

Then open the hosted site logged out and in a private window, load the repository page, and replay a run in the UI.
The check passes only if every step does.

## The demo script it must support

From section 5 of the original plan, about three minutes:

| Segment | Time | Shows | The deployment must provide |
| --- | --- | --- | --- |
| The problem | 20 s | A real open-source repository with a long alert list: "which of these matter?" | A pre-loaded repository whose page renders the funnel and alert table from `summary` |
| Without the graph | 25 s | The same model with the alert list and file search ranks by severity and recommends fixing something the code never imports | The pre-loaded baseline run, replayable, and the compare page |
| With the graph | 60 s | The agent runs; each step lights up a path; a handful of reachable alerts, two upgrades clear them, here is the owner | A live triage run under 90 s, or its replay compressed to 25 s; canvas highlights and citation links |
| The action | 25 s | The pull request appears on GitHub with the paths in its description | Approve and ship working end to end: sandbox, verification, token, and the fork |
| Memory | 30 s | The owner waives one alert with a reason; a new session skips it, cites the waiver, and flags that a newer vulnerability supersedes it | A demo repository where a more severe advisory affects the same install as the waived finding, so the staleness rule fires |
| Close | 20 s | The schema, the three FalkorDB features used, the repository link | The public repository and README; the schema diagram |

## Demo day runbook

**One hour before.** Run the smoke check. Confirm `GET /repos` lists the three repositories at their pinned commits,
that each pre-loaded run replays, that the token can read and push to the forks, and that the fork has no open
rehearsal pull request. Note the run ids to replay in case of failure.

**During.** Drive the demo from the hosted UI. The worker allows 10 runs, ingests, or ships per hour per client,
keyed on the address the proxy forwards, so rehearsals the same hour SHOULD go straight to the worker with the header
file instead, where they count as a separate client.

| Failure | Response |
| --- | --- |
| `healthz` shows `model: false`, or a run fails with `upstream` | Replay the pre-loaded run with `?replay=1`; if it persists, set a cheaper `LLM_MODEL` in the host's secret store and restart the worker |
| A run is capped or ends `unverified` | Show it as it is if the flag is visible; otherwise replay the pre-loaded run |
| Ingestion is slow or GitHub fails | Use a pre-loaded repository; do not ingest live |
| Ship fails with `upstream` or `pr.refused` | Show the refusal and its verification, which is itself a feature; then show the pull request opened in rehearsal |
| The hosted site or network is down | The video is the primary artefact; run `docker compose up` locally against graphs loaded during rehearsal |

## Open points

Decisions are tracked in the [delivery plan](../plan.md#8-decisions).

- **D14** (open): where the sandbox runs on the hosted build; recommended, the unprivileged child process.
- **D15** (open): whether any visitor to the hosted build may approve and ship. The token is limited to the demo
  forks; recommended, a demo passphrase in front of approve and ship, which would add one secret to the env table.
- **D7** (open): whether the rules require a working deployment at all, which sets how much of this is a must.
- **`// VERIFY`:** the FalkorDB image's data path for the Compose volume.
