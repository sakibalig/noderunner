import type { FindingKey, Packument, Upgrade } from "@noderunner/core";
import { type Candidate, candidates, type Kind, type Majors, type Target, targetId } from "./candidates.ts";
import { compare, jump } from "./jump.ts";

export type Solution = {
  readonly upgrades: readonly Omit<Upgrade, "id">[];
  readonly uncovered: readonly FindingKey[];
  readonly totalCost: number;
};

const jumpRank = { patch: 0, minor: 1, major: 2 } as const;
const kindRank: Readonly<Record<Kind, number>> = { refresh: 0, bump: 1, override: 2 };

/** Candidates of the same kind, package, and target version become one, covering the union. */
export function merge(list: readonly Candidate[]): Candidate[] {
  const byId = new Map<string, Candidate>();
  for (const c of list) {
    const id = `${c.kind}|${c.package}|${c.to}`;
    const seen = byId.get(id);
    byId.set(
      id,
      seen === undefined
        ? c
        : {
            ...seen,
            from: [seen.from, c.from].sort(compare)[0] ?? seen.from,
            covers: new Set([...seen.covers, ...c.covers]),
          },
    );
  }
  return [...byId.values()];
}

/** The total order of the cover: cost per newly covered target, then jump, package, kind, and version. */
function better(a: Candidate, an: number, b: Candidate, bn: number): boolean {
  const ra = a.cost / an;
  const rb = b.cost / bn;
  if (ra !== rb) return ra < rb;
  const ja = jumpRank[jump(a.from, a.to)];
  const jb = jumpRank[jump(b.from, b.to)];
  if (ja !== jb) return ja < jb;
  if (a.package !== b.package) return a.package < b.package;
  if (a.kind !== b.kind) return kindRank[a.kind] < kindRank[b.kind];
  return compare(a.to, b.to) < 0;
}

/** The stronger of two upgrades to one package: the higher version, then override over bump over refresh. */
function stronger(a: Candidate, b: Candidate): Candidate {
  const order = compare(a.to, b.to);
  if (order !== 0) return order > 0 ? a : b;
  return kindRank[a.kind] >= kindRank[b.kind] ? a : b;
}

/** The cheapest set of upgrades that covers the targets, by greedy weighted set cover; deterministic. */
export function solve(
  targets: readonly Target[],
  packuments: ReadonlyMap<string, Packument>,
  majors: Majors,
): Solution {
  const sorted = [...targets].sort((a, b) => (targetId(a) < targetId(b) ? -1 : 1));
  let pool = merge(candidates(sorted, packuments, majors));
  const chosen: Candidate[] = [];
  const covered = () => new Set(chosen.flatMap((c) => [...c.covers]));

  for (;;) {
    const done = covered();
    let pick: Candidate | undefined;
    let pickNew = 0;
    for (const c of pool) {
      const fresh = [...c.covers].filter((id) => !done.has(id)).length;
      if (fresh > 0 && (pick === undefined || better(c, fresh, pick, pickNew))) {
        pick = c;
        pickNew = fresh;
      }
    }
    if (pick === undefined) break;
    const selected: Candidate = pick;
    pool = pool.filter((c) => c !== selected);
    const rival = chosen.find((c) => c.package === selected.package);
    if (rival === undefined) {
      chosen.push(selected);
      continue;
    }
    // Two upgrades to one package: keep the stronger; the loser's targets return to the pool unless it covers them.
    const keep = stronger(rival, selected);
    if (keep === selected) chosen.splice(chosen.indexOf(rival), 1, selected);
    pool = pool.filter((c) => c.package !== selected.package);
  }

  const done = covered();
  const keys = [...new Set(sorted.map((t) => t.key))];
  const closed = new Set(
    keys.filter((key) => sorted.filter((t) => t.key === key).every((t) => done.has(targetId(t)))),
  );
  const upgrades = chosen.map((c) => ({
    kind: c.kind,
    package: c.package,
    from: c.from,
    to: c.to,
    semverJump: jump(c.from, c.to),
    cost: c.cost,
    closes: keys.filter(
      (key) => closed.has(key) && sorted.some((t) => t.key === key && c.covers.has(targetId(t))),
    ),
  }));
  return {
    upgrades,
    uncovered: keys.filter((key) => !closed.has(key)),
    totalCost: upgrades.reduce((sum, u) => sum + u.cost, 0),
  };
}
