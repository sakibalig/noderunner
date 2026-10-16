import { type Db, limits, type Tier, type ToolDef, type ToolOutput } from "@noderunner/core";
import { tools } from "@noderunner/graph/cypher";
import { z } from "zod";
import { ToolError } from "../errors.ts";
import { Collector } from "../evidence.ts";

const { tier } = tools;

const Input = z
  .object({
    keys: z
      .array(z.string().min(1))
      .max(1000)
      .default([])
      .describe("Finding keys (<vulnId>|<package>) to tier; empty or absent means every finding"),
  })
  .strict();

export type Reachable = {
  readonly key: string;
  readonly files: readonly string[];
  readonly via: string;
  readonly chain: readonly string[];
  readonly hops: number;
};
export type Data = {
  readonly counts: Readonly<Record<Tier, number>>;
  readonly reachable: readonly Reachable[];
};

/** Tiers findings by what production code loads; the graph decides every tier, never the model. */
export function reachability(deps: { readonly db: Db }): ToolDef<typeof Input, Data> {
  return {
    name: "reachability",
    description:
      "Sorts findings into tiers. import-reachable: a production file loads an install whose dependencies reach " +
      "the vulnerable install (import-level, not function-level). installed: in the production tree but not " +
      "loaded from production code. dev-only: only in the dev tree. Returns the shortest chain for each " +
      "import-reachable finding and saves every tier on the finding.",
    input: Input,
    access: "derive",
    timeoutMs: limits.toolMs,
    async run(ctx, input): Promise<ToolOutput<Data>> {
      const g = deps.db.graph(ctx.graph);
      const evidence = new Collector();
      const { keys } = input;
      if (keys.length > 0) {
        const known = new Set((await g.query(tier.known, { keys }, ctx.signal)).map((row) => row.key));
        evidence.ran(tier.known.text);
        const unknown = keys.filter((key) => !known.has(key));
        if (unknown.length > 0) {
          throw new ToolError("tool.missing", `No finding has the key ${unknown.slice(0, 3).join(", ")}`);
        }
      }

      const reached = await g.query(tier.reachable, { keys }, ctx.signal);
      const rest = await g.query(tier.rest, { keys, reachable: reached.map((row) => row.key) }, ctx.signal);
      const tiers: { key: string; tier: Tier }[] = [
        ...reached.map((row) => ({ key: row.key, tier: "import-reachable" as const })),
        ...rest.map((row) => ({
          key: row.key,
          tier: row.devOnly ? ("dev-only" as const) : ("installed" as const),
        })),
      ].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
      await g.batch(tier.save, tiers, {}, ctx.signal);
      evidence.ran(tier.reachable.text).ran(tier.rest.text).ran(tier.save.text);

      for (const row of reached) {
        evidence.node({ id: row.findingId, key: row.key, label: "Finding", name: row.key });
        row.chain.forEach((path, i) => {
          const id = row.nodeIds[i];
          if (id !== undefined) evidence.node({ id, key: path, label: "Install", name: path });
        });
        const first = row.nodeIds[0];
        const start = row.chain[0];
        for (const file of row.files) {
          evidence.node({ id: file.id, key: file.path, label: "File", name: file.path });
          if (first !== undefined && start !== undefined) {
            evidence.edge({
              id: file.edge,
              type: "LOADS",
              from: file.id,
              to: first,
              fromKey: file.path,
              toKey: start,
            });
          }
        }
        row.edgeIds.forEach((id, i) => {
          const [from, to] = [row.nodeIds[i], row.nodeIds[i + 1]];
          const [fromKey, toKey] = [row.chain[i], row.chain[i + 1]];
          if (from !== undefined && to !== undefined && fromKey !== undefined && toKey !== undefined) {
            evidence.edge({ id, type: "DEPENDS_ON", from, to, fromKey, toKey });
          }
        });
      }
      for (const row of rest)
        evidence.node({ id: row.findingId, key: row.key, label: "Finding", name: row.key });

      const counts: Record<Tier, number> = { "import-reachable": 0, installed: 0, "dev-only": 0 };
      for (const { tier: value } of tiers) counts[value] += 1;
      return {
        data: {
          counts,
          reachable: reached.map((row) => ({
            key: row.key,
            files: row.files.map((file) => file.path),
            via: row.via,
            chain: row.chain,
            hops: row.hops,
          })),
        },
        summary:
          `${tiers.length} findings tiered: ${counts["import-reachable"]} import-reachable, ` +
          `${counts.installed} installed, ${counts["dev-only"]} dev-only`,
        evidence: evidence.done(),
      };
    },
  };
}
