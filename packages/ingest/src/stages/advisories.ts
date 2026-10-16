import {
  type Advisories,
  findingKey,
  type G,
  type Hit,
  isAffected,
  type OsvRecord,
  type Pair,
  type RunEvent,
  rangesFor,
  rank,
  type Sha,
  severityOf,
  type Warning,
} from "@noderunner/core";
import { ingest } from "@noderunner/graph/cypher";

/** At most this many OSV records are fetched at once. */
export const RECORDS_AT_ONCE = 8;
const SUMMARY_CHARS = 500;

export type Installed = { readonly lock_path: string; readonly name: string; readonly version: string };

export type VulnRow = {
  readonly id: string;
  readonly aliases: readonly string[];
  readonly severity: string;
  readonly severity_rank: number;
  readonly summary: string;
  readonly published: number;
  readonly modified: number;
  readonly ranges: string;
  readonly fixed: readonly string[];
  readonly packages: readonly string[];
};

export type Affected = {
  readonly vulns: readonly VulnRow[];
  readonly affects: readonly { readonly vuln_id: string; readonly lock_path: string }[];
  readonly findings: readonly { readonly key: string; readonly vuln_id: string; readonly package: string }[];
  readonly at: readonly { readonly key: string; readonly lock_path: string }[];
  readonly warnings: readonly Warning[];
};

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const byVersion = (a: string, b: string) => a.localeCompare(b, "en", { numeric: true });

/** The Vuln row for one advisory, keeping only the ranges of the packages this repository installs. */
export function normalise(record: OsvRecord, packages: readonly string[]): VulnRow {
  const names = [...new Set(packages)].sort(byText);
  const ranges = Object.fromEntries(names.map((name) => [name, rangesFor(record, name)]));
  const fixed = new Set<string>();
  for (const list of Object.values(ranges)) {
    for (const range of list) for (const event of range.events) if ("fixed" in event) fixed.add(event.fixed);
  }
  const severity = severityOf(record);
  return {
    id: record.id,
    aliases: [...record.aliases].sort(byText),
    severity,
    severity_rank: rank(severity),
    summary: record.summary.slice(0, SUMMARY_CHARS),
    published: Date.parse(record.published),
    modified: Date.parse(record.modified),
    ranges: JSON.stringify(ranges),
    fixed: [...fixed].sort(byVersion),
    packages: names,
  };
}

/** Distinct `(name, version)` pairs, sorted, which is what OSV is asked about. */
export function pairs(installs: readonly Installed[]): Pair[] {
  const seen = new Map<string, Pair>();
  for (const install of installs) {
    seen.set(`${install.name}@${install.version}`, { name: install.name, version: install.version });
  }
  return [...seen.entries()].sort(([a], [b]) => byText(a, b)).map(([, pair]) => pair);
}

/**
 * Joins OSV's answers back to the installs. An install is affected when OSV listed the advisory for its exact
 * name and version; core's `isAffected` is checked on the same pair and a disagreement is a `range` warning.
 */
export function affected(
  installs: readonly Installed[],
  asked: readonly Pair[],
  hits: readonly (readonly Hit[])[],
  records: ReadonlyMap<string, OsvRecord>,
): Affected {
  const byPair = new Map<string, Installed[]>();
  for (const install of installs) {
    const key = `${install.name}@${install.version}`;
    byPair.set(key, [...(byPair.get(key) ?? []), install]);
  }
  const packagesOf = new Map<string, Set<string>>();
  const affects = new Map<string, { vuln_id: string; lock_path: string }>();
  const findings = new Map<string, { key: string; vuln_id: string; package: string }>();
  const at = new Map<string, { key: string; lock_path: string }>();
  const disagree: string[] = [];
  const missing = new Set<string>();

  asked.forEach((pair, index) => {
    for (const hit of hits[index] ?? []) {
      const record = records.get(hit.id);
      if (record === undefined) {
        missing.add(hit.id);
        continue;
      }
      if (!isAffected(pair.version, rangesFor(record, pair.name))) {
        disagree.push(`${hit.id} ${pair.name}@${pair.version}`);
      }
      packagesOf.set(hit.id, (packagesOf.get(hit.id) ?? new Set()).add(pair.name));
      const key = findingKey(hit.id, pair.name);
      findings.set(key, { key, vuln_id: hit.id, package: pair.name });
      for (const install of byPair.get(`${pair.name}@${pair.version}`) ?? []) {
        affects.set(`${hit.id}\u0000${install.lock_path}`, { vuln_id: hit.id, lock_path: install.lock_path });
        at.set(`${key}\u0000${install.lock_path}`, { key, lock_path: install.lock_path });
      }
    }
  });

  const sorted = <T>(map: Map<string, T>) =>
    [...map.entries()].sort(([a], [b]) => byText(a, b)).map(([, v]) => v);
  const vulns = [...packagesOf.entries()]
    .sort(([a], [b]) => byText(a, b))
    .flatMap(([id, names]) => {
      const record = records.get(id);
      return record === undefined ? [] : [normalise(record, [...names])];
    });
  const warnings: Warning[] = [];
  if (disagree.length > 0)
    warnings.push({ code: "range", count: disagree.length, sample: disagree.slice(0, 5) });
  if (missing.size > 0) {
    warnings.push({ code: "skipped", count: missing.size, sample: [...missing].sort(byText).slice(0, 5) });
  }
  return { vulns, affects: sorted(affects), findings: sorted(findings), at: sorted(at), warnings };
}

/** Stage 4. Asks OSV about every installed version and writes Vuln, AFFECTS, Finding, ABOUT, and AT. */
export async function advisories(
  input: { readonly g: G; readonly sha: Sha; readonly installs: readonly Installed[] },
  deps: { readonly advisories: Advisories },
  opts: {
    readonly onProgress: (event: Extract<RunEvent, { type: "ingest.progress" }>) => void;
    readonly signal: AbortSignal;
  },
): Promise<{ readonly vulns: number; readonly findings: number; readonly warnings: readonly Warning[] }> {
  const { g, sha } = input;
  const { signal } = opts;
  const asked = pairs(input.installs);
  opts.onProgress({ type: "ingest.progress", stage: "advisories", done: 0, total: asked.length });
  const hits = await deps.advisories.query(asked, signal);
  const ids = [...new Set(hits.flatMap((list) => list.map((hit) => hit.id)))].sort(byText);
  const records = new Map<string, OsvRecord>();
  for (let start = 0; start < ids.length; start += RECORDS_AT_ONCE) {
    const batch = ids.slice(start, start + RECORDS_AT_ONCE);
    const fetched = await Promise.all(batch.map((id) => deps.advisories.record(id, signal)));
    fetched.forEach((record, i) => {
      const id = batch[i];
      if (record !== null && id !== undefined) records.set(id, record);
    });
  }
  const built = affected(input.installs, asked, hits, records);
  await g.batch(ingest.advisories.vulns, built.vulns, {}, signal);
  await g.batch(ingest.advisories.affects, built.affects, { sha }, signal);
  await g.batch(ingest.advisories.findings, built.findings, {}, signal);
  await g.batch(ingest.advisories.at, built.at, { sha }, signal);
  opts.onProgress({ type: "ingest.progress", stage: "advisories", done: asked.length, total: asked.length });
  return { vulns: built.vulns.length, findings: built.findings.length, warnings: built.warnings };
}
