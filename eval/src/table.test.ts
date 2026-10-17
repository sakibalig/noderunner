import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Results, type RunScore } from "./results.ts";
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
  labels: {
    total: 56,
    reachable: 12,
    checked: 5,
    corrections: [{ key: "G-1|protobufjs", tool: "dev-only", label: "import-reachable" }],
    notes: ["A note."],
  },
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
    expect(md).toContain("| Baseline (files, no graph) | 2 | 50%, 1 of 2 runs | 10% (0%–20%) |");
    expect(md).toContain("| baseline | `01JQZ8RN000000000000000000` | done, no result block | n/a | 0% |");
    expect(md).toContain("- `G-1|protobufjs`: the tool said dev-only, labelled import-reachable.\n\nA note.");
  });

  it("renders the committed results.json to the committed results.md byte for byte", () => {
    const root = join(import.meta.dirname, "..");
    const committed = Results.parse(JSON.parse(readFileSync(join(root, "results.json"), "utf8")));
    expect(table(committed)).toBe(readFileSync(join(root, "results.md"), "utf8"));
  });
});
