import {
  EnvError,
  Fault,
  llmConfig,
  llmKey,
  parseEnv,
  RepoRef,
  RunId,
  type Severity,
  Sha,
  type Tier,
  type ToolCtx,
  type Upgrade,
} from "@noderunner/core";
import { connect } from "@noderunner/graph";
import { memory } from "@noderunner/graph/cypher";
import { GitHistory, GitHub, ingest, OSV } from "@noderunner/ingest";
import { npm } from "@noderunner/planner";
import { createToolbox, createTools } from "@noderunner/tools";
import { OpenAIModel, runAgent } from "@noderunner/worker";
import { ulid } from "ulid";
import { z } from "zod";
import { type Cited, render } from "./report.ts";

const ORIGINS = 12;
const USAGE = "usage: pnpm triage <owner>/<name> [<commit sha>] [--agent]";

const Args = z.tuple([z.string().regex(/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/), Sha.optional()]);

const clock = { now: () => Date.now() };
const ids = { next: () => ulid() };

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

let env: ReturnType<typeof parseEnv<"cli">>;
try {
  env = parseEnv("cli", process.env);
} catch (error) {
  if (error instanceof EnvError)
    fail(`${error.message}\nSet FALKORDB_URL, for example redis://localhost:6379`);
  throw error;
}
const argv = process.argv.slice(2);
// --agent lets the model choose the tools; without it the agent's default order runs with no model.
const mode: "agent" | "fixed" = argv.includes("--agent") ? "agent" : "fixed";
const args = Args.safeParse(argv.filter((arg) => !arg.startsWith("--")));
if (!args.success) fail(USAGE);
const [slug, sha] = args.data;
const [owner = "", name = ""] = slug.split("/");
const repo = RepoRef.parse(sha === undefined ? { owner, name } : { owner, name, sha });

const llm = llmConfig(env);
let key = "";
if (mode === "agent") {
  if (llm.provider !== "openai") fail("--agent needs LLM_PROVIDER=openai; only the OpenAI adapter is built.");
  try {
    key = llmKey(env);
  } catch {
    fail("--agent needs OPENAI_API_KEY.");
  }
}

const signal = AbortSignal.timeout(10 * 60_000);
const db = await connect({
  url: env.FALKORDB_URL,
  signal,
  onError: (error) => process.stderr.write(`FalkorDB: ${error.message}\n`),
});

