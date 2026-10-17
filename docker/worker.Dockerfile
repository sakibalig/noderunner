# The worker: Run API, ingestion, and the agent. Runs TypeScript directly with tsx, as in development.
FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/* \
  && npm install -g pnpm@10.34.7
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/worker/package.json apps/worker/
COPY apps/cli/package.json apps/cli/
COPY apps/web/package.json apps/web/
COPY eval/package.json eval/
COPY packages/core/package.json packages/core/
COPY packages/graph/package.json packages/graph/
COPY packages/ingest/package.json packages/ingest/
COPY packages/tools/package.json packages/tools/
COPY packages/planner/package.json packages/planner/
COPY packages/executor/package.json packages/executor/
COPY packages/mcp/package.json packages/mcp/
RUN pnpm install --frozen-lockfile --filter @noderunner/worker...
COPY packages packages
COPY apps/worker apps/worker
ENV NODE_ENV=production PORT=8787 CACHE_DIR=/tmp/noderunner
EXPOSE 8787
USER node
CMD ["pnpm", "--silent", "--filter", "@noderunner/worker", "start"]
