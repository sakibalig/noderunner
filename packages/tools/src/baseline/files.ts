import type { GraphName } from "@noderunner/core";

/** The repository's source files at the ingested commit, by path: the same set the import parser read. */
export type Files = (graph: GraphName, signal: AbortSignal) => Promise<ReadonlyMap<string, string>>;

/**
 * A path glob as a matcher: `**` spans folders, `*` and `?` stay within one, everything else is literal. It never
 * backtracks exponentially, because a model or a quoted file can write the pattern.
 */
export function glob(pattern: string): (path: string) => boolean {
  const parts = pattern.split("/");
  return (path) => {
    const names = path.split("/");
    const memo = new Map<number, boolean>();
    const at = (i: number, j: number): boolean => {
      const key = i * (names.length + 1) + j;
      const seen = memo.get(key);
      if (seen !== undefined) return seen;
      const part = parts[i];
      const name = names[j];
      let result: boolean;
      if (part === undefined) result = name === undefined;
      else if (part === "**") result = at(i + 1, j) || (name !== undefined && at(i, j + 1));
      else result = name !== undefined && wild(part, name) && at(i + 1, j + 1);
      memo.set(key, result);
      return result;
    };
    return at(0, 0);
  };
}

/** `*` and `?` within one name, matched in O(pattern × name) with a single backtrack point. */
function wild(pattern: string, name: string): boolean {
  let p = 0;
  let n = 0;
  let star = -1;
  let resume = 0;
  while (n < name.length) {
    if (p < pattern.length && (pattern[p] === "?" || pattern[p] === name[n])) {
      p += 1;
      n += 1;
    } else if (p < pattern.length && pattern[p] === "*") {
      star = p;
      resume = n;
      p += 1;
    } else if (star !== -1) {
      p = star + 1;
      resume += 1;
      n = resume;
    } else return false;
  }
  while (pattern[p] === "*") p += 1;
  return p === pattern.length;
}
