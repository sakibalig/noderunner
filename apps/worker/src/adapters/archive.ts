import { type Clock, type Db, type GraphName, RunEvent, type RunId } from "@noderunner/core";
import { memory } from "@noderunner/graph/cypher";
import type { Archive } from "../jobs/runs.ts";

const never = new AbortController().signal;

/** Runs live in their repository's graph; a finished run's events are stored on its Run node. */
export class GraphArchive implements Archive {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  async begin(graph: GraphName, runId: RunId, model: string): Promise<void> {
    await this.db
      .graph(graph)
      .query(memory.run.start, { id: runId, agent: "triage", model, now: this.clock.now() }, never);
  }

  async save(graph: GraphName, runId: RunId, events: readonly RunEvent[]): Promise<void> {
    await this.db.graph(graph).query(memory.run.record, { id: runId, events: JSON.stringify(events) }, never);
  }

  async find(runId: RunId, signal: AbortSignal): Promise<readonly RunEvent[] | null> {
    for (const name of await this.db.list()) {
      if (!name.startsWith("repo:")) continue;
      const [row] = await this.db.graph(name).query(memory.run.events, { id: runId }, signal);
      if (row?.events) return RunEvent.array().parse(JSON.parse(row.events));
    }
    return null;
  }
}
