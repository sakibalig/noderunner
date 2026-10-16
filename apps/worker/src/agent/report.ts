import { FindingKey, type Json } from "@noderunner/core";
import { z } from "zod";
import type { AgentKind } from "./tools.ts";

/** The structured answer every report ends with, stored as Run.result and scored by the evaluation. */
export const ResultBlock = z.object({
  mustFix: z.array(FindingKey).describe("Finding keys the agent says must be fixed"),
  upgrades: z
    .array(z.object({ package: z.string().min(1), to: z.string().min(1) }))
    .describe("The upgrades the agent proposes"),
});
export type Result = z.infer<typeof ResultBlock>;

/** One tool call of the run, kept in memory by the loop as results arrive. */
export type StepRecord = {
  readonly stepId: string;
  readonly tool: string;
  readonly ok: boolean;
  readonly input: Json;
  readonly data?: unknown;
};

export type Verdict = { readonly ok: true } | { readonly ok: false; readonly problems: readonly string[] };

const Counts = z.object({ "import-reachable": z.number(), installed: z.number() });
const Alerts = z.object({ total: z.number() });
const Tiered = z.object({ counts: Counts, reachable: z.array(z.object({ key: z.string() })) });
const Planned = z.object({ uncovered: z.array(z.string()) });

const rows = {
  total: "All alerts",
  production: "In the production tree",
  reachable: "Import-reachable",
  open: "Still open after the plan",
} as const;

/** The last fenced `result` block, parsed; null when there is none or it does not parse. */
export function resultOf(report: string): Result | null {
  const blocks = [...report.matchAll(/```result\s*\n([\s\S]*?)```/g)];
  const last = blocks.at(-1)?.[1];
  if (last === undefined) return null;
  try {
    const parsed = ResultBlock.safeParse(JSON.parse(last));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** The number and citations in a funnel table row, or null when the row is missing. */
function row(report: string, label: string): { value: number | null; cites: string[] } | null {
  const line = report.split("\n").find((l) => new RegExp(`^\\|\\s*${label}\\s*\\|`, "i").test(l.trim()));
  if (line === undefined) return null;
  const cell = line.split("|")[2] ?? "";
  const number = /(\d[\d,]*)/.exec(cell.replace(/\[s:[^\]]*\]/g, ""));
  return {
    value: number?.[1] === undefined ? null : Number(number[1].replaceAll(",", "")),
    cites: [...cell.matchAll(/\[s:([^\]\s]+)\]/g)].map((m) => m[1] ?? ""),
  };
}

function latest(steps: readonly StepRecord[], tool: string, when: (s: StepRecord) => boolean = () => true) {
  return [...steps].reverse().find((s) => s.ok && s.tool === tool && when(s));
}

function isMap(value: Json): value is { readonly [key: string]: Json } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const unfiltered = (key: string) => (s: StepRecord) => {
  const input = s.input;
  if (!isMap(input)) return true;
  const value = input[key];
  return value === undefined || value === null || (Array.isArray(value) && value.length === 0);
};

/**
 * Checks a report against the run's own tool results: every citation names a successful step of this run, each
 * triage funnel row cites the right tool and equals its latest result, and the report ends with a valid result block.
 */
export function validateReport(agent: AgentKind, report: string, steps: readonly StepRecord[]): Verdict {
  const problems: string[] = [];
  const byId = new Map(steps.map((s) => [s.stepId, s]));
  const cited = [...report.matchAll(/\[s:([^\]\s]+)\]/g)].map((m) => m[1] ?? "");
  if (cited.length === 0) problems.push("The report cites no step; every fact needs [s:<stepId>].");
  for (const id of new Set(cited)) {
    const step = byId.get(id);
    if (step === undefined) problems.push(`[s:${id}] is not a step of this run.`);
    else if (!step.ok) problems.push(`[s:${id}] is a failed ${step.tool} call; cite a successful one.`);
  }

  if (agent === "triage" || agent === "baseline") {
    const alerts = latest(steps, "list_alerts", unfiltered("minSeverity"));
    const tiers = latest(steps, "reachability", unfiltered("keys"));
    const plan = latest(steps, "plan_upgrades");
    const total = Alerts.safeParse(alerts?.data);
    const tiered = Tiered.safeParse(tiers?.data);
    const planned = Planned.safeParse(plan?.data);
    const expected: Partial<Record<keyof typeof rows, { value: number; tools: string[] }>> = {};
    if (total.success) expected.total = { value: total.data.total, tools: ["list_alerts"] };
    if (agent === "triage" && tiered.success) {
      const reachable = tiered.data.counts["import-reachable"];
      expected.production = { value: reachable + tiered.data.counts.installed, tools: ["reachability"] };
      expected.reachable = { value: reachable, tools: ["reachability"] };
      const keys = new Set(tiered.data.reachable.map((r) => r.key));
      expected.open = planned.success
        ? { value: planned.data.uncovered.filter((k) => keys.has(k)).length, tools: ["plan_upgrades"] }
        : { value: reachable, tools: ["reachability", "plan_upgrades"] };
    }
    const required = agent === "triage" ? (Object.keys(rows) as (keyof typeof rows)[]) : (["total"] as const);
    for (const name of required) {
      const label = rows[name];
      const found = row(report, label);
      if (found === null) {
        problems.push(`The funnel has no "${label}" row.`);
        continue;
      }
      const want = expected[name];
      if (want === undefined) continue;
      if (found.value !== want.value) {
        problems.push(`"${label}" says ${found.value ?? "nothing"}, but the tool result is ${want.value}.`);
      }
      const tools = found.cites.map((id) => byId.get(id)?.tool);
      if (!tools.some((tool) => tool !== undefined && want.tools.includes(tool))) {
        problems.push(`"${label}" must cite a ${want.tools.join(" or ")} step.`);
      }
    }
  }

  if (!/```result\s*\n/.test(report)) problems.push("The report must end with a ```result block.");
  else if (resultOf(report) === null)
    problems.push("The ```result block is not valid: it needs mustFix and upgrades.");
  return problems.length === 0 ? { ok: true } : { ok: false, problems };
}
