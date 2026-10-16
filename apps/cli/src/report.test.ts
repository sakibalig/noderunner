import { FindingKey, GraphName, Sha } from "@noderunner/core";
import { describe, expect, it } from "vitest";
import { pkg, type Report, render } from "./report.ts";

const QS = FindingKey.parse("GHSA-hrpp-h998-j3pp|qs");
const EXPRESS = FindingKey.parse("GHSA-rv95-896h-c2vc|express");

const refresh = {
  id: "U1",
  kind: "refresh" as const,
  package: "express",
  from: "4.17.1",
  to: "4.22.3",
  semverJump: "minor" as const,
  cost: 1,
  closes: [QS, EXPRESS],
};

const base: Report = {
  repo: "acme/mini-repo",
  runId: "01JQZ8ABCDEFGHJKMNPQRSTVWX",
  ingest: {
    graph: GraphName.parse("repo:acme/mini-repo"),
    sha: Sha.parse("1".repeat(40)),
    counts: { files: 6, installs: 12, vulns: 4, findings: 4, people: 0 },
    warnings: [],
    ms: { fetch: 0, lockfile: 0, imports: 0, advisories: 0, people: 0, prune: 0 },
  },
  ingestMs: 1234,
  alerts: { total: 4, bySeverity: { critical: 0, high: 2, moderate: 2, low: 0, unknown: 0 } },
  severities: new Map([[QS, "high"]]),
  tiers: { "import-reachable": 2, installed: 1, "dev-only": 1 },
  reachable: [
    {
      key: QS,
      files: ["src/server.ts"],
      chain: ["node_modules/express", "node_modules/body-parser", "node_modules/qs"],
      hops: 2,
    },
  ],
  origins: new Map([[QS, [{ package: "express", range: "^4.17.1" }]]]),
  stale: [],
  inForce: 0,
  plan: {
    upgrades: [refresh],
    uncovered: [],
    totalCost: 1,
  },
  reviewers: new Map([["U1", [{ handle: "@owner", why: "owns src/server.ts" }]]]),
  steps: [
    { tool: "list_alerts", stepId: "S1", summary: "4 open findings" },
    { tool: "reachability", stepId: "S2", summary: "4 findings tiered" },
    { tool: "plan_upgrades", stepId: "S3", summary: "1 upgrade closes 2 findings at cost 1" },
  ],
};

describe("render", () => {
  it("prints the chain from the production file, the origin, the plan, and the reviewers, citing each step", () => {
    const text = render(base);
    expect(text).toContain("acme/mini-repo @ 1111111");
    expect(text).toContain("2 import-reachable, 1 installed only, 1 dev-only  [s:S2]");
    expect(text).toContain(
      "  GHSA-hrpp-h998-j3pp  qs  (high)\n    src/server.ts → express → body-parser → qs\n    comes in through express (^4.17.1)",
    );
    expect(text).toContain("PLAN  1 upgrade, cost 1, closes 2 of 2  [s:S3]");
    expect(text).toContain(
      "1. refresh express 4.17.1 → 4.22.3  minor, closes 2\n       review: @owner, owns src/server.ts",
    );
    expect(text).toContain("STEPS  stored in the graph as Run 01JQZ8ABCDEFGHJKMNPQRSTVWX");
  });

  it("says plainly when nothing is reachable, labels overrides as workarounds, and lists stale decisions", () => {
    const quiet = render({
      ...base,
      reachable: [],
      plan: null,
      tiers: { "import-reachable": 0, installed: 3, "dev-only": 1 },
    });
    expect(quiet).toContain("None: no production file loads a vulnerable install.");
    expect(quiet).toContain("No plan: nothing import-reachable to fix.");
    const override = render({
      ...base,
      plan: { upgrades: [{ ...refresh, kind: "override" }], uncovered: [QS], totalCost: 4 },
      stale: [{ key: QS, kind: "waive", staleReason: "worse vulnerability on same install" }],
    });
    expect(override).toContain("override (workaround) express");
    expect(override).toContain("left open: GHSA-hrpp-h998-j3pp|qs");
    expect(override).toContain("stale: waive on GHSA-hrpp-h998-j3pp|qs, worse vulnerability on same install");
  });

  it("names at most three direct dependencies a finding comes in through", () => {
    const many = ["a", "b", "c", "d", "e"].map((p) => ({ package: p, range: "^1" }));
    expect(render({ ...base, origins: new Map([[QS, many]]) })).toContain(
      "comes in through a (^1), b (^1), c (^1) and 2 more",
    );
  });

  it("names the package a lock path installs, including scoped and nested ones", () => {
    expect(pkg("node_modules/a/node_modules/@scope/b")).toBe("@scope/b");
    expect(pkg("packages/web/node_modules/react")).toBe("react");
  });
});
