import { type Forge, type RepoRef, Sha } from "@noderunner/core";
import { z } from "zod";
import { IngestError } from "../errors.ts";
import { pause } from "./wait.ts";

const API = "https://api.github.com";
const ATTEMPTS = 3;

const RepoBody = z.object({ default_branch: z.string().min(1) }).loose();

type Options = {
  /** Read only for authenticated API calls; never logged and never part of an error message. */
  readonly token?: string;
  readonly fetch?: typeof fetch;
  /** The wait before retry n is `retryMs * n`. */
  readonly retryMs?: number;
};

/** `Forge.head` and `Forge.tarball` over the GitHub REST API. */
export class GitHub implements Pick<Forge, "head" | "tarball"> {
  readonly #token: string | undefined;
  readonly #fetch: typeof fetch;
  readonly #retryMs: number;

  constructor(options: Options = {}) {
    this.#token = options.token;
    this.#fetch = options.fetch ?? fetch;
    this.#retryMs = options.retryMs ?? 500;
  }

  async head(repo: RepoRef, signal: AbortSignal): Promise<{ readonly branch: string; readonly sha: Sha }> {
    const base = `${API}/repos/${repo.owner}/${repo.name}`;
    const about = await this.#get(base, "application/vnd.github+json", signal);
    const parsed = RepoBody.safeParse(await about.json());
    if (!parsed.success)
      throw new IngestError("ingest.upstream", "GitHub returned an unexpected repository body");
    const branch = parsed.data.default_branch;
    const commit = await this.#get(
      `${base}/commits/${encodeURIComponent(branch)}`,
      "application/vnd.github.sha",
      signal,
    );
    const sha = Sha.safeParse((await commit.text()).trim());
    if (!sha.success) throw new IngestError("ingest.upstream", "GitHub returned an unexpected commit id");
    return { branch, sha: sha.data };
  }

  async *tarball(repo: RepoRef, sha: Sha, signal: AbortSignal): AsyncIterable<Uint8Array> {
    const response = await this.#get(
      `${API}/repos/${repo.owner}/${repo.name}/tarball/${sha}`,
      "application/vnd.github+json",
      signal,
    );
    if (response.body === null) throw new IngestError("ingest.upstream", "GitHub returned an empty tarball");
    try {
      for await (const chunk of response.body) yield chunk;
    } catch (error) {
      throw failure(error, signal, "the tarball download was interrupted");
    }
  }

  /** GETs `url`, retrying network failures and 5xx answers; a 404 is `ingest.missing`. */
  async #get(url: string, accept: string, signal: AbortSignal): Promise<Response> {
    const headers: Record<string, string> = {
      Accept: accept,
      "User-Agent": "noderunner",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    if (this.#token !== undefined) headers.Authorization = `Bearer ${this.#token}`;
    let last = "GitHub could not be reached";
    for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
      let response: Response;
      try {
        response = await this.#fetch(url, { headers, signal, redirect: "follow" });
      } catch (error) {
        if (signal.aborted) throw failure(error, signal, "");
        last = "GitHub could not be reached";
        if (attempt < ATTEMPTS) await pause(this.#retryMs * attempt, signal);
        continue;
      }
      if (response.ok) return response;
      if (response.status === 404) {
        throw new IngestError("ingest.missing", "GitHub has no such repository or commit, or it is private");
      }
      if (response.status < 500) {
        throw new IngestError("ingest.upstream", `GitHub refused the request (${response.status})`);
      }
      last = `GitHub answered ${response.status}`;
      await response.body?.cancel();
      if (attempt < ATTEMPTS) await pause(this.#retryMs * attempt, signal);
    }
    throw new IngestError("ingest.upstream", `${last} after ${ATTEMPTS} attempts`);
  }
}

function failure(error: unknown, signal: AbortSignal, message: string): IngestError {
  if (error instanceof IngestError) return error;
  if (signal.aborted) return new IngestError("ingest.aborted", "ingestion was stopped");
  return new IngestError("ingest.upstream", message);
}
