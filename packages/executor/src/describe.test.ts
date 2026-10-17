import { findingKey, PlanId, RunId } from "@noderunner/core";
import { expect, it, describe as suite } from "vitest";
import { type Describable, describe } from "./describe.ts";

const plan: Describable = {
  planId: PlanId.parse("01JQZ8PAN00000000000000000"),
  runId: RunId.parse("01JQZ8RN000000000000000000"),
  repoId: "nestjs/nest",
  approved: false,
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
      closes: [
        {
          key: findingKey("GHSA-3jxr-9vmj-r5cp", "brace-expansion"),
          severity: "moderate",
          file: "packages/platform-fastify/adapters/fastify-adapter.ts",
          chain: ["@fastify/static@10.1.6", "glob@10.4.5", "minimatch@9.0.5", "brace-expansion@1.1.13"],
        },
      ],
      reviewers: [{ handle: "@kamilmysliwiec", why: "10 recent commits" }],
    },
    {
      kind: "override",
      package: "ws",
      from: "8.18.3",
      to: "8.21.0",
      jump: "major",
      cost: 4,
      closes: [{ key: findingKey("GHSA-96hv-2xvq-fx4p", "ws"), severity: "high", file: null, chain: [] }],
      reviewers: [{ handle: "@kamilmysliwiec", why: "1 recent commit" }],
    },
  ],
};

suite("describe", () => {
  const { title, body } = describe(plan);

  it("titles the pull request with the number of distinct alerts closed", () => {
    expect(title).toBe("Noderunner: close 2 reachable vulnerabilities in nestjs/nest");
  });

  it("lists every upgrade with its kind and flags a major jump as possibly breaking", () => {
    expect(body).toContain("| `brace-expansion` 1.1.13 → 1.1.21 | lockfile only | 1 | patch |");
    expect(body).toContain("| `ws` 8.18.3 → 8.21.0 | override (workaround) | 1 | major, possibly breaking |");
  });

  it("gives each alert its production path, most severe first, and says when there is none", () => {
    const high = body.indexOf("GHSA-96hv-2xvq-fx4p");
    const moderate = body.indexOf("GHSA-3jxr-9vmj-r5cp");
    expect(high).toBeLessThan(moderate);
    expect(body).toContain(
      "`packages/platform-fastify/adapters/fastify-adapter.ts` → @fastify/static@10.1.6 → glob@10.4.5 → minimatch@9.0.5 → brace-expansion@1.1.13",
    );
    expect(body).toContain("in `ws`: no production path recorded");
  });

  it("names each reviewer once", () => {
    expect(body.match(/@kamilmysliwiec/g)).toHaveLength(1);
  });

  it("lists uncovered findings only when there are some", () => {
    expect(body).not.toContain("Not covered");
    expect(describe({ ...plan, uncovered: ["X|y"] }).body).toContain("### Not covered\n\n- X|y");
  });

  it("uses the singular for one alert", () => {
    expect(describe({ ...plan, upgrades: plan.upgrades.slice(0, 1) }).title).toContain(
      "1 reachable vulnerability in",
    );
  });
});
