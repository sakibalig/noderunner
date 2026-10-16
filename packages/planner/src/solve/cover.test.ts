import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FindingKey, LockPath, type OsvRange, OsvRecord, type Packument, rangesFor } from "@noderunner/core";
import { describe, expect, it } from "vitest";
import type { Chain, Target } from "./candidates.ts";
import { solve } from "./cover.ts";
import { jump } from "./jump.ts";

const root = join(import.meta.dirname, "../../../..");

/** A recorded abbreviated packument in the Registry port's shape. */
function packument(name: string): Packument {
  const raw = JSON.parse(readFileSync(join(root, "fixtures/npm", `${name}.json`), "utf8")) as {
    name: string;
    versions: Record<
      string,
      {
        dependencies?: Record<string, string>;
        peerDependencies?: Record<string, string>;
        optionalDependencies?: Record<string, string>;
      }
    >;
  };
  return {
    name: raw.name,
    versions: Object.fromEntries(
      Object.entries(raw.versions).map(([v, i]) => [
        v,
        { deps: { ...i.peerDependencies, ...i.optionalDependencies, ...i.dependencies } },
      ]),
    ),
  };
}
const record = (path: string) => OsvRecord.parse(JSON.parse(readFileSync(join(root, path), "utf8")));
const hrpp = record("packages/core/src/fixtures/osv/GHSA-hrpp-h998-j3pp.json");
const rv95 = record("fixtures/osv/GHSA-rv95-896h-c2vc.json");
const vh95 = record("fixtures/osv/GHSA-vh95-rmgr-6w4m.json");
const npm = new Map(["express", "body-parser", "qs", "mkdirp", "minimist"].map((n) => [n, packument(n)]));

const QS = FindingKey.parse("GHSA-hrpp-h998-j3pp|qs");
const EXPRESS = FindingKey.parse("GHSA-rv95-896h-c2vc|express");

function qs(
  parents: string[],
  chains: Chain[],
  ranges: readonly OsvRange[] = rangesFor(hrpp, "qs"),
  key = QS,
): Target {
  return {
    key,
    package: "qs",
    lockPath: LockPath.parse("node_modules/qs"),
    version: "6.7.0",
    ranges,
    parents,
    chains,
  };
}
function express(range: string): Target {
  return {
    key: EXPRESS,
    package: "express",
    lockPath: LockPath.parse("node_modules/express"),
    version: "4.17.1",
    ranges: rangesFor(rv95, "express"),
    parents: [range],
    chains: [{ direct: "express", version: "4.17.1", range, path: ["express"] }],
  };
}
const viaExpress = (range: string): Chain => ({
  direct: "express",
  version: "4.17.1",
  range,
  path: ["express", "body-parser", "qs"],
});

