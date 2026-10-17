import { findingKey, PlanId, RunId } from "@noderunner/core";
import { expect, it, describe as suite } from "vitest";
import { type Describable, describe } from "./describe.ts";

const brace = {
  key: findingKey("GHSA-3jxr-9vmj-r5cp", "brace-expansion"),
  severity: "moderate" as const,
  tier: "import-reachable" as const,
  file: "packages/platform-fastify/adapters/fastify-adapter.ts",
  chain: ["@fastify/static@10.1.6", "glob@10.4.5", "minimatch@9.0.5", "brace-expansion@1.1.13"],
};
const ws = {
  key: findingKey("GHSA-96hv-2xvq-fx4p", "ws"),
  severity: "high" as const,
  tier: "import-reachable" as const,
  file: null,
  chain: [],
};

const refresh: Describable["upgrades"][number] = {
  kind: "refresh",
  package: "brace-expansion",
  from: "1.1.13",
  to: "1.1.21",
  jump: "patch",
  cost: 1,
  closes: [brace],
  reviewers: [{ handle: "@kamilmysliwiec", why: "10 recent commits" }],
};

const plan: Describable = {
  planId: PlanId.parse("01JQZ8PAN00000000000000000"),
  runId: RunId.parse("01JQZ8RN000000000000000000"),
  repoId: "nestjs/nest",
  approved: false,
  shipped: null,
  totalCost: 5,
  uncovered: [],
  upgrades: [
    {
      kind: "refresh",
      package: "brace-expansion",
      from: "1.1.13",
      to: "1.1.21",
      jump: "patch",
      cost: 1,
      closes: [brace],
      reviewers: [{ handle: "@kamilmysliwiec", why: "10 recent commits" }],
    },
    {
      kind: "override",
      package: "ws",
      from: "8.18.3",
      to: "9.0.0",
      jump: "major",
      cost: 4,
      closes: [ws],
      reviewers: [{ handle: "@kamilmysliwiec", why: "1 recent commit" }],
    },
  ],
};

suite("describe", () => {
  const { title, body } = describe(plan);

  it("titles the pull request with the distinct alerts closed, all reachable", () => {
    expect(title).toBe("Noderunner: close 2 reachable vulnerabilities in nestjs/nest");
  });

  it("counts reachable alerts separately when the plan also closes other tiers", () => {
    const mixed = {
      ...plan,
      upgrades: [{ ...refresh, closes: [brace, { ...ws, tier: "dev-only" as const }] }],
    };
    expect(describe(mixed).title).toBe("Noderunner: close 2 vulnerabilities in nestjs/nest (1 reachable)");
    expect(describe(mixed).body).toContain("in development dependencies only");
  });

  it("lists every upgrade with its kind and flags a major jump as possibly breaking", () => {
    expect(body).toContain("| `brace-expansion` 1.1.13 → 1.1.21 | lockfile only | 1 | patch |");
    expect(body).toContain("| `ws` 8.18.3 → 9.0.0 | override (workaround) | 1 | major, possibly breaking |");
  });

  it("gives each alert its production path in code spans, most severe first, and says when there is none", () => {
    expect(body.indexOf("GHSA-96hv-2xvq-fx4p")).toBeLessThan(body.indexOf("GHSA-3jxr-9vmj-r5cp"));
    expect(body).toContain(
      "`packages/platform-fastify/adapters/fastify-adapter.ts` → `@fastify/static@10.1.6` → `glob@10.4.5`",
    );
    expect(body).toContain("reachable from production code: no production path recorded");
  });

  it("flags an alert that only several upgrades close together", () => {
    const joint = { ...plan, upgrades: plan.upgrades.map((u) => ({ ...u, closes: [brace] })) };
    const text = describe(joint).body;
    expect(text).toContain("1 alert needs more than one upgrade");
    expect(text).toContain("closed only by `brace-expansion` and `ws` together");
    expect(describe(joint).title).toContain("close 1 reachable vulnerability in");
  });

  it("names reviewers once, in code spans so a fork pull request does not mention them", () => {
    expect(body.match(/@kamilmysliwiec/g)).toHaveLength(1);
    expect(body).toContain("`@kamilmysliwiec`");
  });

  it("says verification is pending rather than claiming it ran", () => {
    expect(body).toContain("Pending: before this pull request opens");
  });

  it("keeps a backtick in a path from breaking its code span", () => {
    const odd = { ...plan, upgrades: [{ ...refresh, closes: [{ ...brace, file: "src/a`b.ts" }] }] };
    expect(describe(odd).body).toContain("`src/a'b.ts`");
  });

  it("lists uncovered findings only when there are some", () => {
    expect(body).not.toContain("Not covered");
    expect(describe({ ...plan, uncovered: ["X|y"] }).body).toContain("### Not covered\n\n- `X|y`");
  });

  it("describes a plan with no upgrade as a manual fix, not an empty table", () => {
    const empty = describe({ ...plan, upgrades: [], uncovered: ["GHSA-1|qs"] });
    expect(empty.title).toBe("Noderunner: no upgrade found in nestjs/nest");
    expect(empty.body).toContain("need a manual fix");
    expect(empty.body).toContain("- `GHSA-1|qs`");
  });
});

suite("describe with verification", () => {
  it("reports what the re-ingest closed, what stays open, and new alerts", () => {
    const { body } = describe(plan, {
      targeted: 2,
      closed: 1,
      stillOpen: [ws.key],
      newFindings: [findingKey("GHSA-x", "left-pad")],
    });
    expect(body).toContain("**1 of 2** targeted alerts closed");
    expect(body).toContain("Still open:\n- `GHSA-96hv-2xvq-fx4p|ws`");
    expect(body).toContain("1 new alert, none reachable from production code: `GHSA-x|left-pad`");
    expect(body).not.toContain("Pending");
  });
});
