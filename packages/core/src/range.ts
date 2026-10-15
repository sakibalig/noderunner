import semver from "semver";
import { z } from "zod";
import { Severity } from "./domain.ts";

export const OsvEvent = z.union([
  z.object({ introduced: z.string() }),
  z.object({ fixed: z.string() }),
  z.object({ last_affected: z.string() }),
  z.object({ limit: z.string() }),
]);
export type OsvEvent = z.infer<typeof OsvEvent>;

export const OsvRange = z.object({
  type: z.enum(["SEMVER", "ECOSYSTEM", "GIT"]).describe("The range's version scheme"),
  events: z.array(OsvEvent).describe("The range's events, in any order"),
});
export type OsvRange = z.infer<typeof OsvRange>;

/** The subset of an OSV vulnerability record that ingestion reads. */
export const OsvRecord = z.object({
  id: z.string().min(1).describe("The OSV id, such as GHSA-35jh-r3h4-6jhm"),
  aliases: z.array(z.string()).default([]).describe("Other ids, such as the CVE"),
  summary: z.string().default("").describe("One-line summary; untrusted text"),
  published: z.string().describe("ISO 8601 timestamp"),
  modified: z.string().describe("ISO 8601 timestamp"),
  database_specific: z
    .object({ severity: z.string().optional() })
    .loose()
    .optional()
    .describe("GitHub advisory extras, including the severity word"),
  affected: z
    .array(
      z.object({
        package: z.object({ name: z.string(), ecosystem: z.string() }).describe("The affected package"),
        ranges: z.array(OsvRange).default([]).describe("Affected ranges"),
      }),
    )
    .default([])
    .describe("Affected packages; one package may appear in several entries"),
});
export type OsvRecord = z.infer<typeof OsvRecord>;

/** All ranges an advisory gives one npm package, across its `affected` entries. */
export function rangesFor(record: OsvRecord, pkg: string): readonly OsvRange[] {
  return record.affected
    .filter((entry) => entry.package.ecosystem === "npm" && entry.package.name === pkg)
    .flatMap((entry) => entry.ranges);
}

export function severityOf(record: OsvRecord): Severity {
  const word = record.database_specific?.severity?.toLowerCase();
  const parsed = Severity.safeParse(word === "medium" ? "moderate" : word);
  return parsed.success ? parsed.data : "unknown";
}

type Interval = { readonly from: string | null; readonly to: string | null; readonly inclusive: boolean };

type Bound = { readonly version: string | null; readonly event: OsvEvent };

function boundOf(event: OsvEvent): Bound | null {
  const raw =
    "introduced" in event
      ? event.introduced
      : "fixed" in event
        ? event.fixed
        : "last_affected" in event
          ? event.last_affected
          : event.limit;
  if ("introduced" in event && raw === "0") return { version: null, event };
  const valid = semver.valid(raw);
  return valid === null ? null : { version: valid, event };
}

function intervals(range: OsvRange): readonly Interval[] {
  if (range.type === "GIT") return [];
  const bounds = range.events
    .map(boundOf)
    .filter((bound): bound is Bound => bound !== null)
    .sort((a, b) =>
      a.version === null ? -1 : b.version === null ? 1 : semver.compare(a.version, b.version),
    );
  const out: Interval[] = [];
  let open: { readonly from: string | null } | null = null;
  for (const bound of bounds) {
    if ("introduced" in bound.event) {
      open ??= { from: bound.version };
    } else if (open !== null) {
      out.push({ from: open.from, to: bound.version, inclusive: "last_affected" in bound.event });
      open = null;
    }
  }
  if (open !== null) out.push({ from: open.from, to: null, inclusive: false });
  return out;
}

function inside(version: string, interval: Interval): boolean {
  if (interval.from !== null && semver.lt(version, interval.from)) return false;
  if (interval.to === null) return true;
  return interval.inclusive ? semver.lte(version, interval.to) : semver.lt(version, interval.to);
}

/** Whether a version falls inside any OSV range; `GIT` ranges are ignored. */
export function isAffected(version: string, ranges: readonly OsvRange[]): boolean {
  const valid = semver.valid(version);
  if (valid === null) return false;
  return ranges.some((range) => intervals(range).some((interval) => inside(valid, interval)));
}

/** Finds the lowest fixed version above an installed version that no range still affects. */
export function lowestFixed(version: string, ranges: readonly OsvRange[]): string | null {
  const valid = semver.valid(version);
  if (valid === null) return null;
  const fixes = ranges
    .filter((range) => range.type !== "GIT")
    .flatMap((range) => range.events)
    .flatMap((event) => ("fixed" in event ? [semver.valid(event.fixed)] : []))
    .filter((fixed): fixed is string => fixed !== null && semver.gt(fixed, valid))
    .sort(semver.compare);
  return fixes.find((fixed) => !isAffected(fixed, ranges)) ?? null;
}
