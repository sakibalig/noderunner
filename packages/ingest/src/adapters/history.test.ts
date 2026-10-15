import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Sha } from "@noderunner/core";
import { afterAll, describe, expect, it } from "vitest";
import { GitHistory, HistoryError, parseLog } from "./history.ts";

const never = new AbortController().signal;
const dir = mkdtempSync(join(tmpdir(), "noderunner-origin-"));
const git = (...args: string[]) =>
  execFileSync("git", ["-C", dir, ...args], {
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: "2026-10-01T10:00:00Z",
      GIT_COMMITTER_DATE: "2026-10-01T10:00:00Z",
    },
  })
    .toString()
    .trim();

git("init", "--quiet", "--initial-branch=main");
git("config", "user.email", "alice@example.com");
git("config", "user.name", "Alice A");
mkdirSync(join(dir, "src"));
writeFileSync(join(dir, "src/a.ts"), "export const a = 1;\n");
git("add", ".");
git("commit", "--quiet", "-m", "first");
const first = git("rev-parse", "HEAD");
writeFileSync(join(dir, "src/a.ts"), "export const a = 2;\n");
writeFileSync(join(dir, "src/b.ts"), "export const b = 1;\n");
git("add", ".");
git("commit", "--quiet", "-m", "second");
const second = git("rev-parse", "HEAD");
writeFileSync(join(dir, "src/c.ts"), "export const c = 1;\n");
git("add", ".");
git("commit", "--quiet", "-m", "third");
const third = git("rev-parse", "HEAD");

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const logins = (map: Record<string, string>): typeof fetch =>
  (async () =>
    Response.json(Object.entries(map).map(([sha, login]) => ({ sha, author: { login } })))) as typeof fetch;

describe("GitHistory", () => {
  it("reads commits with their files and fills logins from the commit list", async () => {
    const history = new GitHistory({ cloneUrl: () => `file://${dir}`, fetch: logins({ [second]: "alice" }) });
    const commits = await history.history({ owner: "acme", name: "api" }, Sha.parse(second), 200, never);
    expect(commits.map((c) => [c.sha, c.login, c.name, c.files])).toEqual([
      [second, "alice", "Alice A", ["src/a.ts", "src/b.ts"]],
      [first, null, "Alice A", ["src/a.ts"]],
    ]);
    expect(commits[0]?.at).toBe(Date.parse("2026-10-01T10:00:00Z"));
  });

  it("drops the shallow boundary commit, which would otherwise list every file", async () => {
    const history = new GitHistory({ cloneUrl: () => `file://${dir}`, fetch: logins({}) });
    const commits = await history.history({ owner: "acme", name: "api" }, Sha.parse(third), 1, never);
    expect(commits.map((c) => [c.sha, c.files])).toEqual([[third, ["src/c.ts"]]]);
  });

  it("raises HistoryError, an upstream fault, when the commit cannot be fetched", async () => {
    const history = new GitHistory({ cloneUrl: () => `file://${dir}-missing`, fetch: logins({}) });
    const failure = history.history({ owner: "acme", name: "api" }, Sha.parse(second), 200, never);
    await expect(failure).rejects.toBeInstanceOf(HistoryError);
    await expect(failure).rejects.toMatchObject({ surface: "upstream" });
  });

  it("raises HistoryError when GitHub refuses the commit list", async () => {
    const refused = (async () => new Response("", { status: 403 })) as typeof fetch;
    const history = new GitHistory({ cloneUrl: () => `file://${dir}`, fetch: refused });
    await expect(
      history.history({ owner: "acme", name: "api" }, Sha.parse(second), 200, never),
    ).rejects.toBeInstanceOf(HistoryError);
  });
});

describe("parseLog", () => {
  it("returns nothing for empty output", () => {
    expect(parseLog("")).toEqual([]);
  });
});
