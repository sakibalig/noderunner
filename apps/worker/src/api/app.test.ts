import {
  Fault,
  findingKey,
  graphName,
  type IngestReport,
  PlanDraft,
  type RepoRef,
  type RunEvent,
  type Stage,
  StepId,
} from "@noderunner/core";
import { describe, expect, it } from "vitest";
import type { Catalog, Ingester } from "../jobs/catalog.ts";
import { Limiter } from "../jobs/limit.ts";
import type { Plans } from "../jobs/plans.ts";
import { type DEFAULTS, Jobs } from "../jobs/queue.ts";
import { type Archive, type Runner, Runs } from "../jobs/runs.ts";
import type { Log } from "../log.ts";
import { createApp } from "./app.ts";

const TOKEN = "t".repeat(32);
const STEP = StepId.parse("01JQZ8STEP00000000000000AA");
const auth = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };
const stages: readonly Stage[] = ["fetch", "lockfile", "imports", "advisories", "people", "prune"];
const counts = { files: 6, installs: 12, vulns: 3, findings: 3, people: 1 };

class Unsupported extends Fault {
  readonly code = "ingest.lockfile";
  readonly surface = "unsupported";
}

function report(repo: RepoRef): IngestReport {
  return {
    graph: graphName(repo),
    sha: "a".repeat(40) as IngestReport["sha"],
    counts,
    warnings: [],
    ms: Object.fromEntries(stages.map((stage) => [stage, 1])) as IngestReport["ms"],
  };
}

const noPlans: Plans = { forRun: async () => null, approve: async () => false };

type Setup = {
  plans?: Plans;
  run?: Runner;
  ingest?: Ingester;
  falkordb?: boolean;
  jobs?: Partial<typeof DEFAULTS>;
};

function setup(options: Setup = {}) {
  const ingested: string[] = [];
  const logged: { event: string; fields: Readonly<Record<string, unknown>> }[] = [];
  const log: Log = {
    info: (fields, event) => logged.push({ event, fields }),
    warn: (fields, event) => logged.push({ event, fields }),
    error: (fields, event) => logged.push({ event, fields }),
  };
  const ingest: Ingester =
    options.ingest ??
    (async (repo, { onProgress }) => {
      for (const [index, stage] of stages.entries())
        onProgress({ type: "ingest.progress", stage, done: index + 1, total: stages.length });
      ingested.push(`${repo.owner}/${repo.name}`);
      return report(repo);
    });
  const catalog: Catalog = {
    list: async () =>
      ingested.map((repoId) => ({
        repoId,
        sha: "a".repeat(40) as IngestReport["sha"],
        ingestedAt: 1,
        counts,
      })),
    summary: async (repo) =>
      ingested.includes(`${repo.owner}/${repo.name}`)
        ? { funnel: { total: 3, production: 2, reachable: 1, open: 1 }, counts, lastRun: null }
        : null,
    findings: async (repo, filter) => {
      if (!ingested.includes(`${repo.owner}/${repo.name}`)) return null;
      const all = [
        { tier: "import-reachable" as const, status: "open" as const },
        { tier: "dev-only" as const, status: "waived" as const },
      ].map(({ tier, status }, i) => ({
        key: findingKey(`GHSA-${i}`, "qs"),
        vulnId: `GHSA-${i}`,
        package: "qs",
        installs: [],
        severity: "high" as const,
        tier,
        status,
      }));
      return all.filter(
        (f) => (filter.tier ?? f.tier) === f.tier && (filter.status ?? f.status) === f.status,
      );
    },
  };
  let next = 0;
  const clock = { now: () => 0 };
  const ids = { next: () => `01JQZ8${String(next++).padStart(20, "0")}` };
  const stored = new Map<string, readonly RunEvent[]>();
  const archive: Archive = {
    begin: async () => {},
    save: async (_graph, runId, events) => {
      stored.set(runId, events);
    },
    find: async (runId) => stored.get(runId) ?? null,
  };
  const run: Runner =
    options.run ??
    (async ({ runId, emit }) => {
      emit({ type: "run.started", runId, agent: "triage", model: "openai/gpt-5" });
      emit({ type: "step.started", stepId: STEP, seq: 1, tool: "list_alerts", input: {} });
      emit({ type: "message.delta", text: "partial" });
      emit({
        type: "step.finished",
        stepId: STEP,
        ok: true,
        summary: "3 alerts",
        evidence: { nodes: [], edges: [], cypher: ["MATCH"] },
        ms: 40,
      });
      emit({
        type: "run.finished",
        runId,
        status: "done",
        unverified: false,
        report: `3 alerts [s:${STEP}]`,
      });
    });
  const runs = new Runs({ run, archive, model: "openai/gpt-5", clock, ids, log });
  const app = createApp({
    jobs: new Jobs({ ingest, clock, ids, log }, options.jobs),
    runs,
    archive,
    plans: options.plans ?? noPlans,
    catalog,
    limiter: new Limiter({ limit: 3, windowMs: 3_600_000, clients: 100 }, clock),
    probe: { falkordb: async () => options.falkordb ?? true, model: true },
    log,
    config: { token: TOKEN, origin: "http://localhost:3001" },
  });
  return { app, logged };
}

