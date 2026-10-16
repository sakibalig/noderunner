import {
  type FindingKey,
  isAffected,
  type LockPath,
  lowestFixed,
  type OsvRange,
  type Packument,
} from "@noderunner/core";
import semver from "semver";
import { compare, jump } from "./jump.ts";

/** One (finding, affected install) pair: the unit an upgrade covers. */
export type Target = {
  readonly key: FindingKey;
  readonly package: string;
  readonly lockPath: LockPath;
  readonly version: string;
  readonly ranges: readonly OsvRange[];
  /** Every declared range that selects this install: DEPENDS_ON ranges into it and its DECLARES range. */
  readonly parents: readonly string[];
  readonly chains: readonly Chain[];
};

/** A route from a direct dependency down to the target, at most two hops: package names, direct first. */
export type Chain = {
  readonly direct: string;
  readonly version: string;
  readonly range: string;
  readonly path: readonly string[];
};

export type Kind = "refresh" | "bump" | "override";
export type Majors = "allow" | "skip";

export type Candidate = {
  readonly kind: Kind;
  readonly package: string;
  readonly from: string;
  readonly to: string;
  readonly cost: number;
  /** Target ids, `<key>#<lockPath>`. */
  readonly covers: ReadonlySet<string>;
};

export const targetId = (t: Pick<Target, "key" | "lockPath">) => `${t.key}#${t.lockPath}`;

const BUMP_VERSIONS = 40;

function stable(packument: Packument | undefined): string[] {
  if (packument === undefined) return [];
  return Object.keys(packument.versions)
    .filter((v) => semver.valid(v) !== null && semver.prerelease(v) === null)
    .sort(compare);
}

function best(packument: Packument | undefined, range: string): string | null {
  if (packument === undefined) return null;
  return semver.maxSatisfying(Object.keys(packument.versions), range);
}

function deps(packument: Packument | undefined, version: string): Readonly<Record<string, string>> | null {
  return packument?.versions[version]?.deps ?? null;
}

/**
 * Whether installing `chain.direct` at `version` gets the target to an unaffected version, following what a fresh
 * install picks (`maxSatisfying`) at each hop. A version that no longer depends on the next package also counts.
 */
export function resolves(
  chain: Chain,
  version: string,
  target: Target,
  packuments: ReadonlyMap<string, Packument>,
): "fixed" | "affected" | "unknown" {
  let current = version;
  for (let hop = 1; hop < chain.path.length; hop += 1) {
    const here = chain.path[hop - 1];
    const next = chain.path[hop];
    if (here === undefined || next === undefined) return "unknown";
    const declared = deps(packuments.get(here), current);
    if (declared === null) return "unknown";
    const range = declared[next];
    if (range === undefined) return "fixed";
    const picked = best(packuments.get(next), range);
    if (picked === null) return "unknown";
    current = picked;
  }
  return isAffected(current, target.ranges) ? "affected" : "fixed";
}

function single(target: Target): boolean {
  return target.parents.length === 1;
}

/** Every refresh, bump, and override the targets allow, before merging. */
export function candidates(
  targets: readonly Target[],
  packuments: ReadonlyMap<string, Packument>,
  majors: Majors,
): Candidate[] {
  const out: Candidate[] = [];
  const add = (kind: Kind, pkg: string, from: string, to: string, cost: number, covered: Target[]) => {
    if (covered.length > 0)
      out.push({ kind, package: pkg, from, to, cost, covers: new Set(covered.map(targetId)) });
  };

  // Refresh of a package in place: every parent range already picks an unaffected version.
  const byPackage = new Map<string, Target[]>();
  for (const t of targets) byPackage.set(t.package, [...(byPackage.get(t.package) ?? []), t]);
  for (const [pkg, list] of byPackage) {
    const covered: Target[] = [];
    const picks: string[] = [];
    for (const t of list) {
      const picked = t.parents.map((range) => best(packuments.get(pkg), range));
      if (picked.length > 0 && picked.every((v) => v !== null && !isAffected(v, t.ranges))) {
        covered.push(t);
        for (const v of picked) if (v !== null) picks.push(v);
      }
    }
    const from = covered.map((t) => t.version).sort(compare)[0];
    const to = picks.sort(compare)[0];
    if (from !== undefined && to !== undefined) add("refresh", pkg, from, to, 1, covered);
  }

  // Through each direct dependency: a refresh within its declared range, then the first bump past it.
  const byDirect = new Map<string, { chain: Chain; target: Target }[]>();
  for (const t of targets) {
    if (!single(t)) continue;
    for (const chain of t.chains)
      byDirect.set(chain.direct, [...(byDirect.get(chain.direct) ?? []), { chain, target: t }]);
  }
  for (const [direct, routes] of byDirect) {
    const packument = packuments.get(direct);
    const first = routes[0];
    if (packument === undefined || first === undefined) continue;
    const { version: current, range } = first.chain;
    const inRange = best(packument, range);
    if (inRange !== null && compare(inRange, current) > 0) {
      const covered = routes.filter(
        ({ chain, target }) => resolves(chain, inRange, target, packuments) === "fixed",
      );
      add(
        "refresh",
        direct,
        current,
        inRange,
        1,
        covered.map((r) => r.target),
      );
    }
    const above = stable(packument)
      .filter((v) => compare(v, current) > 0 && !semver.satisfies(v, range))
      .filter((v) => majors === "allow" || jump(current, v) !== "major")
      .slice(0, BUMP_VERSIONS);
    // Each version records every route it fixes, so a kept higher bump still covers what a dropped lower one did.
    const remaining = new Set(routes.map((r) => targetId(r.target)));
    for (const version of above) {
      const covered = routes.filter(
        ({ chain, target }) => resolves(chain, version, target, packuments) === "fixed",
      );
      if (!covered.some((r) => remaining.has(targetId(r.target)))) continue;
      add(
        "bump",
        direct,
        current,
        version,
        jump(current, version) === "major" ? 5 : 2,
        covered.map((r) => r.target),
      );
      for (const r of covered) remaining.delete(targetId(r.target));
      if (remaining.size === 0) break;
    }
  }

  // Override per finding: pin the highest lowest fix over its installs, none if one has no fix. A pin applies to
  // every copy of the package, so it covers each target of that package the pinned version is not affected for.
  const byKey = new Map<string, Target[]>();
  for (const t of targets) byKey.set(t.key, [...(byKey.get(t.key) ?? []), t]);
  for (const list of byKey.values()) {
    const fixes = list.map((t) => lowestFixed(t.version, t.ranges));
    const found = fixes.filter((f): f is string => f !== null);
    if (found.length < fixes.length) continue;
    const to = found.sort(compare).at(-1);
    const pkg = list[0]?.package;
    if (to === undefined || pkg === undefined) continue;
    const covered = (byPackage.get(pkg) ?? []).filter((t) => !isAffected(to, t.ranges));
    const from = covered.map((t) => t.version).sort(compare)[0];
    if (from !== undefined) add("override", pkg, from, to, 4, covered);
  }
  return out;
}
