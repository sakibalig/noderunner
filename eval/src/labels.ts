import { readFileSync } from "node:fs";
import { Tier } from "@noderunner/core";
import { z } from "zod";

export const Repos = z.array(
  z.object({
    repo: z.string().regex(/^[a-z0-9._-]+\/[a-z0-9._-]+$/),
    sha: z.string().regex(/^[0-9a-f]{40}$/),
  }),
);
export type Repos = z.infer<typeof Repos>;

export const LabelFile = z.object({
  repo: z.string(),
  sha: z.string(),
  labels: z.record(z.string(), Tier).describe("One tier per finding key at the pinned commit"),
  corrections: z.array(z.object({ key: z.string(), tool: Tier, label: Tier, why: z.string().min(1) })),
  checked: z
    .array(z.object({ key: z.string(), how: z.string().min(1) }))
    .describe("Labels confirmed by hand against the source and the lockfile"),
});
export type LabelFile = z.infer<typeof LabelFile>;

/** A configuration or label error, raised before any model call, naming the file and key. */
export class LabelError extends Error {
  override readonly name = "LabelError";
}

export function load(path: string): LabelFile {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new LabelError(`${path} is missing or not JSON; run pnpm eval label first`);
  }
  const parsed = LabelFile.safeParse(raw);
  if (!parsed.success)
    throw new LabelError(`${path} is not a label file: ${parsed.error.issues[0]?.message}`);
  return parsed.data;
}

/** Stops the run when the labels are for another commit, or any finding at the commit has no label. */
export function check(path: string, file: LabelFile, pinned: string, keys: readonly string[]): void {
  if (file.sha !== pinned) throw new LabelError(`${path} labels ${file.sha}, but repos.json pins ${pinned}`);
  const missing = keys.filter((key) => !(key in file.labels));
  if (missing.length > 0) throw new LabelError(`${path} has no label for ${missing.slice(0, 3).join(", ")}`);
  const extra = Object.keys(file.labels).filter((key) => !keys.includes(key));
  if (extra.length > 0)
    throw new LabelError(`${path} labels ${extra[0]}, which is not a finding at ${pinned}`);
}

/** The keys labelled import-reachable: the set every run is scored against. */
export function reachable(file: LabelFile): ReadonlySet<string> {
  return new Set(
    Object.entries(file.labels)
      .filter(([, tier]) => tier === "import-reachable")
      .map(([key]) => key),
  );
}
