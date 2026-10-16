import type { Access, Agent, Db, ToolDef, ToolName } from "@noderunner/core";
import type { z } from "zod";
import { reachability } from "./defs/reachability.ts";

export type AnyTool = ToolDef<z.ZodType, unknown>;

/** The contract's "who gets which tools" (contracts/mcp/tools.md); a tool not built yet is simply absent. */
const sets: Readonly<Record<Agent, readonly ToolName[]>> = {
  triage: [
    "recall_decisions",
    "list_alerts",
    "reachability",
    "introduced_by",
    "rank_packages",
    "plan_upgrades",
    "owners_for",
    "record_decision",
    "read_only_cypher",
  ],
  fixer: ["recall_decisions", "list_alerts", "owners_for", "open_pull_request", "read_only_cypher"],
  baseline: ["list_alerts", "search_files", "read_file"],
  mcp: [
    "recall_decisions",
    "list_alerts",
    "reachability",
    "introduced_by",
    "rank_packages",
    "plan_upgrades",
    "owners_for",
    "record_decision",
    "open_pull_request",
    "read_only_cypher",
  ],
  ui: ["record_decision", "open_pull_request"],
};

export type Deps = { readonly db: Db };

/** Every built tool, in contract order. */
export function createTools(deps: Deps): readonly AnyTool[] {
  return [reachability(deps)];
}

/** The tools an actor may call, limited to the given access levels. */
export function available(
  actor: Agent,
  access: readonly Access[],
  defs: readonly AnyTool[],
): readonly AnyTool[] {
  const allowed = new Set(sets[actor]);
  return defs.filter((def) => allowed.has(def.name) && access.includes(def.access));
}
