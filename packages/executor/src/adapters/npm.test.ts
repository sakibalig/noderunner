import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { commands, Npm } from "./npm.ts";

const never = new AbortController().signal;
const files = {
  manifest: '{ "name": "app" }',
  lock: '{ "lockfileVersion": 3, "packages": {} }',
  workspaces: [{ path: "packages/a", manifest: '{ "name": "a" }' }],
};

/** A stand-in npm that logs each call and rewrites the lockfile; `mode` picks how it misbehaves. */
function fake(mode: "ok" | "strict" | "fail" | "hang") {
  const dir = mkdtempSync(join(tmpdir(), "noderunner-fake-"));
  const log = join(dir, "calls.jsonl");
  const bin = join(dir, "npm");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({
  args, cwd: process.cwd(), env: Object.keys(process.env).sort(),
  workspace: fs.existsSync("packages/a/package.json"),
}) + "\\n");
const mode = ${JSON.stringify(mode)};
if (mode === "hang") setInterval(() => {}, 1000);
else if (mode === "fail") process.exit(3);
else if (mode === "strict" && !args.includes("--legacy-peer-deps")) process.exit(1);
else fs.writeFileSync("package-lock.json", JSON.stringify({ lockfileVersion: 3, packages: {}, by: args[0] }));
`,
  );
  chmodSync(bin, 0o755);
  const calls = () =>
    readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { args: string[]; cwd: string; env: string[]; workspace: boolean });
  return { npm: (ms?: number) => new Npm({ cache: join(dir, "cache"), bin, ...(ms ? { ms } : {}) }), calls };
}

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

describe("Npm.regenerate", () => {
  it("runs npm in a folder with the manifests, passes no other environment, and removes the folder", async () => {
    const { npm, calls } = fake("ok");
    const { lock } = await npm().regenerate(files, ["qs"], never);
    expect(JSON.parse(lock).by).toBe("update");
    const seen = calls();
    expect(seen.map((c) => c.args[0])).toEqual(["install", "update"]);
    expect(
      seen[0]?.env.filter((k) => !k.startsWith("__CF") && k !== "PWD" && k !== "SHLVL" && k !== "_"),
    ).toEqual(["HOME", "PATH", "npm_config_cache", "npm_config_update_notifier"]);
    expect(seen.every((c) => c.workspace)).toBe(true);
    expect(existsSync(seen[0]?.cwd ?? "")).toBe(false);
  });

  it("retries both commands with --legacy-peer-deps when strict resolution fails", async () => {
    const { npm, calls } = fake("strict");
    await npm().regenerate(files, ["qs"], never);
    expect(calls().map((c) => c.args.includes("--legacy-peer-deps"))).toEqual([false, true, true]);
  });

  it("fails with the exit code and removes the folder", async () => {
    const { npm, calls } = fake("fail");
    await expect(npm().regenerate(files, [], never)).rejects.toThrow("npm install exited with code 3");
    expect(existsSync(calls()[0]?.cwd ?? "")).toBe(false);
  });

  it("kills npm when it runs past the limit, and removes the folder after it exits", async () => {
    const { npm, calls } = fake("hang");
    const started = Date.now();
    await expect(npm(2_000).regenerate(files, [], never)).rejects.toThrow("npm took longer than 2 s");
    expect(Date.now() - started).toBeLessThan(8_000);
    expect(existsSync(calls()[0]?.cwd ?? "")).toBe(false);
  });

  it("refuses a workspace path that leaves the folder", async () => {
    const { npm } = fake("ok");
    await expect(
      npm().regenerate({ ...files, workspaces: [{ path: "../escape", manifest: "{}" }] }, [], never),
    ).rejects.toMatchObject({ surface: "unsupported" });
  });
});
