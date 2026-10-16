import { type Clock, type Db, limits, type ToolDef, type ToolOutput } from "@noderunner/core";
import { tools } from "@noderunner/graph/cypher";
import { z } from "zod";
import { ToolError } from "../errors.ts";
import { Collector } from "../evidence.ts";

const RECENT_MS = 90 * 24 * 60 * 60 * 1000;
const OWNER_POINTS = 3;
const REVIEWERS = 2;

const Input = z.object({ planId: z.string().min(1).describe("The plan from plan_upgrades") }).strict();

export type Reviewer = { readonly handle: string; readonly why: string };
export type Data = {
  readonly perUpgrade: readonly { readonly upgrade: string; readonly reviewers: readonly Reviewer[] }[];
};

type Score = { points: number; owned: string[]; commits: number };

/** Names up to two reviewers per upgrade from CODEOWNERS and recent commits on the production files involved. */
export function ownersFor(deps: { readonly db: Db; readonly clock: Clock }): ToolDef<typeof Input, Data> {
  return {
    name: "owners_for",
    description:
      "For each upgrade in a plan, the people who should review it: CODEOWNERS of the production files that load " +
      "the affected code score 3 per file, plus one per commit to those files in the last 90 days. Top two each.",
    input: Input,
    access: "derive",
    timeoutMs: limits.toolMs,
    async run(ctx, input): Promise<ToolOutput<Data>> {
      const g = deps.db.graph(ctx.graph);
      const [exists] = await g.query(tools.owners.plan, { planId: input.planId }, ctx.signal);
      if ((exists?.n ?? 0) === 0) throw new ToolError("tool.missing", `No plan has the id ${input.planId}`);
      const since = deps.clock.now() - RECENT_MS;
      const rows = await g.query(tools.owners.files, { planId: input.planId, since }, ctx.signal);

      const scores = new Map<string, Map<string, Score>>();
      for (const row of rows) {
        const people = scores.get(row.upgrade) ?? new Map<string, Score>();
        scores.set(row.upgrade, people);
        const at = (handle: string) => {
          const score = people.get(handle) ?? { points: 0, owned: [], commits: 0 };
          people.set(handle, score);
          return score;
        };
        for (const handle of row.owners) {
          const score = at(handle);
          score.points += OWNER_POINTS;
          score.owned.push(row.file);
        }
        for (const change of row.changed) {
          if (change.handle === null || change.commits === null) continue;
          const score = at(change.handle);
          score.points += change.commits;
          score.commits += change.commits;
        }
      }
      const perUpgrade = [...scores.entries()]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([upgrade, people]) => ({
          upgrade,
          reviewers: [...people.entries()]
            .sort(([ha, a], [hb, b]) => b.points - a.points || (ha < hb ? -1 : 1))
            .slice(0, REVIEWERS)
            .map(([handle, s]) => ({
              handle,
              why: [
                s.owned.length > 0 ? `owns ${s.owned.slice(0, 3).join(", ")}` : "",
                s.commits > 0 ? `${s.commits} recent commits` : "",
              ]
                .filter((part) => part !== "")
                .join("; "),
            })),
        }));
      await g.batch(
        tools.owners.save,
        perUpgrade.flatMap((u) =>
          u.reviewers.map((r) => ({ upgrade: u.upgrade, handle: r.handle, why: r.why })),
        ),
        {},
        ctx.signal,
      );
      const evidence = new Collector().ran(tools.owners.files.text).ran(tools.owners.save.text);
      for (const row of await g.query(tools.owners.review, { planId: input.planId }, ctx.signal)) {
        evidence.node({ id: row.upgradeNode, key: row.upgrade, label: "Upgrade", name: row.upgrade });
        evidence.node({ id: row.personNode, key: row.handle, label: "Person", name: row.handle });
        evidence.edge({
          id: row.edge,
          type: "REVIEW_BY",
          from: row.upgradeNode,
          to: row.personNode,
          fromKey: row.upgrade,
          toKey: row.handle,
        });
      }
      const named = perUpgrade.reduce((n, u) => n + u.reviewers.length, 0);
      return {
        data: { perUpgrade },
        summary:
          named === 0
            ? "No owners or recent authors found for the files these upgrades touch"
            : `${named} reviewers named for ${perUpgrade.length} upgrades`,
        evidence: evidence.done(),
      };
    },
  };
}
