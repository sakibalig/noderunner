import { describe, expect, it } from "vitest";
import { resultOf, type StepRecord, validateReport } from "./report.ts";

const steps: StepRecord[] = [
  { stepId: "A", tool: "list_alerts", ok: true, input: {}, data: { total: 4 } },
  {
    stepId: "R",
    tool: "reachability",
    ok: true,
    input: {},
    data: {
      counts: { "import-reachable": 2, installed: 1, "dev-only": 1 },
      reachable: [{ key: "Q|qs" }, { key: "E|express" }],
    },
  },
  {
    stepId: "P",
    tool: "plan_upgrades",
    ok: true,
    input: { tiers: ["import-reachable"] },
    data: { uncovered: [] },
  },
  { stepId: "X", tool: "introduced_by", ok: false, input: { key: "Z|z" } },
];

const result =
  '```result\n{"mustFix": ["Q|qs", "E|express"], "upgrades": [{"package": "express", "to": "4.22.3"}]}\n```';
const funnel = (total = 4, production = 3, reachable = 2, open = 0, cite = "P") => `## Funnel
| Stage | Count |
| --- | --- |
| All alerts | ${total} [s:A] |
| In the production tree | ${production} [s:R] |
| Import-reachable | ${reachable} [s:R] |
| Still open after the plan | ${open} [s:${cite}] |
`;
const good = `${funnel()}\nOne refresh of express closes both [s:P].\n\n${result}\n`;

describe("validateReport", () => {
  it("accepts a report whose funnel matches the tools and whose citations are all real", () => {
    expect(validateReport("triage", good, steps)).toEqual({ ok: true });
  });

  it.each([
    ["no citation at all", `## Funnel\nnothing\n${result}`, "cites no step"],
    ["an unknown step", good.replace("[s:P].", "[s:nope]."), "[s:nope] is not a step of this run"],
    ["a failed step", good.replace("[s:P].", "[s:X]."), "[s:X] is a failed introduced_by call"],
    ["a missing row", good.replace(/\| In the production tree.*\n/, ""), 'no "In the production tree" row'],
    [
      "a number one off",
      good.replace("| Import-reachable | 2", "| Import-reachable | 3"),
      '"Import-reachable" says 3, but the tool result is 2',
    ],
    [
      "a row citing the wrong tool",
      good.replace("| All alerts | 4 [s:A]", "| All alerts | 4 [s:R]"),
      '"All alerts" must cite a list_alerts step',
    ],
    ["no result block", good.replace(result, ""), "must end with a ```result block"],
    ["a malformed result block", good.replace(result, '```result\n{"mustFix": 3}\n```'), "is not valid"],
  ])("rejects %s", (_, report, problem) => {
    const verdict = validateReport("triage", report, steps);
    expect(verdict.ok).toBe(false);
    expect(verdict.ok ? [] : verdict.problems.join("\n")).toContain(problem);
  });

  it("checks the total against an unfiltered list_alerts, not a filtered one", () => {
    const filtered: StepRecord = {
      stepId: "F",
      tool: "list_alerts",
      ok: true,
      input: { minSeverity: "high" },
      data: { total: 1 },
    };
    expect(validateReport("triage", good, [...steps, filtered])).toEqual({ ok: true });
  });

  it("counts still-open reachable findings from the plan, and all reachable ones when there is no plan", () => {
    const open: StepRecord = {
      stepId: "P",
      tool: "plan_upgrades",
      ok: true,
      input: {},
      data: { uncovered: ["Q|qs", "D|dev"] },
    };
    const withPlan = [...steps.slice(0, 2), open];
    expect(
      validateReport(
        "triage",
        good.replace("| Still open after the plan | 0", "| Still open after the plan | 1"),
        withPlan,
      ),
    ).toEqual({ ok: true });
    const noPlan = steps.slice(0, 2);
    const report = `${funnel(4, 3, 2, 2, "R")}\n${result}`;
    expect(validateReport("triage", report, noPlan)).toEqual({ ok: true });
  });
});

describe("resultOf", () => {
  it("uses the last result block when there are two", () => {
    const two = `${result}\n\n\`\`\`result\n{"mustFix": [], "upgrades": []}\n\`\`\``;
    expect(resultOf(two)).toEqual({ mustFix: [], upgrades: [] });
  });
});
