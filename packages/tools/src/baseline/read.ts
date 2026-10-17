import { limits, type ToolDef, type ToolOutput } from "@noderunner/core";
import { z } from "zod";
import { ToolError } from "../errors.ts";
import { Collector } from "../evidence.ts";
import { type Quoted, quoted } from "../quoted.ts";
import type { Files } from "./files.ts";

export const LINES = 400;

const Input = z
  .object({
    path: z.string().min(1).max(500).describe("A source file path, as search_files returns it"),
    offset: z.number().int().min(0).optional().describe("The first line to return, counted from 0"),
  })
  .strict();

export type Data = {
  readonly path: string;
  readonly offset: number;
  readonly lines: Quoted;
  readonly truncated: boolean;
};

/** Baseline only: reads up to 400 lines of one source file; never touches the graph. */
export function readFile(deps: { readonly files: Files }): ToolDef<typeof Input, Data> {
  return {
    name: "read_file",
    description: `Reads up to ${LINES} lines of one of the repository's source files, from an optional line offset.`,
    input: Input,
    access: "read",
    timeoutMs: limits.toolMs,
    async run(ctx, input): Promise<ToolOutput<Data>> {
      const text = (await deps.files(ctx.graph, ctx.signal)).get(input.path);
      if (text === undefined) throw new ToolError("tool.missing", "No source file has that path");
      const all = text.split("\n");
      const offset = input.offset ?? 0;
      const lines = all.slice(offset, offset + LINES);
      return {
        data: {
          path: input.path,
          offset,
          lines: quoted(lines.join("\n")),
          truncated: offset + LINES < all.length,
        },
        summary: `${lines.length} lines of ${input.path}`,
        evidence: new Collector().done(),
      };
    },
  };
}
