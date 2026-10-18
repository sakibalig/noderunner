import type { Change, Forge, RepoRef, Sha } from "@noderunner/core";
import { z } from "zod";
import { ExecutorError } from "../errors.ts";

const API = "https://api.github.com";
const READ_BYTES = 20 * 1024 * 1024;

const Sha1 = z.object({ sha: z.string() });
const Commit = z.object({ tree: Sha1 });
const About = z.object({ default_branch: z.string() });
const Pull = z.object({ html_url: z.url(), number: z.number().int() });
const Ref = z.object({ object: z.object({ sha: z.string() }) });
const Compare = z.object({ status: z.string(), files: z.array(z.object({ filename: z.string() })) });
/** GitHub's compare API lists at most this many files; a full list may be cut, so it is not trusted. */
const COMPARE_FILES = 300;

/** `Forge.read` and `Forge.propose` over the GitHub contents and Git Data APIs; the token is never logged. */
export class GitData implements Pick<Forge, "read" | "propose"> {
  readonly #token: string;
  readonly #fetch: typeof fetch;

  constructor(options: { readonly token: string; readonly fetch?: typeof fetch }) {
    this.#token = options.token;
    this.#fetch = options.fetch ?? fetch;
  }

  async read(repo: RepoRef, sha: Sha, path: string, signal: AbortSignal): Promise<string | null> {
    const res = await this.#call(
      "GET",
      `/repos/${repo.owner}/${repo.name}/contents/${path}?ref=${sha}`,
      undefined,
      signal,
      "application/vnd.github.raw+json",
    );
    if (res.status === 404) return null;
    if (!res.ok) throw upstream("read", res.status);
    const tooLarge = () => new ExecutorError("executor.unsupported", `${path} is larger than 20 MB`);
    if (Number(res.headers.get("content-length") ?? 0) > READ_BYTES) {
      await res.body?.cancel();
      throw tooLarge();
    }
    const text = await res.text();
    if (Buffer.byteLength(text) > READ_BYTES) throw tooLarge();
    return text;
  }

  async propose(
    repo: RepoRef,
    change: Change,
    signal: AbortSignal,
  ): Promise<{ readonly url: string; readonly number: number }> {
    const base = `/repos/${repo.owner}/${repo.name}`;
    const about = await this.#call("GET", base, undefined, signal);
    if (about.status === 404)
      throw new ExecutorError(
        "executor.missing",
        `${repo.owner}/${repo.name} does not exist; fork the repository first`,
      );
    const { default_branch } = About.parse(await json(about, "read"));
    const parent = await this.#parent(base, default_branch, change, signal);
    const head = await this.#call("GET", `${base}/git/commits/${parent}`, undefined, signal);
    if (head.status === 404 || head.status === 422)
      throw new ExecutorError(
        "executor.missing",
        `${repo.owner}/${repo.name} does not have the base commit; sync the fork`,
      );
    const tree = Commit.parse(await json(head, "commit")).tree.sha;
    const entries = [];
    for (const file of change.files) {
      const blob = await this.#json(
        "POST",
        `${base}/git/blobs`,
        { content: file.content, encoding: "utf-8" },
        signal,
      );
      entries.push({ path: file.path, mode: "100644", type: "blob", sha: Sha1.parse(blob).sha });
    }
    const made = Sha1.parse(
      await this.#json("POST", `${base}/git/trees`, { base_tree: tree, tree: entries }, signal),
    );
    const commit = Sha1.parse(
      await this.#json(
        "POST",
        `${base}/git/commits`,
        { message: change.message, tree: made.sha, parents: [parent] },
        signal,
      ),
    );
    const ref = await this.#call(
      "POST",
      `${base}/git/refs`,
      { ref: `refs/heads/${change.branch}`, sha: commit.sha },
      signal,
    );
    if (ref.status === 422)
      await this.#json(
        "PATCH",
        `${base}/git/refs/heads/${change.branch}`,
        { sha: commit.sha, force: true },
        signal,
      );
    else if (!ref.ok) throw upstream("push", ref.status);

    const pull = await this.#call(
      "POST",
      `${base}/pulls`,
      { title: change.title, body: change.body, head: change.branch, base: default_branch },
      signal,
    );
    if (pull.status === 422) {
      const open = z
        .array(Pull)
        .parse(
          await this.#json(
            "GET",
            `${base}/pulls?state=open&head=${repo.owner}:${change.branch}`,
            undefined,
            signal,
          ),
        );
      const [first] = open;
      if (first === undefined) throw upstream("pull request", 422);
      return { url: first.html_url, number: first.number };
    }
    const opened = Pull.parse(await json(pull, "pull request"));
    return { url: opened.html_url, number: opened.number };
  }

  /**
   * The commit the change is built on: the fork's default branch when none of the change's files differ there from
   * `change.base`, so the pull request carries only its own files and does not appear to revert later commits (GitHub
   * refuses a token without the Workflows permission a branch that differs in workflow files); else `change.base`.
   */
  async #parent(base: string, branch: string, change: Change, signal: AbortSignal): Promise<string> {
    const ref = await this.#call("GET", `${base}/git/ref/heads/${branch}`, undefined, signal);
    if (!ref.ok) return change.base;
    const tip = Ref.safeParse(await ref.json());
    if (!tip.success || tip.data.object.sha === change.base) return change.base;
    const compared = await this.#call(
      "GET",
      `${base}/compare/${change.base}...${tip.data.object.sha}`,
      undefined,
      signal,
    );
    if (!compared.ok) return change.base;
    const diff = Compare.safeParse(await compared.json());
    if (!diff.success || diff.data.status !== "ahead" || diff.data.files.length >= COMPARE_FILES)
      return change.base;
    const touched = new Set(diff.data.files.map((f) => f.filename));
    return change.files.some((f) => touched.has(f.path)) ? change.base : tip.data.object.sha;
  }

  async #json(method: string, path: string, body: unknown, signal: AbortSignal): Promise<unknown> {
    return json(await this.#call(method, path, body, signal), method === "GET" ? "read" : "push");
  }

  async #call(
    method: string,
    path: string,
    body: unknown,
    signal: AbortSignal,
    accept = "application/vnd.github+json",
  ): Promise<Response> {
    try {
      return await this.#fetch(`${API}${path}`, {
        method,
        signal,
        headers: {
          Accept: accept,
          Authorization: `Bearer ${this.#token}`,
          "User-Agent": "noderunner",
          "X-GitHub-Api-Version": "2022-11-28",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new ExecutorError("executor.forge", "GitHub could not be reached");
    }
  }
}

async function json(res: Response, what: string): Promise<unknown> {
  if (!res.ok) throw upstream(what, res.status);
  return res.json();
}

function upstream(what: string, status: number): ExecutorError {
  if (status === 401 || status === 403)
    return new ExecutorError(
      "executor.forge",
      `GitHub refused the ${what} (${status}); check the token's write access to the fork`,
    );
  if (status === 404)
    return new ExecutorError(
      "executor.missing",
      `GitHub has no such repository for the ${what}; fork it first`,
    );
  return new ExecutorError("executor.forge", `GitHub refused the ${what} (${status})`);
}
