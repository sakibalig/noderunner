import { limits, type ToolDef, type ToolOutput } from "@noderunner/core";
import { z } from "zod";
import { Collector } from "../evidence.ts";
import { type Quoted, quoted } from "../quoted.ts";
import { type Files, glob } from "./files.ts";

export const MATCHES = 50;
const EXCERPT = 200;

const Input = z
  .object({
    text: z.string().min(1).max(200).describe("A literal substring to find, not a regular expression"),
    glob: z
      .string()
      .min(1)
      .max(100)
      .optional()
      .describe('Only files whose path matches, such as "src/**/*.ts"'),
  })
  .strict();

export type Data = {
  readonly matches: readonly { readonly path: string; readonly line: number; readonly excerpt: Quoted }[];
  readonly truncated: boolean;
};

/** Baseline only: finds a literal substring in the repository's source files; never touches the graph. */
export function searchFiles(deps: { readonly files: Files }): ToolDef<typeof Input, Data> {
  return {
    name: "search_files",
    description:
      "Searches the repository's source files for a literal substring (not a regular expression), optionally " +
      `only in paths matching a glob. Returns at most ${MATCHES} matches as path, line number, and the line.`,
    input: Input,
    access: "read",
    timeoutMs: limits.toolMs,
    async run(ctx, input): Promise<ToolOutput<Data>> {
      const files = await deps.files(ctx.graph, ctx.signal);
      const only = input.glob === undefined ? null : glob(input.glob);
      const matches: { path: string; line: number; excerpt: Quoted }[] = [];
      let truncated = false;
      for (const path of [...files.keys()].sort()) {
        if (only !== null && !only.test(path)) continue;
        const lines = (files.get(path) ?? "").split("\n");
        for (const [i, line] of lines.entries()) {
          if (!line.includes(input.text)) continue;
          if (matches.length === MATCHES) {
            truncated = true;
            break;
          }
          matches.push({ path, line: i + 1, excerpt: quoted(line.trim().slice(0, EXCERPT)) });
        }
        if (truncated) break;
      }
      return {
        data: { matches, truncated },
        summary: `${matches.length}${truncated ? "+" : ""} matches for the text`,
        evidence: new Collector().done(),
      };
    },
  };
}
