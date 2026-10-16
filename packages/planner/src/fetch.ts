import type { Packument, Registry } from "@noderunner/core";
import type { Target } from "./solve/candidates.ts";

/** Each finding may charge this many new registry fetches, and a plan this many in all. */
export const BUDGET = Object.freeze({ finding: 60, plan: 300 });

/**
 * Fetches the packuments the targets need, in key order, once per name. A finding past its budget, or a plan past
 * its own, leaves names unfetched, so those targets fall back to override. A name the registry cannot give is
 * recorded as unavailable and the prefetch continues.
 */
export async function prefetch(
  targets: readonly Target[],
  registry: Registry,
  signal: AbortSignal,
): Promise<{ readonly packuments: ReadonlyMap<string, Packument>; readonly unavailable: readonly string[] }> {
  const packuments = new Map<string, Packument>();
  const tried = new Set<string>();
  const unavailable: string[] = [];
  const byKey = new Map<string, Target[]>();
  for (const t of [...targets].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))) {
    byKey.set(t.key, [...(byKey.get(t.key) ?? []), t]);
  }
  for (const list of byKey.values()) {
    const names = [...new Set(list.flatMap((t) => [t.package, ...t.chains.flatMap((c) => c.path)]))];
    let charged = 0;
    for (const name of names) {
      if (tried.has(name)) continue;
      if (charged >= BUDGET.finding || tried.size >= BUDGET.plan) break;
      signal.throwIfAborted();
      tried.add(name);
      charged += 1;
      try {
        const packument = await registry.packument(name, signal);
        if (packument === null) unavailable.push(name);
        else packuments.set(name, packument);
      } catch {
        signal.throwIfAborted();
        unavailable.push(name);
      }
    }
  }
  return { packuments, unavailable: unavailable.sort() };
}
