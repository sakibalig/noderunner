import type { Advisories, Hit, Pair } from "@noderunner/core";
import { OsvRecord } from "@noderunner/core";
import { z } from "zod";
import { IngestError } from "../errors.ts";
import { pause } from "./wait.ts";

const API = "https://api.osv.dev/v1";
const ATTEMPTS = 3;
/** OSV rejects a batch of more than 1,000 queries with "too many queries" (S2, D5). */
export const OSV_BATCH = 1000;

const Batch = z.object({
  results: z.array(
    z
      .object({
        vulns: z.array(z.object({ id: z.string().min(1), modified: z.string() })).optional(),
        next_page_token: z.string().optional(),
      })
      .loose(),
  ),
});

type Options = {
  readonly fetch?: typeof fetch;
  /** The wait before retry n is `retryMs * n`. */
  readonly retryMs?: number;
};

type Query = { package: { name: string; ecosystem: "npm" }; version: string; page_token?: string };

/** `Advisories` over the OSV API: batched queries by package and version, and full records by id. */
export class OSV implements Advisories {
  readonly #fetch: typeof fetch;
  readonly #retryMs: number;

  constructor(options: Options = {}) {
    this.#fetch = options.fetch ?? fetch;
    this.#retryMs = options.retryMs ?? 500;
  }

  async query(pairs: readonly Pair[], signal: AbortSignal): Promise<readonly (readonly Hit[])[]> {
    const hits: Hit[][] = pairs.map(() => []);
    let pending: { index: number; query: Query }[] = pairs.map((pair, index) => ({
      index,
      query: { package: { name: pair.name, ecosystem: "npm" }, version: pair.version },
    }));
    // A query whose result has a next_page_token is asked again with that token until it has none.
    while (pending.length > 0) {
      const next: { index: number; query: Query }[] = [];
      for (let at = 0; at < pending.length; at += OSV_BATCH) {
        const chunk = pending.slice(at, at + OSV_BATCH);
        const response = await this.#send(`${API}/querybatch`, signal, {
          queries: chunk.map((item) => item.query),
        });
        const parsed = Batch.safeParse(await response.json());
        if (!parsed.success || parsed.data.results.length !== chunk.length) {
          throw new IngestError("ingest.upstream", "OSV returned an unexpected batch answer");
        }
        parsed.data.results.forEach((result, i) => {
          const item = chunk[i];
          if (item === undefined) return;
          for (const vuln of result.vulns ?? []) {
            hits[item.index]?.push({ id: vuln.id, modified: Date.parse(vuln.modified) });
          }
          if (result.next_page_token !== undefined) {
            next.push({ index: item.index, query: { ...item.query, page_token: result.next_page_token } });
          }
        });
      }
      pending = next;
    }
    return hits;
  }

  async record(id: string, signal: AbortSignal): Promise<OsvRecord | null> {
    const response = await this.#send(`${API}/vulns/${encodeURIComponent(id)}`, signal);
    if (response.status === 404) return null;
    const parsed = OsvRecord.safeParse(await response.json());
    if (!parsed.success)
      throw new IngestError("ingest.upstream", `OSV returned an unexpected record for ${id}`);
    return parsed.data;
  }

  /** GETs, or POSTs `body`, retrying network failures and 5xx answers; a 404 is returned to the caller. */
  async #send(url: string, signal: AbortSignal, body?: unknown): Promise<Response> {
    const init: RequestInit =
      body === undefined
        ? { signal }
        : {
            method: "POST",
            body: JSON.stringify(body),
            headers: { "Content-Type": "application/json" },
            signal,
          };
    let last = "OSV could not be reached";
    for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
      let response: Response;
      try {
        response = await this.#fetch(url, init);
      } catch {
        if (signal.aborted) throw new IngestError("ingest.aborted", "ingestion was stopped");
        last = "OSV could not be reached";
        if (attempt < ATTEMPTS) await pause(this.#retryMs * attempt, signal);
        continue;
      }
      if (response.ok || response.status === 404) return response;
      if (response.status < 500) {
        throw new IngestError("ingest.upstream", `OSV refused the request (${response.status})`);
      }
      last = `OSV answered ${response.status}`;
      await response.body?.cancel();
      if (attempt < ATTEMPTS) await pause(this.#retryMs * attempt, signal);
    }
    throw new IngestError("ingest.upstream", `${last} after ${ATTEMPTS} attempts`);
  }
}
