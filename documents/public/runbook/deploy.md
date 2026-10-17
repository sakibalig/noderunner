# Deploying the hosted demo

The checklist for T25. Three pieces: FalkorDB Cloud for the graph, the worker on Fly.io, and the web app on Vercel.
Everything that needs no account is already in the repository: `docker/worker.Dockerfile`, `fly.toml`, and the web
app's Vercel settings below. Secrets go only into each host's secret store, never into a file in the repository.

## 1. FalkorDB Cloud

1. Create a free instance at <https://app.falkordb.cloud>.
2. Copy its connection URL as `rediss://default:<password>@<host>:<port>`. This is `FALKORDB_URL`.
3. Check it from a laptop: `FALKORDB_URL=… pnpm triage nestjs/nest` ingests and prints the triage.

## 2. Worker on Fly.io

```sh
brew install flyctl && fly auth login
fly launch --no-deploy --copy-config          # keeps fly.toml; pick a unique app name if taken
fly secrets set \
  FALKORDB_URL='rediss://…' \
  OPENAI_API_KEY='sk-…' \
  GITHUB_TOKEN='github_pat_…' \
  PR_TARGET_OWNER='sakibalig' \
  WORKER_TOKEN="$(openssl rand -hex 32)" \
  WEB_ORIGIN='https://<vercel-domain>'
fly deploy
curl https://<app>.fly.dev/healthz              # {"ok":true,"falkordb":true,"model":true}
```

Keep the `WORKER_TOKEN` value: the web app needs the same one. `GITHUB_TOKEN` is a fine-grained token with read
access to public repositories (and, for T21, contents and pull-request write on the demo forks only). Without a valid
token GitHub answers 401 and ingestion ends with `upstream`.

## 3. Web on Vercel

1. Import the GitHub repository. Set **Root Directory** to `apps/web`; Vercel detects Next.js and pnpm.
2. Environment variables: `WORKER_URL=https://<app>.fly.dev` and `WORKER_TOKEN=<the same value>`.
3. Deploy, then set the worker's `WEB_ORIGIN` to the Vercel domain (`fly secrets set WEB_ORIGIN=…`).

Vercel builds every push to `main`, so merge at checkpoints.

## 4. Pre-load and smoke check

1. On the hosted site, ingest `nestjs/nest` (the stand-in demo repository until D6 is decided).
2. Start one triage run and let it finish; its run page is the replay fallback (`?replay=1`, no model call).
3. Smoke check before recording and before judging: `/healthz`, the repository page's funnel, one live run, one
   replay, and the graph highlight on a citation, in a private window.

## If something fails on the day

| Symptom | Do this |
| --- | --- |
| `healthz` shows `falkordb: false` | Check the FalkorDB Cloud instance is running; `fly secrets set FALKORDB_URL=…` |
| A run fails with `upstream` from the model | Open the pre-loaded run with `?replay=1`; set a cheaper `LLM_MODEL` if rate-limited |
| Ingestion fails with `upstream` | GitHub refused the token; renew `GITHUB_TOKEN` |
| The web app shows 502 | The worker is down: `fly status`, `fly logs`, `fly machine restart` |
