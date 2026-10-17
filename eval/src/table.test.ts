import { describe, expect, it } from "vitest";
import type { Results, RunScore } from "./results.ts";
import { table } from "./table.ts";

const run = (agent: RunScore["agent"], over: Partial<RunScore>): RunScore => ({
  agent,
  runId: "01JQZ8RN000000000000000000",
  status: "done",
  unverified: false,
  result: true,
  mustFix: [],
  precision: 1,
  recall: 1,
  upgrades: 3,
  calls: 9,
  tokensIn: 50_000,
  tokensOut: 6_000,
  ms: 120_000,
  ...over,
});

const results: Results = {
  repo: "nestjs/nest",
  sha: "c215fd9b4f583486c6ce39a3c43f257dc67e8329",
  model: "openai/gpt-5",
  date: "2026-10-17",
  labels: { total: 56, reachable: 10, checked: 4, corrections: 0 },
  runs: [
    run("triage", {}),
    run("triage", { ms: 100_000 }),
    run("baseline", { precision: 0.5, recall: 0.2, calls: 15, status: "capped" }),
    run("baseline", { precision: null, recall: 0, result: false }),
  ],
};

describe("table", () => {
  it("renders the median with the range, every run, and its limits", () => {
    const md = table(results);
    expect(md).toContain(
      "| Graph agent | 2 | 100% | 100% | 0 | 3 | 9 | 50,000 | 6,000 | 110 s (100 s–120 s) |",
    );
    expect(md).toContain("| Baseline (files, no graph) | 2 | 50% | 10% (0%–20%) |");
    expect(md).toContain("| baseline | `01JQZ8RN000000000000000000` | done, no result block | n/a | 0% |");
    expect(md).toContain("with 0 corrections");
  });
});
