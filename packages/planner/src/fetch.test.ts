import { FindingKey, LockPath, type Packument, type Registry } from "@noderunner/core";
import { describe, expect, it } from "vitest";
import { BUDGET, prefetch } from "./fetch.ts";
import type { Target } from "./solve/candidates.ts";

const never = new AbortController().signal;

function target(key: string, names: string[]): Target {
  return {
    key: FindingKey.parse(key),
    package: names[names.length - 1] ?? "x",
    lockPath: LockPath.parse(`node_modules/${names[names.length - 1] ?? "x"}`),
    version: "1.0.0",
    ranges: [],
    parents: ["1.0.0"],
    chains: [{ direct: names[0] ?? "x", version: "1.0.0", range: "^1.0.0", path: names }],
  };
}

function counting(fail: Set<string> = new Set()) {
  const asked: string[] = [];
  const registry: Registry = {
    async packument(name) {
      asked.push(name);
      if (fail.has(name)) throw new Error("down");
      return name === "missing" ? null : ({ name, versions: {} } satisfies Packument);
    },
  };
  return { asked, registry };
}

describe("prefetch", () => {
  it("fetches each name once across findings", async () => {
    const { asked, registry } = counting();
    await prefetch([target("A|b", ["a", "b"]), target("B|b", ["a", "b"])], registry, never);
    expect(asked).toEqual(["b", "a"]);
  });

  it("records names the registry cannot give and carries on", async () => {
    const { registry } = counting(new Set(["a"]));
    const result = await prefetch([target("A|c", ["a", "missing", "c"])], registry, never);
    expect(result.unavailable).toEqual(["a", "missing"]);
    expect([...result.packuments.keys()]).toEqual(["c"]);
  });

  it("stops a finding at its budget of new fetches", async () => {
    const { asked, registry } = counting();
    const names = Array.from({ length: BUDGET.finding + 1 }, (_, i) => `p${i}`);
    await prefetch([target("A|p60", names)], registry, never);
    expect(asked).toHaveLength(BUDGET.finding);
  });
});
