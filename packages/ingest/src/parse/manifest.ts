import { Json } from "@noderunner/core";
import { z } from "zod";
import { IngestError } from "../errors.ts";

const Ranges = z.record(z.string(), z.string()).describe("Package name to declared range");

/** The fields of the root package.json that ingestion reads; any other field is kept and ignored. */
export const Manifest = z
  .object({
    name: z.string().optional().describe("The package name"),
    main: z.string().optional().describe("The CommonJS entry"),
    module: z.string().optional().describe("The ES module entry"),
    bin: z
      .union([z.string(), z.record(z.string(), z.string())])
      .optional()
      .describe("Executable entries"),
    exports: Json.optional().describe("The exports map; every string leaf is an entry"),
    dependencies: Ranges.optional(),
    devDependencies: Ranges.optional(),
    optionalDependencies: Ranges.optional(),
    peerDependencies: Ranges.optional(),
    overrides: Json.optional().describe("npm overrides"),
  })
  .loose();
export type Manifest = z.infer<typeof Manifest>;

/** Parses package.json text; anything that is not a JSON object of the expected shape is `ingest.manifest`. */
export function manifest(text: string): Manifest {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new IngestError("ingest.manifest", "package.json is not valid JSON");
  }
  const parsed = Manifest.safeParse(raw);
  if (!parsed.success)
    throw new IngestError("ingest.manifest", "package.json does not have the expected shape");
  return parsed.data;
}
