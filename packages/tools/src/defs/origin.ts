import { type Db, limits, type ToolDef, type ToolOutput } from "@noderunner/core";
import { tools } from "@noderunner/graph/cypher";
import { z } from "zod";
import { ToolError } from "../errors.ts";
import { Collector } from "../evidence.ts";

const { chain, tier } = tools;

const Input = z.object({ key: z.string().min(1).describe("The finding key, <vulnId>|<package>") }).strict();

export type Direct = {
  readonly package: string;
  readonly range: string;
  readonly dev: boolean;
  readonly chain: readonly string[];
};
export type Data = { readonly direct: readonly Direct[] };

/** Which direct dependencies bring a vulnerable install into the tree, and through what chain. */
export function introducedBy(deps: { readonly db: Db }): ToolDef<typeof Input, Data> {
  return {
    name: "introduced_by",
    description:
      "For one finding, the direct dependencies declared in package.json whose dependency tree reaches an " +
      "affected install, with the range declared, whether it is a dev dependency, and the shortest chain.",
    input: Input,
    access: "read",
    timeoutMs: limits.toolMs,
    async run(ctx, input): Promise<ToolOutput<Data>> {
      const g = deps.db.graph(ctx.graph);
      const known = await g.query(tier.known, { keys: [input.key] }, ctx.signal);
      if (known.length === 0) throw new ToolError("tool.missing", `No finding has the key ${input.key}`);
      const rows = await g.query(chain.introduced, { key: input.key }, ctx.signal);
      const evidence = new Collector().ran(tier.known.text).ran(chain.introduced.text);
      for (const row of rows) {
        const top = row.nodeIds[0];
        const start = row.chain[0];
        evidence.node({ id: row.repoId, key: row.repoUrl, label: "Repo", name: row.repoUrl });
        row.chain.forEach((path, i) => {
          const id = row.nodeIds[i];
          if (id !== undefined) evidence.node({ id, key: path, label: "Install", name: path });
        });
        if (top !== undefined && start !== undefined) {
          evidence.edge({
            id: row.declaresId,
            type: "DECLARES",
            from: row.repoId,
            to: top,
            fromKey: row.repoUrl,
            toKey: start,
          });
        }
        row.edgeIds.forEach((id, i) => {
          const [from, to] = [row.nodeIds[i], row.nodeIds[i + 1]];
          const [fromKey, toKey] = [row.chain[i], row.chain[i + 1]];
          if (from !== undefined && to !== undefined && fromKey !== undefined && toKey !== undefined) {
            evidence.edge({ id, type: "DEPENDS_ON", from, to, fromKey, toKey });
          }
        });
      }
      const direct = rows.map((row) => ({
        package: row.package,
        range: row.range,
        dev: row.dev,
        chain: row.chain,
      }));
      const names = [...new Set(direct.map((d) => d.package))];
      return {
        data: { direct },
        summary:
          names.length === 0
            ? `${input.key} is not reached from any direct dependency`
            : `${input.key} comes in through ${names.join(", ")}`,
        evidence: evidence.done(),
      };
    },
  };
}