try {
  const options = env.GITHUB_TOKEN === undefined ? {} : { token: env.GITHUB_TOKEN };
  const github = new GitHub(options);
  const history = new GitHistory(options);
  const forge = {
    head: github.head.bind(github),
    tarball: github.tarball.bind(github),
    history: history.history.bind(history),
  };

  const started = clock.now();
  let shown = "";
  const report = await ingest(
    repo,
    { db, forge, advisories: new OSV(), clock },
    {
      target: { kind: "repo" },
      signal,
      onProgress: (event) => {
        if (event.stage !== shown) process.stderr.write(`  ${event.stage}…\n`);
        shown = event.stage;
      },
    },
  );
  const ingestMs = clock.now() - started;

  const g = db.graph(report.graph);
  const runId = RunId.parse(ids.next());
  const modelId = mode === "agent" ? llm.id : null;
  await g.query(memory.run.start, { id: runId, agent: "triage", model: modelId, now: clock.now() }, signal);
  const ctx: ToolCtx = { graph: report.graph, runId, actor: "triage", signal };
  const registry = npm({ dir: env.CACHE_DIR, clock });
  const defs = createTools({ db, clock, ids, registry });
  const box = createToolbox({ db, clock, ids, tools: defs }, { access: ["read", "derive", "act"] });

  if (mode === "agent") {
    const quiet = { info: () => {}, warn: () => {}, error: () => {} };
    const outcome = await runAgent(
      {
        model: new OpenAIModel(key, llm.model),
        modelId: llm.id,
        toolbox: box,
        tools: defs,
        db,
        clock,
        log: quiet,
      },
      {
        repo,
        graph: report.graph,
        runId,
        agent: "triage",
        kickoff: {},
        hooks: {
          onStart: (step) => process.stderr.write(`  → ${step.tool}\n`),
          onFinish: (step) => process.stderr.write(`    ${step.ok ? "" : "failed: "}${step.summary}\n`),
        },
        emit: () => {},
        signal,
      },
    );
    const flag = outcome.unverified ? ", citations unverified" : "";
    process.stdout.write(
      `${outcome.report}\n\n-- ${outcome.status}${flag}; run ${runId} by ${llm.id}; ` +
        `${outcome.tokens.input} input and ${outcome.tokens.output} output tokens\n`,
    );
    if (outcome.status === "failed") process.exitCode = 1;
  } else {
    const steps: Cited[] = [];
    const call = async <T>(tool: string, input: Record<string, unknown>): Promise<T | null> => {
      const result = await box.callTool(tool, input, ctx, { onStart: () => {}, onFinish: () => {} });
      steps.push({
        tool,
        stepId: result.stepId,
        summary: result.ok ? result.summary : `failed: ${result.error}`,
      });
      return result.ok ? (result.data as T) : null;
    };

    // The triage agent's default order, without a model: every call is a Step in the graph.
    await call("recall_decisions", {});
    const alerts = await call<{
      total: number;
      bySeverity: Record<Severity, number>;
      findings: { key: string; severity: string }[];
    }>("list_alerts", {});
    const tiers = await call<{
      counts: Record<Tier, number>;
      reachable: { key: string; files: string[]; chain: string[]; hops: number }[];
    }>("reachability", {});
    const recalled = await call<{
      inForce: unknown[];
      stale: { key: string; kind: string; staleReason: string | null }[];
    }>("recall_decisions", {});
    const origins = new Map<string, { package: string; range: string }[]>();
    for (const finding of (tiers?.reachable ?? []).slice(0, ORIGINS)) {
      const origin = await call<{ direct: { package: string; range: string }[] }>("introduced_by", {
        key: finding.key,
      });
      const unique = [...new Map((origin?.direct ?? []).map((d) => [d.package, d])).values()];
      origins.set(finding.key, unique);
    }
    const reachableCount = tiers?.counts["import-reachable"] ?? 0;
    const plan =
      reachableCount === 0
        ? null
        : await call<{ planId: string; upgrades: Upgrade[]; uncovered: string[]; totalCost: number }>(
            "plan_upgrades",
            {
              tiers: ["import-reachable"],
            },
          );
    const reviewers = new Map<string, { handle: string; why: string }[]>();
    if (plan !== null) {
      const owners = await call<{
        perUpgrade: { upgrade: string; reviewers: { handle: string; why: string }[] }[];
      }>("owners_for", { planId: plan.planId });
      for (const u of owners?.perUpgrade ?? []) reviewers.set(u.upgrade, u.reviewers);
    }

    process.stdout.write(
      render({
        repo: `${repo.owner}/${repo.name}`,
        runId,
        ingest: report,
        ingestMs,
        alerts: alerts ?? { total: 0, bySeverity: { critical: 0, high: 0, moderate: 0, low: 0, unknown: 0 } },
        severities: new Map((alerts?.findings ?? []).map((f) => [f.key, f.severity])),
        tiers: tiers?.counts ?? { "import-reachable": 0, installed: 0, "dev-only": 0 },
        reachable: tiers?.reachable ?? [],
        origins,
        stale: recalled?.stale ?? [],
        inForce: recalled?.inForce.length ?? 0,
        plan,
        reviewers,
        steps,
      }),
    );
  }
} catch (error) {
  fail(
    error instanceof Fault
      ? error.message
      : `triage failed: ${error instanceof Error ? error.name : "unknown"}`,
  );
} finally {
  await db.close();
}
