import { z } from "zod";
import { IngestError } from "../errors.ts";

const Ranges = z.record(z.string(), z.string()).describe("Package name to declared range");

/** One entry of the lockfile's `packages` map, keyed by its install path. */
export const Entry = z
  .object({
    name: z.string().optional().describe("Set when the folder name differs from the package name"),
    version: z.string().optional().describe("The installed version; absent on a link"),
    link: z.boolean().optional().describe("A workspace link"),
    dev: z.boolean().optional(),
    devOptional: z.boolean().optional(),
    optional: z.boolean().optional(),
    dependencies: Ranges.optional(),
    optionalDependencies: Ranges.optional(),
    peerDependencies: Ranges.optional(),
  })
  .loose();
export type Entry = z.infer<typeof Entry>;

/** package-lock.json version 2 or 3; version 1 has no `packages` map and is not supported. */
export const Lock = z
  .object({
    lockfileVersion: z.union([z.literal(2), z.literal(3)]).describe("The lockfile format"),
    packages: z
      .record(z.string(), Entry)
      .describe("Install path to entry; the root project is the empty key"),
  })
  .loose();
export type Lock = z.infer<typeof Lock>;

const Version = z.object({ lockfileVersion: z.number() }).loose();

/** Parses package-lock.json text; an unsupported or malformed lockfile is `ingest.lockfile`. */
export function lock(text: string): Lock {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new IngestError("ingest.lockfile", "package-lock.json is not valid JSON");
  }
  const version = Version.safeParse(raw);
  if (version.success && version.data.lockfileVersion !== 2 && version.data.lockfileVersion !== 3) {
    throw new IngestError(
      "ingest.lockfile",
      `package-lock.json version ${version.data.lockfileVersion} is not supported; versions 2 and 3 are`,
    );
  }
  const parsed = Lock.safeParse(raw);
  if (!parsed.success) {
    throw new IngestError("ingest.lockfile", "package-lock.json does not have the expected shape");
  }
  return parsed.data;
}
