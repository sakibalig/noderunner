import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  EnvError,
  graphName,
  llmConfig,
  llmKey,
  parseEnv,
  type RepoRef,
  RunId,
  Sha,
  type Tier,
} from "@noderunner/core";
import { GitData, members } from "@noderunner/executor";
import { connect } from "@noderunner/graph";
import { api, tools as cypher } from "@noderunner/graph/cypher";
import { GitHub, snapshot } from "@noderunner/ingest";
import { npm } from "@noderunner/planner";
import { createToolbox, createTools, recallDecisions } from "@noderunner/tools";
import { OpenAIModel, systemClock, ulidIds } from "@noderunner/worker";
import { pino } from "pino";
import { check, LabelError, type LabelFile, load, Repos, reachable } from "./labels.ts";
import { Results, type RunScore } from "./results.ts";
import { once } from "./run.ts";
import { table } from "./table.ts";

const root = join(import.meta.dirname, "..");
const never = new AbortController().signal;
const [command = "run", ...rest] = process.argv.slice(2);
const flag = rest.indexOf("--runs");
const RUNS = flag === -1 ? 3 : Number(rest[flag + 1]);

if (command === "table") {
  const results = Results.parse(JSON.parse(readFileSync(join(root, "results.json"), "utf8")));
  writeFileSync(join(root, "results.md"), table(results));
  process.exit(0);
}

let env: ReturnType<typeof parseEnv<"eval">>;
try {
  env = parseEnv("eval", process.env);
} catch (error) {
  if (!(error instanceof EnvError)) throw error;
  console.error(error.message);
  process.exit(1);
}
if (command !== "run" && command !== "label") {
  console.error("usage: pnpm eval [label | run --runs N | table]");
  process.exit(1);
}
if (!Number.isInteger(RUNS) || RUNS < 1) {
  console.error("--runs needs a positive whole number");
  process.exit(1);
}

const local = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
if (!local.has(new URL(env.FALKORDB_URL).hostname)) {
  console.error("pnpm eval runs against a local FalkorDB only; it writes runs and plans into the graph");
  process.exit(1);
}

const log = pino({ level: env.LOG_LEVEL });
const db = await connect({
  url: env.FALKORDB_URL,
  signal: AbortSignal.timeout(10_000),
  onError: (error) => log.error({ code: error.code }, "graph.connection.failed"),
});
const llm = llmConfig(env);