describe("solve", () => {
  it("refreshes a direct dependency within its range when that fixes a finding two hops down too", () => {
    expect(solve([qs(["6.7.0"], [viaExpress("^4.17.1")]), express("^4.17.1")], npm, "skip")).toEqual({
      upgrades: [
        {
          kind: "refresh",
          package: "express",
          from: "4.17.1",
          to: "4.22.3",
          semverJump: "minor",
          cost: 1,
          closes: [QS, EXPRESS],
        },
      ],
      uncovered: [],
      totalCost: 1,
    });
  });

  it("refreshes a package in place when every parent range already allows a fix", () => {
    expect(solve([qs(["~6.7.0"], [])], npm, "skip").upgrades).toEqual([
      {
        kind: "refresh",
        package: "qs",
        from: "6.7.0",
        to: "6.7.5",
        semverJump: "patch",
        cost: 1,
        closes: [QS],
      },
    ]);
  });

  it("bumps the direct parent one hop up when its exact pin keeps the vulnerable version", () => {
    const chain: Chain = {
      direct: "body-parser",
      version: "1.19.0",
      range: "1.19.0",
      path: ["body-parser", "qs"],
    };
    expect(solve([qs(["6.7.0"], [chain])], npm, "skip").upgrades).toEqual([
      {
        kind: "bump",
        package: "body-parser",
        from: "1.19.0",
        to: "1.19.2",
        semverJump: "patch",
        cost: 2,
        closes: [QS],
      },
    ]);
  });

  it("finds the bump two hops up that closes both findings at once", () => {
    expect(solve([qs(["6.7.0"], [viaExpress("4.17.1")]), express("4.17.1")], npm, "skip")).toEqual({
      upgrades: [
        {
          kind: "bump",
          package: "express",
          from: "4.17.1",
          to: "4.19.2",
          semverJump: "minor",
          cost: 2,
          closes: [QS, EXPRESS],
        },
      ],
      uncovered: [],
      totalCost: 2,
    });
  });

  it("refreshes mkdirp to fix minimist below it", () => {
    const minimist: Target = {
      key: FindingKey.parse("GHSA-vh95-rmgr-6w4m|minimist"),
      package: "minimist",
      lockPath: LockPath.parse("node_modules/minimist"),
      version: "1.2.0",
      ranges: rangesFor(vh95, "minimist"),
      parents: ["0.0.8 || 1.2.0"],
      chains: [{ direct: "mkdirp", version: "0.5.1", range: "^0.5.1", path: ["mkdirp", "minimist"] }],
    };
    expect(solve([minimist], npm, "skip").upgrades.map((u) => [u.kind, u.package, u.to, u.cost])).toEqual([
      ["refresh", "mkdirp", "0.5.6", 1],
    ]);
  });

  describe("majors", () => {
    const e = packument("express");
    const only = new Map(npm);
    only.set("express", {
      name: "express",
      versions: {
        "4.17.1": e.versions["4.17.1"] ?? { deps: {} },
        "5.0.0": e.versions["5.0.0"] ?? { deps: {} },
      },
    });

    it("overrides when the only bump is major and majors are skipped", () => {
      expect(solve([express("4.17.1")], only, "skip").upgrades.map((u) => [u.kind, u.to, u.cost])).toEqual([
        ["override", "4.19.2", 4],
      ]);
    });

    it("still overrides one finding when majors are allowed, since 4 beats 5", () => {
      expect(solve([express("4.17.1")], only, "allow").upgrades.map((u) => [u.kind, u.to])).toEqual([
        ["override", "4.19.2"],
      ]);
    });

    it("takes the major bump when it closes two findings, since 2.5 each beats 4", () => {
      const result = solve([qs(["6.7.0"], [viaExpress("4.17.1")]), express("4.17.1")], only, "allow");
      expect(result.upgrades).toEqual([
        {
          kind: "bump",
          package: "express",
          from: "4.17.1",
          to: "5.0.0",
          semverJump: "major",
          cost: 5,
          closes: [QS, EXPRESS],
        },
      ]);
    });
  });

  it("overrides to the lowest fix when the registry gave nothing", () => {
    expect(solve([qs(["6.7.0"], [viaExpress("^4.17.1")])], new Map(), "skip").upgrades).toEqual([
      {
        kind: "override",
        package: "qs",
        from: "6.7.0",
        to: "6.7.3",
        semverJump: "patch",
        cost: 4,
        closes: [QS],
      },
    ]);
  });

  it("leaves a finding with no fix uncovered and proposes nothing for it", () => {
    const noFix: OsvRange[] = [{ type: "SEMVER", events: [{ introduced: "0" }, { last_affected: "9.9.9" }] }];
    expect(solve([qs(["6.7.0"], [], noFix)], npm, "skip")).toEqual({
      upgrades: [],
      uncovered: [QS],
      totalCost: 0,
    });
  });

  it("never bumps through a shared install, which needs a refresh or an override", () => {
    const chain: Chain = {
      direct: "body-parser",
      version: "1.19.0",
      range: "1.19.0",
      path: ["body-parser", "qs"],
    };
    expect(solve([qs(["6.7.0", "6.7.0"], [chain])], npm, "skip").upgrades.map((u) => u.kind)).toEqual([
      "override",
    ]);
  });

  it("keeps the higher of two upgrades to one package and reports what that leaves open", () => {
    const later = FindingKey.parse("GHSA-later|qs");
    const needsTen: OsvRange[] = [{ type: "SEMVER", events: [{ introduced: "0" }, { fixed: "6.10.0" }] }];
    const result = solve([qs(["6.7.0"], []), qs(["6.7.0"], [], needsTen, later)], new Map(), "skip");
    expect(result.upgrades.map((u) => [u.package, u.to, u.closes])).toEqual([["qs", "6.10.0", [later]]]);
    expect(result.uncovered).toEqual([QS]);
  });

  it("breaks an equal cost per finding by the smaller jump first", () => {
    const minor = { ...express("4.17.1"), chains: [] };
    const patch = qs(["6.7.0"], []);
    expect(solve([minor, patch], new Map(), "skip").upgrades.map((u) => [u.package, u.semverJump])).toEqual([
      ["qs", "patch"],
      ["express", "minor"],
    ]);
  });

  it("breaks an equal cost and jump by package name", () => {
    const minimist: Target = {
      key: FindingKey.parse("GHSA-vh95-rmgr-6w4m|minimist"),
      package: "minimist",
      lockPath: LockPath.parse("node_modules/minimist"),
      version: "1.2.0",
      ranges: rangesFor(vh95, "minimist"),
      parents: ["1.2.0"],
      chains: [],
    };
    expect(
      solve([qs(["6.7.0"], []), minimist], new Map(), "skip").upgrades.map((u) => [u.package, u.semverJump]),
    ).toEqual([
      ["minimist", "patch"],
      ["qs", "patch"],
    ]);
  });

  it("gives the same result for the same input in any order", () => {
    const targets = [qs(["6.7.0"], [viaExpress("4.17.1")]), express("4.17.1")];
    const first = JSON.stringify(solve(targets, npm, "skip"));
    expect(JSON.stringify(solve(targets, npm, "skip"))).toBe(first);
    expect(JSON.stringify(solve([...targets].reverse(), npm, "skip"))).toBe(first);
  });
});

describe("jump", () => {
  it.each([
    ["4.17.1", "4.17.3", "patch"],
    ["4.17.1", "4.19.2", "minor"],
    ["4.17.1", "5.0.0", "major"],
    ["0.2.3", "0.3.0", "major"],
  ])("%s to %s is %s", (from, to, expected) => {
    expect(jump(from, to)).toBe(expected);
  });
});
