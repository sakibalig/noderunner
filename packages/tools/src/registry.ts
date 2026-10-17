import type { Access, Agent, Clock, Db, Ids, Registry, ToolDef, ToolName } from "@noderunner/core";
import type { z } from "zod";
import type { Files } from "./baseline/files.ts";
import { readFile } from "./baseline/read.ts";
import { searchFiles } from "./baseline/search.ts";
import { listAlerts } from "./defs/alerts.ts";
import { recordDecision } from "./defs/decide.ts";
import { introducedBy } from "./defs/origin.ts";
import { ownersFor } from "./defs/owners.ts";
import { planUpgrades } from "./defs/plan.ts";
import { readOnlyCypher } from "./defs/query.ts";
import { reachability } from "./defs/reachability.ts";
import { recallDecisions } from "./defs/recall.ts";
import { openPullRequest, type Ship } from "./defs/ship.ts";

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

export type Deps = {
  readonly db: Db;
  readonly clock: Clock;
  readonly ids: Ids;
  readonly registry: Registry;
  /** Absent where nothing ships, which leaves open_pull_request out. */
  readonly ship?: Ship;
  /** The source files for the baseline's search_files and read_file; absent outside the evaluation. */
  readonly files?: Files;
};

/** Every built tool, in contract order. */
export function createTools(deps: Deps): readonly AnyTool[] {
  return [
    recallDecisions(deps),
    listAlerts(deps),
    reachability(deps),
    introducedBy(deps),
    planUpgrades(deps),
    ownersFor(deps),
    recordDecision(deps),
    ...(deps.ship === undefined ? [] : [openPullRequest({ ship: deps.ship })]),
    readOnlyCypher(deps),
    ...(deps.files === undefined
      ? []
      : [searchFiles({ files: deps.files }), readFile({ files: deps.files })]),
  ];
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