try {
  const repos = Repos.parse(
    JSON.parse((await import("node:fs")).readFileSync(join(root, "repos.json"), "utf8")),
  );
  for (const pinned of repos) {
    const [owner = "", name = ""] = pinned.repo.split("/");
    const repo = { owner, name, sha: Sha.parse(pinned.sha) };
    const graph = graphName(repo);
    const labelPath = join(root, "labels", owner, `${name}.json`);
    const g = db.graph(graph);

    const [head] = (await db.list()).includes(graph) ? await g.query(api.repos.repo, {}, never) : [];
    if (head?.sha !== pinned.sha)
      throw new LabelError(`${graph} is not ingested at ${pinned.sha}; run pnpm triage ${pinned.repo} first`);
    const keys = (await g.query(cypher.ship.keys, {}, never)).map((r) => r.key);

    if (command === "label") {
      if (existsSync(labelPath)) throw new LabelError(`${labelPath} exists; labels are frozen once written`);
      const reached = await g.query(cypher.tier.reachable, { keys: [] }, never);
      const others = await g.query(
        cypher.tier.rest,
        { keys: [], reachable: reached.map((r) => r.key) },
        never,
      );
      const labels: Record<string, Tier> = {};
      for (const r of reached) labels[r.key] = "import-reachable";
      for (const r of others) labels[r.key] = r.devOnly ? "dev-only" : "installed";
      const file: LabelFile = {
        repo: pinned.repo,
        sha: pinned.sha,
        labels: Object.fromEntries(Object.entries(labels).sort(([a], [b]) => (a < b ? -1 : 1))),
        corrections: [],
        checked: [],
        notes: [],
      };
      mkdirSync(dirname(labelPath), { recursive: true });
      writeFileSync(labelPath, `${JSON.stringify(file, null, 2)}\n`);
      log.info({ repo: pinned.repo, labels: keys.length }, "eval.labels.written");
      continue;
    }

    const labels = load(labelPath);
    check(labelPath, labels, pinned.sha, keys);
    const recalled = await recallDecisions({ db, clock: systemClock }).run(
      { graph, runId: RunId.parse(ulidIds.next()), actor: "triage", signal: never },
      {},
    );
    if (recalled.data.inForce.some((d) => d.kind === "waive"))
      throw new LabelError(
        `${graph} holds a waiver in force, which changes the plan; remove it before scoring`,
      );

    if (llm.provider !== "openai") throw new LabelError(`no model adapter for ${llm.provider}`);
    const model = new OpenAIModel(llmKey(env), llm.model);
    const github = new GitHub(env.GITHUB_TOKEN === undefined ? {} : { token: env.GITHUB_TOKEN });
    log.info({ repo: pinned.repo }, "eval.files.started");
    const files = await sources(g, repo, github);
    log.info({ repo: pinned.repo, files: files.size }, "eval.files.finished");
    const tools = createTools({
      db,
      clock: systemClock,
      ids: ulidIds,
      registry: npm({ dir: env.CACHE_DIR, clock: systemClock }),
      files: async () => files,
    });
    // No `act` access: the evaluation records no decision and opens no pull request.
    const toolbox = createToolbox(
      { db, clock: systemClock, ids: ulidIds, tools },
      { access: ["read", "derive"] },
    );
    const deps = { model, modelId: llm.id, toolbox, tools, db, clock: systemClock, ids: ulidIds, log };
    const labelled = reachable(labels);
    const runs: RunScore[] = [];
    for (let i = 0; i < RUNS; i += 1) {
      const order = i % 2 === 0 ? (["triage", "baseline"] as const) : (["baseline", "triage"] as const);
      for (const agent of order) {
        log.info({ repo: pinned.repo, agent, round: i + 1 }, "eval.run.started");
        const scored = await once(deps, { agent, repo, graph, labelled, signal: never });
        log.info(
          {
            agent,
            runId: scored.runId,
            status: scored.status,
            precision: scored.precision,
            recall: scored.recall,
          },
          "eval.run.finished",
        );
        runs.push(scored);
      }
    }
    const results = Results.parse({
      repo: pinned.repo,
      sha: pinned.sha,
      model: llm.id,
      date: new Date(systemClock.now()).toISOString().slice(0, 10),
      labels: {
        total: keys.length,
        reachable: labelled.size,
        checked: labels.checked.length,
        corrections: labels.corrections.map(({ key, tool, label }) => ({ key, tool, label })),
        notes: labels.notes,
      },
      runs,
    });
    writeFileSync(join(root, "results.json"), `${JSON.stringify(results, null, 2)}\n`);
    writeFileSync(join(root, "results.md"), table(results));
    log.info({ repo: pinned.repo, runs: runs.length }, "eval.results.written");
  }
} catch (error) {
  if (!(error instanceof LabelError)) throw error;
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await db.close();
}

/**
 * What the baseline may read: the source files ingestion stage 1 kept at the pinned commit, plus the root
 * package.json, package-lock.json, and each workspace's package.json, so it can trace chains through the lockfile.
 */
async function sources(
  g: ReturnType<typeof db.graph>,
  repo: RepoRef & { readonly sha: Sha },
  github: GitHub,
): Promise<ReadonlyMap<string, string>> {
  const snap = await snapshot(
    { g, repo, target: { kind: "repo" } },
    { forge: { head: github.head.bind(github), tarball: github.tarball.bind(github) } },
    { onProgress: () => {}, signal: AbortSignal.timeout(120_000) },
  );
  if (env.GITHUB_TOKEN === undefined)
    throw new LabelError("GITHUB_TOKEN is needed to read the package files the baseline searches");
  const reader = new GitData({ token: env.GITHUB_TOKEN });
  const read = async (path: string) => {
    const text = await reader.read(repo, repo.sha, path, AbortSignal.timeout(60_000));
    if (text === null) throw new LabelError(`${repo.owner}/${repo.name} has no ${path} at ${repo.sha}`);
    return text;
  };
  const lock = await read("package-lock.json");
  const manifests = ["package.json", ...members(lock).map((path) => `${path}/package.json`)];
  const out = new Map(snap.files);
  out.set("package-lock.json", lock);
  for (const path of manifests) out.set(path, await read(path));
  return out;
}
