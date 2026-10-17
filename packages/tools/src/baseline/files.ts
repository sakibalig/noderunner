import type { GraphName } from "@noderunner/core";

/** The repository's source files at the ingested commit, by path: the same set the import parser read. */
export type Files = (graph: GraphName, signal: AbortSignal) => Promise<ReadonlyMap<string, string>>;

/** A path glob: `**` crosses folders, `*` and `?` stay within one; everything else is literal. */
export function glob(pattern: string): RegExp {
  let out = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i] ?? "";
    if (c === "*" && pattern[i + 1] === "*") {
      out += pattern[i + 2] === "/" ? "(?:.*/)?" : ".*";
      i += pattern[i + 2] === "/" ? 2 : 1;
    } else if (c === "*") out += "[^/]*";
    else if (c === "?") out += "[^/]";
    else out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}
