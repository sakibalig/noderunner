import { describe, expect, it } from "vitest";
import { commands } from "./npm.ts";

describe("npm commands", () => {
  it("installs lockfile-only without scripts, then updates the refresh names as positional arguments", () => {
    expect(commands(["qs", "@types/node"], "strict")).toEqual([
      ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"],
      [
        "update",
        "--package-lock-only",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--",
        "qs",
        "@types/node",
      ],
    ]);
  });

  it("only installs when nothing is refreshed, and adds --legacy-peer-deps to both steps for a legacy lockfile", () => {
    expect(commands([], "strict")).toHaveLength(1);
    expect(commands(["qs"], "legacy").every((args) => args.includes("--legacy-peer-deps"))).toBe(true);
  });

  it.each(["x; rm -rf /", "$(whoami)", "--registry=http://evil", "../up"])(
    "refuses %j before running",
    (name) => {
      expect(() => commands([name], "strict")).toThrow(expect.objectContaining({ code: "executor.sandbox" }));
    },
  );
});
