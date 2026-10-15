import { RepoCreate, RepoRef } from "@noderunner/core";

/**
 * The one place a repository is named from user input: drops a `.git` suffix and lowercases, so the same
 * repository always has the same id, graph, and lock.
 */
export function repoFrom(body: unknown): RepoRef {
  const { url, sha } = RepoCreate.parse(body);
  const [owner = "", name = ""] = new URL(url).pathname.split("/").filter(Boolean);
  return RepoRef.parse({
    owner: owner.toLowerCase(),
    name: name.replace(/\.git$/i, "").toLowerCase(),
    ...(sha === undefined ? {} : { sha }),
  });
}

/** Parses the `:owner` and `:name` path parameters the same way. */
export function repoParams(owner: string, name: string): RepoRef {
  return RepoRef.parse({ owner: owner.toLowerCase(), name: name.toLowerCase() });
}