const post = (body: unknown, headers: Record<string, string> = {}) => ({
  method: "POST",
  headers: { ...auth, ...headers },
  body: JSON.stringify(body),
});

function events(text: string): { id: number; type: string; data: string }[] {
  return text
    .split("\n\n")
    .filter((block) => block.includes("data:"))
    .map((block) => ({
      id: Number(/^id: (\d+)/m.exec(block)?.[1]),
      type: /^event: (.+)$/m.exec(block)?.[1] ?? "",
      data: /^data: (.+)$/m.exec(block)?.[1] ?? "",
    }));
}

async function start(app: ReturnType<typeof setup>["app"], url = "https://github.com/acme/api") {
  const res = await app.request("/repos", post({ url }));
  return { status: res.status, ...((await res.json()) as { repoId: string; jobId: string }) };
}

const stream = async (app: ReturnType<typeof setup>["app"], jobId: string, last?: string) =>
  events(
    await (
      await app.request(`/jobs/${jobId}/events`, {
        headers: last === undefined ? auth : { ...auth, "Last-Event-ID": last },
      })
    ).text(),
  );

describe("GET /healthz", () => {
  it("answers 200 with booleans and no token", async () => {
    const res = await setup().app.request("/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, falkordb: true, model: true });
  });

  it("still answers 200 when FalkorDB is unreachable, with ok false", async () => {
    const res = await setup({ falkordb: false }).app.request("/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, falkordb: false, model: true });
  });
});

describe("authentication", () => {
  it.each([
    ["missing", undefined],
    ["wrong", "Bearer wrong"],
    ["not bearer", "Basic x"],
    ["malformed", "Bearer bad token!"],
  ])("answers unauthorized for a %s token and logs the rejection", async (_, header) => {
    const { app, logged } = setup();
    const res = await app.request("/repos", {
      headers: header === undefined ? {} : { Authorization: header },
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: { code: "unauthorized", message: "Missing or wrong worker token" },
    });
    expect(logged.some((entry) => entry.event === "api.request.rejected")).toBe(true);
    expect(logged.some((entry) => entry.event === "api.request.failed")).toBe(false);
  });
});

describe("POST /repos", () => {
  it("rejects a URL that is not a GitHub repository", async () => {
    const res = await setup().app.request("/repos", post({ url: "https://gitlab.com/acme/api" }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("invalid");
  });

  it("rejects a body that is not JSON", async () => {
    expect((await setup().app.request("/repos", { method: "POST", headers: auth, body: "{" })).status).toBe(
      400,
    );
  });

  it("rejects a body over the size limit", async () => {
    const res = await setup().app.request(
      "/repos",
      post({ url: "https://github.com/acme/api", pad: "x".repeat(70_000) }),
    );
    expect(res.status).toBe(400);
  });

  it("normalises case and a .git suffix into one repository id", async () => {
    const { app } = setup();
    expect((await start(app, "https://github.com/ACME/Api.git")).repoId).toBe("acme/api");
  });

  it("starts an ingestion and streams its progress to ingest.finished", async () => {
    const { app } = setup();
    const { status, jobId } = await start(app);
    expect(status).toBe(202);
    const seen = await stream(app, jobId);
    expect(seen.map((event) => event.type)).toEqual([
      ...stages.map(() => "ingest.progress"),
      "ingest.finished",
    ]);
    expect(seen.map((event) => event.id)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("answers busy while the same repository is ingesting, in any spelling, and frees it afterwards", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { app } = setup({
      ingest: async (repo) => {
        await gate;
        return report(repo);
      },
    });
    const { jobId } = await start(app);
    expect((await app.request("/repos", post({ url: "https://github.com/ACME/api.git" }))).status).toBe(409);
    release();
    await stream(app, jobId);
    expect((await start(app)).status).toBe(202);
  });

  it("answers busy when the waiting queue is full", async () => {
    const { app } = setup({
      ingest: () => new Promise(() => {}),
      jobs: { concurrency: 1, maxPending: 1 },
    });
    expect((await start(app, "https://github.com/acme/a")).status).toBe(202);
    expect((await start(app, "https://github.com/acme/b")).status).toBe(202);
    expect((await app.request("/repos", post({ url: "https://github.com/acme/c" }))).status).toBe(409);
  });

  it("limits each client by X-Forwarded-For", async () => {
    const { app } = setup();
    const from = (ip: string, name: string) =>
      app.request("/repos", post({ url: `https://github.com/acme/${name}` }, { "X-Forwarded-For": ip }));
    const statuses: number[] = [];
    for (const name of ["a", "b", "c", "d"]) statuses.push((await from("1.1.1.1", name)).status);
    expect(statuses).toEqual([202, 202, 202, 429]);
    expect((await from("2.2.2.2", "e")).status).toBe(202);
  });

  it("does not count a request without a token toward the limit", async () => {
    const { app } = setup();
    for (let i = 0; i < 5; i++)
      await app.request("/repos", {
        method: "POST",
        headers: { "X-Forwarded-For": "1.1.1.1" },
        body: "{}",
      });
    const ok = await app.request(
      "/repos",
      post({ url: "https://github.com/acme/a" }, { "X-Forwarded-For": "1.1.1.1" }),
    );
    expect(ok.status).toBe(202);
  });
});

describe("job failures", () => {
  it("keeps another package's Fault code and safe message", async () => {
    const { app } = setup({
      ingest: async () => {
        throw new Unsupported("Only npm lockfiles are supported");
      },
    });
    const { jobId } = await start(app);
    const [failed] = await stream(app, jobId);
    expect(failed?.type).toBe("job.failed");
    expect(JSON.parse(failed?.data ?? "{}")).toMatchObject({
      code: "unsupported",
      message: "Only npm lockfiles are supported",
    });
  });

  it("hides an unknown error behind internal", async () => {
    const { app, logged } = setup({
      ingest: async () => {
        throw new Error("boom at /etc/secret");
      },
    });
    const { jobId } = await start(app);
    const [failed] = await stream(app, jobId);
    expect(JSON.parse(failed?.data ?? "{}")).toMatchObject({ code: "internal", message: "Ingestion failed" });
    expect(failed?.data).not.toContain("/etc/secret");
    expect(logged.find((entry) => entry.event === "job.ingest.failed")?.fields.err).toBeInstanceOf(Error);
  });

  it("fails a job that passes its deadline as upstream", async () => {
    const { app } = setup({
      ingest: (_, { signal }) =>
        new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason))),
      jobs: { deadlineMs: 20 },
    });
    const { jobId } = await start(app);
    expect(JSON.parse((await stream(app, jobId))[0]?.data ?? "{}")).toMatchObject({ code: "upstream" });
  });
});

describe("GET /jobs/:id/events", () => {
  it("resumes after Last-Event-ID", async () => {
    const { app } = setup();
    const { jobId } = await start(app);
    await stream(app, jobId);
    expect((await stream(app, jobId, "5")).map((event) => event.id)).toEqual([6, 7]);
  });

  it("closes at once when resuming after the last event", async () => {
    const { app } = setup();
    const { jobId } = await start(app);
    await stream(app, jobId);
    expect(await stream(app, jobId, "7")).toEqual([]);
  });

  it("sends what is left and closes when the resume point was evicted", async () => {
    const { app } = setup({
      ingest: async (repo, { onProgress }) => {
        for (let i = 0; i < 600; i++)
          onProgress({ type: "ingest.progress", stage: "imports", done: i, total: 600 });
        return report(repo);
      },
    });
    const { jobId } = await start(app);
    await stream(app, jobId);
    const resumed = await stream(app, jobId, "10");
    expect(resumed[0]?.id).toBe(102);
    expect(resumed.at(-1)?.type).toBe("ingest.finished");
  });

  it("answers invalid for a malformed job id or Last-Event-ID", async () => {
    const { app } = setup();
    expect((await app.request("/jobs/not-an-id/events", { headers: auth })).status).toBe(400);
    const { jobId } = await start(app);
    expect(
      (await app.request(`/jobs/${jobId}/events`, { headers: { ...auth, "Last-Event-ID": "-1" } })).status,
    ).toBe(400);
  });

  it("answers missing for an unknown job", async () => {
    expect(
      (await setup().app.request("/jobs/01JQZ8XXXXXXXXXXXXXXXXXXXX/events", { headers: auth })).status,
    ).toBe(404);
  });
});

describe("GET /repos and summary", () => {
  it("lists an ingested repository and serves its summary in any case", async () => {
    const { app } = setup();
    const { jobId } = await start(app);
    await stream(app, jobId);
    const list = (await (await app.request("/repos", { headers: auth })).json()) as {
      repos: { repoId: string }[];
    };
    expect(list.repos.map((repo) => repo.repoId)).toEqual(["acme/api"]);
    const summary = await app.request("/repos/ACME/api/summary", { headers: auth });
    expect(((await summary.json()) as { funnel: { reachable: number } }).funnel.reachable).toBe(1);
  });

  it("answers missing for a repository never ingested, and invalid for a malformed name", async () => {
    const { app } = setup();
    expect((await app.request("/repos/acme/none/summary", { headers: auth })).status).toBe(404);
    expect((await app.request("/repos/acme/a%7Db/summary", { headers: auth })).status).toBe(400);
  });
});

describe("unknown routes", () => {
  it("answer missing", async () => {
    expect((await setup().app.request("/nope", { headers: auth })).status).toBe(404);
  });
});

describe("GET /repos/:owner/:name/findings", () => {
  async function ingested() {
    const { app } = setup();
    const { jobId } = await start(app);
    await stream(app, jobId);
    return app;
  }
  const keys = async (res: Response) =>
    ((await res.json()) as { findings: { vulnId: string }[] }).findings.map((f) => f.vulnId);

  it("lists findings and filters by tier and status", async () => {
    const app = await ingested();
    expect(await keys(await app.request("/repos/acme/api/findings", { headers: auth }))).toEqual([
      "GHSA-0",
      "GHSA-1",
    ]);
    expect(
      await keys(await app.request("/repos/acme/api/findings?tier=dev-only", { headers: auth })),
    ).toEqual(["GHSA-1"]);
    expect(await keys(await app.request("/repos/acme/api/findings?status=open", { headers: auth }))).toEqual([
      "GHSA-0",
    ]);
  });

  it("answers invalid for an unknown tier and missing for an unknown repository", async () => {
    const app = await ingested();
    expect((await app.request("/repos/acme/api/findings?tier=bogus", { headers: auth })).status).toBe(400);
    expect((await app.request("/repos/acme/none/findings", { headers: auth })).status).toBe(404);
  });
});

describe("runs", () => {
  async function ready(options: Setup = {}) {
    const { app } = setup(options);
    const { jobId } = await start(app);
    await stream(app, jobId);
    return app;
  }
  const begin = async (
    app: Awaited<ReturnType<typeof ready>>,
    body: unknown = { repoId: "acme/api", agent: "triage" },
  ) => app.request("/runs", post(body));
  const runEvents = async (
    app: Awaited<ReturnType<typeof ready>>,
    runId: string,
    query = "",
    last?: string,
  ) =>
    events(
      await (
        await app.request(`/runs/${runId}/events${query}`, {
          headers: last === undefined ? auth : { ...auth, "Last-Event-ID": last },
        })
      ).text(),
    );

  it("starts a triage run and streams its stored events to a subscriber who joins after it finished", async () => {
    const app = await ready();
    const res = await begin(app);
    expect(res.status).toBe(202);
    const { runId } = (await res.json()) as { runId: string };
    expect((await runEvents(app, runId)).map((e) => e.type)).toEqual([
      "run.started",
      "step.started",
      "step.finished",
      "run.finished",
    ]);
  });

  it("streams text deltas to a subscriber connected while the model writes", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const app = await ready({
      run: async ({ runId, emit }) => {
        emit({ type: "run.started", runId, agent: "triage", model: "openai/gpt-5" });
        await gate;
        emit({ type: "message.delta", text: "hello" });
        emit({ type: "run.finished", runId, status: "done", unverified: false, report: "hello" });
      },
    });
    const { runId } = (await (await begin(app)).json()) as { runId: string };
    const streaming = runEvents(app, runId);
    await new Promise((resolve) => setTimeout(resolve, 20));
    release();
    expect((await streaming).map((e) => e.type)).toEqual(["run.started", "message.delta", "run.finished"]);
  });

  it("keeps every step for a late subscriber however much text the model streamed", async () => {
    const app = await ready({
      run: async ({ runId, emit }) => {
        emit({ type: "run.started", runId, agent: "triage", model: "openai/gpt-5" });
        emit({ type: "step.started", stepId: STEP, seq: 1, tool: "list_alerts", input: {} });
        emit({
          type: "step.finished",
          stepId: STEP,
          ok: true,
          summary: "",
          evidence: { nodes: [], edges: [], cypher: [] },
          ms: 1,
        });
        for (let i = 0; i < 2_000; i++) emit({ type: "message.delta", text: "x" });
        emit({ type: "run.finished", runId, status: "done", unverified: false, report: "done" });
      },
    });
    const { runId } = (await (await begin(app)).json()) as { runId: string };
    await runEvents(app, runId);
    expect((await runEvents(app, runId)).map((e) => e.type)).toEqual([
      "run.started",
      "step.started",
      "step.finished",
      "run.finished",
    ]);
  });

  it("resumes a live stream after Last-Event-ID", async () => {
    const app = await ready();
    const { runId } = (await (await begin(app)).json()) as { runId: string };
    await runEvents(app, runId);
    expect((await runEvents(app, runId, "", "2")).map((e) => e.id)).toEqual([3, 4]);
  });

  it("replays a finished run from the archive without text deltas, and serves its view", async () => {
    const app = await ready();
    const { runId } = (await (await begin(app)).json()) as { runId: string };
    await runEvents(app, runId);
    expect((await runEvents(app, runId, "?replay=1")).map((e) => e.type)).toEqual([
      "run.started",
      "step.started",
      "step.finished",
      "run.finished",
    ]);
    const view = (await (await app.request(`/runs/${runId}`, { headers: auth })).json()) as {
      run: { status: string; model: string };
      steps: { tool: string; summary: string; cypher: string[] }[];
      report: string;
    };
    expect(view.run).toMatchObject({ status: "done", model: "openai/gpt-5" });
    expect(view.steps).toEqual([
      expect.objectContaining({ tool: "list_alerts", summary: "3 alerts", cypher: ["MATCH"] }),
    ]);
    expect(view.report).toBe(`3 alerts [s:${STEP}]`);
  });

  it("finishes a run whose runner throws with a failed run.finished and a safe message", async () => {
    const app = await ready({
      run: async () => {
        throw new Error("model exploded at /secret");
      },
    });
    const { runId } = (await (await begin(app)).json()) as { runId: string };
    const seen = await runEvents(app, runId);
    expect(seen.map((e) => e.type)).toEqual(["run.finished"]);
    expect(JSON.parse(seen[0]?.data ?? "{}")).toMatchObject({ status: "failed", report: "The run failed" });
    expect(seen[0]?.data).not.toContain("/secret");
  });

  it.each([
    [{ repoId: "acme/none", agent: "triage" }, 404],
    [{ repoId: "acme/api", agent: "fixer" }, 422],
    [{ repoId: "nope", agent: "triage" }, 400],
  ])("refuses %j with %i", async (body, status) => {
    expect((await begin(await ready(), body)).status).toBe(status);
  });

  it("answers missing for an unknown run and invalid for a malformed id", async () => {
    const app = await ready();
    expect((await app.request("/runs/01JQZ8XXXXXXXXXXXXXXXXXXXX", { headers: auth })).status).toBe(404);
    expect((await app.request("/runs/01JQZ8XXXXXXXXXXXXXXXXXXXX/events", { headers: auth })).status).toBe(
      404,
    );
    expect((await app.request("/runs/bad/events", { headers: auth })).status).toBe(400);
  });
});

describe("plans", () => {
  const draft = {
    planId: "01JQZ8PAN00000000000000000",
    runId: "01JQZ8RN000000000000000000",
    repoId: "acme/api",
    approved: false,
    totalCost: 1,
    uncovered: [],
    upgrades: [],
    title: "Noderunner: close 0 reachable vulnerabilities in acme/api",
    body: "## body",
  };
  const approved: string[] = [];
  const plans: Plans = {
    forRun: async (runId) => (runId === draft.runId ? PlanDraft.parse(draft) : null),
    approve: async (planId, by) => {
      if (planId !== draft.planId) return false;
      approved.push(by);
      return true;
    },
  };

  it("serves a run's plan as a pull request draft, and missing for a run without one", async () => {
    const { app } = setup({ plans });
    const res = await app.request(`/runs/${draft.runId}/plan`, { headers: auth });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { title: string }).title).toBe(draft.title);
    expect((await app.request("/runs/01JQZ8XXXXXXXXXXXXXXXXXXXX/plan", { headers: auth })).status).toBe(404);
  });

  it("approves a plan by handle, and refuses an unknown plan or a bad handle", async () => {
    const { app } = setup({ plans });
    const res = await app.request(`/plans/${draft.planId}/approve`, post({ by: "sakibalig" }));
    expect([res.status, await res.json()]).toEqual([200, { approved: true }]);
    expect(approved).toEqual(["sakibalig"]);
    expect((await app.request("/plans/01JQZ8XXXXXXXXXXXXXXXXXXXX/approve", post({ by: "x" }))).status).toBe(
      404,
    );
    expect((await app.request(`/plans/${draft.planId}/approve`, post({ by: "not a handle" }))).status).toBe(
      400,
    );
  });
});
