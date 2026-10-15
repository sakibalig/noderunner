import type { RepoRef, Sha } from "../ids.ts";

export type Commit = {
  readonly sha: Sha;
  readonly login: string | null;
  readonly name: string;
  readonly at: number;
  readonly files: readonly string[];
};

/** A change to propose as a pull request. */
export type Change = {
  readonly base: Sha;
  readonly branch: string;
  readonly message: string;
  readonly title: string;
  readonly body: string;
  readonly files: readonly { readonly path: string; readonly content: string }[];
};

/** GitHub. */
export interface Forge {
  head(repo: RepoRef, signal: AbortSignal): Promise<{ readonly branch: string; readonly sha: Sha }>;
  tarball(repo: RepoRef, sha: Sha, signal: AbortSignal): AsyncIterable<Uint8Array>;
  history(repo: RepoRef, sha: Sha, limit: number, signal: AbortSignal): Promise<readonly Commit[]>;
  read(repo: RepoRef, sha: Sha, path: string, signal: AbortSignal): Promise<string | null>;
  propose(
    repo: RepoRef,
    change: Change,
    signal: AbortSignal,
  ): Promise<{ readonly url: string; readonly number: number }>;
}
