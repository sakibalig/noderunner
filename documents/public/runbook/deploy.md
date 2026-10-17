# Running Noderunner locally

The demo runs on one machine: FalkorDB in Docker, the worker, and the web app. There is no hosted build (D14, local
hosting). Secrets live only in `.env`, which git ignores; never paste them anywhere else.

## 1. Configure

```sh
cp .env.example .env
```

Fill in:

| Variable | Value |
| --- | --- |
| `OPENAI_API_KEY` | An OpenAI key with access to `gpt-5` (`LLM_MODEL` empty means `gpt-5`) |
| `GITHUB_TOKEN` | A fine-grained token: read access to public repositories, plus Contents and Pull requests write on the demo fork only |
| `PR_TARGET_OWNER` | The owner of the demo fork, `sakibalig`; a pull request never goes anywhere else |
| `WORKER_TOKEN` | Any 32 or more characters, such as `openssl rand -hex 32`; the web app and the worker share it |

The defaults for `FALKORDB_URL`, `PORT` (8787), `WEB_ORIGIN` (http://localhost:3001), and `WORKER_URL` fit this setup.

To open a real pull request, fork the demo repository first: `nestjs/nest` becomes `sakibalig/nest`. The fork must
contain the commit the graph was ingested at; a fresh fork does, and an old one may need syncing on GitHub.

## 2. Start

```sh
pnpm install
docker compose up -d falkordb
set -a; . ./.env; set +a
pnpm --filter @noderunner/worker start          # terminal 1: the worker on :8787
pnpm --filter @noderunner/web dev               # terminal 2: the web app on :3001
curl localhost:8787/healthz                     # {"ok":true,"falkordb":true,"model":true}
```

If port 6379 is taken by a local Redis (`brew services stop redis`), FalkorDB cannot start and every graph call fails.

## 3. Pre-load for the demo

1. Open http://localhost:3001, paste `https://github.com/nestjs/nest`, and ingest (about 15 seconds).
2. On the repository page, press **Run triage agent** and let one run finish (about a minute). Keep its page open in a
   second tab as the fallback.
3. Approve the plan on that run's page. Do not press **Open pull request** until recording, because a plan ships once.
4. Smoke check: `/healthz`, the funnel, a finding's drawer, one live run, a citation lighting up the graph.

## 4. Evaluation

```sh
pnpm eval run --runs 3      # about 10 minutes and a few dollars of model use; rewrites eval/results.*
pnpm eval table             # re-renders results.md from results.json, no model call
```

The runner refuses a FalkorDB that is not local and a graph holding a waiver in force.

## If something fails on the day

| Symptom | Do this |
| --- | --- |
| `healthz` shows `falkordb: false` | `docker compose up -d falkordb`; check nothing else holds port 6379 |
| A run fails with `upstream` from the model | Show the finished run from step 3; check the OpenAI key and quota |
| Ingestion fails with `upstream` | GitHub refused the token: renew `GITHUB_TOKEN` and restart the worker |
| **Open pull request** says the fork does not exist | Fork the repository to `PR_TARGET_OWNER` and give the token write access to it |
| **Open pull request** says to sync the fork | The fork lacks the ingested commit: sync it on GitHub, then retry |
| The web app shows a server error after a code change | Restart `pnpm --filter @noderunner/web dev`; the dev server can hold a stale module |
