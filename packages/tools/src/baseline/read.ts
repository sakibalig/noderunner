import { limits, type ToolDef, type ToolOutput } from "@noderunner/core";
import { z } from "zod";
import { ToolError } from "../errors.ts";
import { Collector } from "../evidence.ts";
import { type Quoted, quoted } from "../quoted.ts";
import type { Files } from "./files.ts";

export const LINES = 400;
/** Keeps the result inside `limits.modelChars`, so the model gets every line returned and `next` is exact. */
export const READ_CHARS = limits.modelChars - 1_000;

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
  /** The offset to read from next, or null at the end of the file. */
  readonly next: number | null;
};

/** Baseline only: reads up to 400 lines of one source file; never touches the graph. */
export function readFile(deps: { readonly files: Files }): ToolDef<typeof Input, Data> {
  return {
    name: "read_file",
    description:
      `Reads up to ${LINES} lines of one of the repository's files, from an optional line offset; a long file ` +
      "comes back in parts, and next is the offset of the following part.",
    input: Input,
    access: "read",
    timeoutMs: limits.toolMs,
    async run(ctx, input): Promise<ToolOutput<Data>> {
      const text = (await deps.files(ctx.graph, ctx.signal)).get(input.path);
      if (text === undefined) throw new ToolError("tool.missing", "No source file has that path");
      const all = text.split("\n");
      const offset = Math.min(input.offset ?? 0, all.length);
      const lines: string[] = [];
      let size = 0;
      for (const line of all.slice(offset, offset + LINES)) {
        if (lines.length > 0 && size + line.length + 1 > READ_CHARS) break;
        lines.push(line.slice(0, READ_CHARS));
        size += line.length + 1;
      }
      const end = offset + lines.length;
      return {
        data: {
          path: input.path,
          offset,
          lines: quoted(lines.join("\n")),
          next: end < all.length ? end : null,
        },
        summary: `lines ${offset + 1} to ${end} of ${all.length} in ${input.path}`,
        evidence: new Collector().done(),
      };
    },
  };
}
