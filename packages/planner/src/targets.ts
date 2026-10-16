import { FindingKey, type G, LockPath, OsvRange, type Tier } from "@noderunner/core";
import { tools } from "@noderunner/graph/cypher";
import { z } from "zod";
import { PlannerError } from "./errors.ts";
import type { Chain, Target } from "./solve/candidates.ts";

const Ranges = z.record(z.string(), z.array(OsvRange));

/** Loads the targets in the given tiers with their parent ranges, advisory ranges, and chains. */
export async function load(g: G, tiers: readonly Tier[], signal: AbortSignal): Promise<Target[]> {
  const rows = await g.query(tools.plan.targets, { tiers: [...tiers] }, signal);
  const routes = await g.query(tools.plan.chains, { tiers: [...tiers] }, signal);
  const chains = new Map<string, Chain[]>();
  for (const row of routes) {
    const id = `${row.key}#${row.lockPath}`;
    const [direct] = row.path;
    if (direct === undefined) continue;
    const list = chains.get(id) ?? [];
    if (!list.some((c) => c.path.join("/") === row.path.join("/"))) {
      list.push({ direct, version: row.version, range: row.range, path: row.path });
    }
    chains.set(id, list);
  }
  return rows.map((row) => {
    let ranges: z.infer<typeof Ranges>;
    try {
      ranges = Ranges.parse(JSON.parse(row.ranges));
    } catch {
      throw new PlannerError("planner.ranges", "Advisory data is malformed; re-ingest");
    }
    return {
      key: FindingKey.parse(row.key),
      package: row.package,
      lockPath: LockPath.parse(row.lockPath),
      version: row.version,
      ranges: ranges[row.package] ?? [],
      parents: [...row.deps, ...row.declared],
      chains: chains.get(`${row.key}#${row.lockPath}`) ?? [],
    };
  });
}
