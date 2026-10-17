import {
  type Clock,
  type GraphName,
  graphName,
  type Ids,
  limits,
  type RepoRef,
  type RunEvent,
  RunId,
} from "@noderunner/core";
import PQueue from "p-queue";
import { surfaceOf, WorkerError } from "../errors.ts";
import type { Log } from "../log.ts";
import { type Framed, Ring } from "./ring.ts";

/** Runs one agent to completion, pushing every event through `emit`; the agent writes its own Run outcome. */
export type Runner = (args: {
  readonly repo: RepoRef;
  readonly graph: GraphName;
  readonly runId: RunId;
  readonly emit: (event: RunEvent) => void;
  readonly signal: AbortSignal;
}) => Promise<void>;

/** Where runs are created and their finished events kept; the graph behind it in production. */
export interface Archive {
  begin(graph: GraphName, runId: RunId, model: string): Promise<void>;
  save(graph: GraphName, runId: RunId, events: readonly RunEvent[]): Promise<void>;
  /** A finished run's stored events, or null when no graph holds a finished run with this id. */
  find(runId: RunId, signal: AbortSignal): Promise<readonly RunEvent[] | null>;
}

export const RUN_DEFAULTS = {
  concurrency: 2,
  maxPending: 10,
  deadlineMs: 300_000,
  ttlMs: 600_000,
  subscribers: 20,
};

type Live = { readonly ring: Ring; readonly graph: GraphName; finishedAt: number | null };

/** Schedules agent runs and serves their live streams; finished runs are read back from the archive. */
export class Runs {
  readonly #options: typeof RUN_DEFAULTS;
  readonly #queue: PQueue;
  readonly #live = new Map<string, Live>();
  readonly #shutdown = new AbortController();

  constructor(
    private readonly deps: {
      readonly run: Runner;
      readonly archive: Archive;
      readonly model: string;
      readonly clock: Clock;
      readonly ids: Ids;
      readonly log: Log;
    },
    options: Partial<typeof RUN_DEFAULTS> = {},
  ) {
    this.#options = { ...RUN_DEFAULTS, ...options };
    this.#queue = new PQueue({ concurrency: this.#options.concurrency });
  }

  /** Creates the Run node, then queues the run. @throws WorkerError `busy` when the queue is full. */
  async start(repo: RepoRef): Promise<{ readonly runId: RunId }> {
    if (this.#queue.size >= this.#options.maxPending)
      throw new WorkerError("busy", "run.queue", "Too many runs are waiting; try again shortly");
    this.#sweep();
    const runId = RunId.parse(this.deps.ids.next());
    const graph = graphName(repo);
    await this.deps.archive.begin(graph, runId, this.deps.model);
    const live: Live = {
      ring: new Ring(limits.ringEvents, this.#options.subscribers),
      graph,
      finishedAt: null,
    };
    this.#live.set(runId, live);
    void this.#queue.add(() => this.#run(repo, runId, live));
    return { runId };
  }

  /** Whether the run is held in this process, live or recently finished. */
  has(runId: string): boolean {
    return this.#live.has(runId);
  }

  /**
   * Sends a live run's events after `lastEventId`, then new ones.
   * @returns null when the run is not live in this process, so the caller reads the archive instead.
   */
  subscribe(
    runId: string,
    lastEventId: number,
    send: (framed: Framed) => void,
  ): { readonly stop: () => void; readonly done: boolean } | null {
    const live = this.#live.get(runId);
    if (live === undefined) return null;
    let last = lastEventId;
    for (const framed of live.ring.since(lastEventId) ?? live.ring.retained()) {
      send(framed);
      last = framed.id;
    }
    if (live.finishedAt !== null) return { stop: () => {}, done: true };
    const stop = live.ring.listen((framed) => {
      if (framed.id > last) send(framed);
    });
    if (stop === null) throw new WorkerError("busy", "run.subscribers", "Too many listeners on this run");
    return { stop, done: false };
  }

  async stop(): Promise<void> {
    this.#shutdown.abort();
    this.#queue.clear();
    await this.#queue.onIdle();
  }

  async #run(repo: RepoRef, runId: RunId, live: Live): Promise<void> {
    const { log } = this.deps;
    const signal = AbortSignal.any([this.#shutdown.signal, AbortSignal.timeout(this.#options.deadlineMs)]);
    const kept: RunEvent[] = [];
    const emit = (event: RunEvent) => {
      if (event.type !== "message.delta") kept.push(event);
      live.ring.push(event);
    };
    log.info({ runId }, "job.run.started");
    try {
      await this.deps.run({ repo, graph: live.graph, runId, emit, signal });
      log.info({ runId }, "job.run.finished");
    } catch (error) {
      const failure = surfaceOf(error, "The run failed");
      if (!kept.some((event) => event.type === "run.finished")) {
        emit({ type: "run.finished", runId, status: "failed", unverified: false, report: failure.message });
      }
      log.error({ runId, code: failure.code, err: error }, "job.run.failed");
    } finally {
      await this.deps.archive
        .save(live.graph, runId, kept)
        .catch((error: unknown) => log.error({ runId, err: error }, "job.run.unsaved"));
      live.finishedAt = this.deps.clock.now();
    }
  }

  #sweep(): void {
    const cutoff = this.deps.clock.now() - this.#options.ttlMs;
    for (const [runId, live] of this.#live)
      if (live.finishedAt !== null && live.finishedAt < cutoff) this.#live.delete(runId);
  }
}
