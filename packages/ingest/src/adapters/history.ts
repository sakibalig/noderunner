import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { type Commit, Fault, type Forge, type RepoRef, Sha } from "@noderunner/core";
import { z } from "zod";

const run = promisify(execFile);
const GIT_MS = 60_000;
const API_PAGE = 100;

/** Git or the GitHub API failed while reading history. */
export class HistoryError extends Fault {
  readonly code = "ingest.history";
  readonly surface = "upstream";
}

const ApiCommits = z.array(
  z.object({ sha: z.string(), author: z.object({ login: z.string() }).nullable() }).loose(),
);

type Options = {
  /** Read only for authenticated GitHub API calls; never logged or passed to git. */
  readonly token?: string;
  readonly cloneUrl?: (repo: RepoRef) => string;
  readonly fetch?: typeof fetch;
};

/**
 * `Forge.history` over a blob-less partial fetch of the commit (no file contents, no checkout) plus the GitHub
 * commit list, which supplies each author's login.
 */
export class GitHistory implements Pick<Forge, "history"> {
  constructor(private readonly options: Options = {}) {}

  async history(repo: RepoRef, sha: Sha, limit: number, signal: AbortSignal): Promise<readonly Commit[]> {
    const dir = await mkdtemp(join(tmpdir(), "noderunner-history-"));
    try {
      const url = this.options.cloneUrl?.(repo) ?? `https://github.com/${repo.owner}/${repo.name}.git`;
      const git = (args: readonly string[]) =>
        run("git", ["-C", dir, ...args], {
          signal,
          timeout: GIT_MS,
          maxBuffer: 64 * 1024 * 1024,
          env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        });
      await git(["init", "--quiet"]);
      // One commit beyond the limit: the deepest fetched commit has no known parent, so git lists every file in the
      // repository as changed by it. It is dropped, which leaves exactly `limit` commits with real file lists.
      await git(["fetch", "--quiet", "--filter=blob:none", `--depth=${limit + 1}`, url, sha]);
      const { stdout } = await git(["log", "--format=%x1e%H%x1f%an%x1f%aI", "--name-only", "FETCH_HEAD"]);
      const boundary = await shallow(dir);
      const logins = await this.#logins(repo, sha, limit, signal);
      return parseLog(stdout)
        .filter((entry) => !boundary.has(entry.sha))
        .map((entry) => ({ ...entry, login: logins.get(entry.sha) ?? null }));
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof HistoryError) throw error;
      throw new HistoryError("Could not read the repository history");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  async #logins(
    repo: RepoRef,
    sha: Sha,
    limit: number,
    signal: AbortSignal,
  ): Promise<ReadonlyMap<string, string>> {
    const logins = new Map<string, string>();
    const doFetch = this.options.fetch ?? fetch;
    const headers: Record<string, string> = { Accept: "application/vnd.github+json" };
    if (this.options.token) headers.Authorization = `Bearer ${this.options.token}`;
    for (let page = 1; page <= Math.ceil(limit / API_PAGE); page++) {
      const url = `https://api.github.com/repos/${repo.owner}/${repo.name}/commits?sha=${sha}&per_page=${API_PAGE}&page=${page}`;
      const res = await doFetch(url, { headers, signal });
      if (!res.ok) throw new HistoryError(`GitHub answered ${res.status} for the commit list`);
      const commits = ApiCommits.parse(await res.json());
      for (const commit of commits) if (commit.author !== null) logins.set(commit.sha, commit.author.login);
      if (commits.length < API_PAGE) break;
    }
    return logins;
  }
}

/** The commits at the edge of a shallow fetch, or none when the whole history was fetched. */
async function shallow(dir: string): Promise<ReadonlySet<string>> {
  const text = await readFile(join(dir, ".git", "shallow"), "utf8").catch(() => "");
  return new Set(
    text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== ""),
  );
}

/** Parses `git log --format=%x1e%H%x1f%an%x1f%aI --name-only` output; login is filled in by the caller. */
export function parseLog(stdout: string): Omit<Commit, "login">[] {
  return stdout
    .split("\u001e")
    .map((block) => block.trim())
    .filter((block) => block !== "")
    .map((block) => {
      const [header = "", ...paths] = block.split("\n");
      const [sha = "", name = "", date = ""] = header.split("\u001f");
      return {
        sha: Sha.parse(sha),
        name,
        at: Date.parse(date),
        files: paths.map((path) => path.trim()).filter((path) => path !== ""),
      };
    });
}
