import { type Clock, type Ids, limits, type RepoRef, type RunEvent } from "@noderunner/core";
import PQueue from "p-queue";
import { surfaceOf, WorkerError } from "../errors.ts";
import type { Log } from "../log.ts";
import type { Ingester } from "./catalog.ts";
import { type Framed, Ring } from "./ring.ts";

export const DEFAULTS = {
  concurrency: 2,
  maxPending: 10,
  deadlineMs: 300_000,
  ttlMs: 600_000,
  subscribers: 20,
};

const terminal = new Set<RunEvent["type"]>(["ingest.finished", "job.failed", "pr.opened", "pr.refused"]);

/** Whether an event ends a job's stream. */
export function ends(event: RunEvent): boolean {
  return terminal.has(event.type);
}

type Job = { readonly ring: Ring; finishedAt: number | null };

/** Schedules ingestions and serves their event streams. Runs and shipments arrive with T15. */
export class Jobs {
  readonly #options: typeof DEFAULTS;
  readonly #queue: PQueue;
  readonly #jobs = new Map<string, Job>();
  readonly #ingesting = new Set<string>();
  readonly #shutdown = new AbortController();

  constructor(
    private readonly deps: {
      readonly ingest: Ingester;
      readonly clock: Clock;
      readonly ids: Ids;
      readonly log: Log;
    },
    options: Partial<typeof DEFAULTS> = {},
  ) {
    this.#options = { ...DEFAULTS, ...options };
    this.#queue = new PQueue({ concurrency: this.#options.concurrency });
  }

  /**
   * Starts an ingestion of a normalised repository.
   * @throws WorkerError `busy` while the same repository is ingesting or the queue is full.
   */
  ingest(repo: RepoRef): { readonly jobId: string } {
    const repoId = `${repo.owner}/${repo.name}`;
    if (this.#ingesting.has(repoId))
      throw new WorkerError("busy", "job.busy", `${repoId} is already ingesting`);
    if (this.#queue.size >= this.#options.maxPending)
      throw new WorkerError("busy", "job.queue", "Too many jobs are waiting; try again shortly");
    this.#sweep();
    const jobId = this.deps.ids.next();
    const job: Job = { ring: new Ring(limits.ringEvents, this.#options.subscribers), finishedAt: null };
    this.#jobs.set(jobId, job);
    this.#ingesting.add(repoId);
    void this.#queue.add(() => this.#run(jobId, job, repo, repoId));
    return { jobId };
  }

  ingesting(repoId: string): boolean {
    return this.#ingesting.has(repoId);
  }

  /**
   * Sends the job's events after `lastEventId` (or every retained event when those were evicted), then live ones.
   * @returns `done` when the job has already ended, so the caller closes after the backlog.
   * @throws WorkerError `missing` for an unknown job, `busy` when the stream already has its maximum of listeners.
   */
  subscribe(
    jobId: string,
    lastEventId: number,
    send: (framed: Framed) => void,
  ): { readonly stop: () => void; readonly done: boolean } {
    const job = this.#jobs.get(jobId);
    if (job === undefined) throw new WorkerError("missing", "job.missing", "No such job");
    let last = lastEventId;
    for (const framed of job.ring.since(lastEventId) ?? job.ring.retained()) {
      send(framed);
      last = framed.id;
    }
    if (job.finishedAt !== null) return { stop: () => {}, done: true };
    const stop = job.ring.listen((framed) => {
      if (framed.id > last) send(framed);
    });
    if (stop === null) throw new WorkerError("busy", "job.subscribers", "Too many listeners on this stream");
    return { stop, done: false };
  }

  /** Aborts every job and waits for the queue to drain. */
  async stop(): Promise<void> {
    this.#shutdown.abort();
    this.#queue.clear();
    await this.#queue.onIdle();
  }

  async #run(jobId: string, job: Job, repo: RepoRef, repoId: string): Promise<void> {
    const { log } = this.deps;
    const deadline = AbortSignal.timeout(this.#options.deadlineMs);
    const signal = AbortSignal.any([this.#shutdown.signal, deadline]);
    log.info({ jobId, repoId }, "job.ingest.started");
    try {
      const report = await this.deps.ingest(repo, { onProgress: (event) => job.ring.push(event), signal });
      signal.throwIfAborted();
      job.ring.push({ type: "ingest.finished", report });
      log.info({ jobId, repoId, counts: report.counts }, "job.ingest.finished");
    } catch (error) {
      const failure = deadline.aborted
        ? { code: "upstream" as const, message: "Ingestion timed out" }
        : surfaceOf(error, "Ingestion failed");
      job.ring.push({ type: "job.failed", ...failure });
      log.error({ jobId, repoId, code: failure.code, err: error }, "job.ingest.failed");
    } finally {
      job.finishedAt = this.deps.clock.now();
      this.#ingesting.delete(repoId);
    }
  }

  #sweep(): void {
    const cutoff = this.deps.clock.now() - this.#options.ttlMs;
    for (const [jobId, job] of this.#jobs)
      if (job.finishedAt !== null && job.finishedAt < cutoff) this.#jobs.delete(jobId);
  }
}
