import { Sha } from "@noderunner/core";
import { describe, expect, it } from "vitest";
import { GitData } from "./github.ts";

const never = new AbortController().signal;
const fork = { owner: "sakibalig", name: "nest" };
const base = Sha.parse("c".repeat(40));
const change = {
  base,
  branch: "noderunner/plan-abc",
  message: "m",
  title: "t",
  body: "b",
  files: [
    { path: "package.json", content: "{}" },
    { path: "package-lock.json", content: "{}" },
  ],
};

type Answer = { status: number; body?: unknown };

/** A scripted GitHub: answers by "METHOD path", and records every call in order. */
function github(answers: Record<string, Answer>) {
  const calls: { key: string; body: unknown }[] = [];
  const fake: typeof fetch = async (input, init) => {
    const path = String(input).replace("https://api.github.com", "");
    const key = `${init?.method ?? "GET"} ${path}`;
    calls.push({ key, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });
    const answer = answers[key] ?? { status: 500 };
    return new Response(answer.body === undefined ? null : JSON.stringify(answer.body), {
      status: answer.status,
    });
  };
  return { calls, forge: new GitData({ token: "t", fetch: fake }) };
}

const repo = "/repos/sakibalig/nest";
const happy: Record<string, Answer> = {
  [`GET ${repo}`]: { status: 200, body: { default_branch: "master" } },
  [`GET ${repo}/git/commits/${base}`]: { status: 200, body: { tree: { sha: "tree0" } } },
  [`POST ${repo}/git/blobs`]: { status: 201, body: { sha: "blob" } },
  [`POST ${repo}/git/trees`]: { status: 201, body: { sha: "tree1" } },
  [`POST ${repo}/git/commits`]: { status: 201, body: { sha: "commit1" } },
  [`POST ${repo}/git/refs`]: { status: 201, body: {} },
  [`POST ${repo}/pulls`]: {
    status: 201,
    body: { html_url: "https://github.com/sakibalig/nest/pull/3", number: 3 },
  },
};

describe("GitData.propose", () => {
  it("writes blobs, a tree on the base, a commit whose only parent is the base, the branch, and the pull request", async () => {
    const { calls, forge } = github(happy);
    expect(await forge.propose(fork, change, never)).toEqual({
      url: "https://github.com/sakibalig/nest/pull/3",
      number: 3,
    });
    expect(calls.map((c) => c.key)).toEqual([
      `GET ${repo}`,
      `GET ${repo}/git/commits/${base}`,
      `POST ${repo}/git/blobs`,
      `POST ${repo}/git/blobs`,
      `POST ${repo}/git/trees`,
      `POST ${repo}/git/commits`,
      `POST ${repo}/git/refs`,
      `POST ${repo}/pulls`,
    ]);
    expect(calls[4]?.body).toMatchObject({ base_tree: "tree0" });
    expect(calls[5]?.body).toEqual({ message: "m", tree: "tree1", parents: [base] });
    expect(calls[7]?.body).toEqual({ title: "t", body: "b", head: "noderunner/plan-abc", base: "master" });
  });

  it("moves an existing branch and reuses an open pull request", async () => {
    const { calls, forge } = github({
      ...happy,
      [`POST ${repo}/git/refs`]: { status: 422 },
      [`PATCH ${repo}/git/refs/heads/noderunner/plan-abc`]: { status: 200, body: {} },
      [`POST ${repo}/pulls`]: { status: 422 },
      [`GET ${repo}/pulls?state=open&head=sakibalig:noderunner/plan-abc`]: {
        status: 200,
        body: [{ html_url: "https://github.com/sakibalig/nest/pull/2", number: 2 }],
      },
    });
    expect((await forge.propose(fork, change, never)).number).toBe(2);
    expect(calls.find((c) => c.key.startsWith("PATCH"))?.body).toEqual({ sha: "commit1", force: true });
  });

  it.each([
    ["a missing fork", { [`GET ${repo}`]: { status: 404 } }, "fork the repository first"],
    [
      "a fork without the base commit",
      { [`GET ${repo}/git/commits/${base}`]: { status: 404 } },
      "sync the fork",
    ],
    ["a token without write access", { [`POST ${repo}/git/blobs`]: { status: 403 } }, "write access"],
  ])("explains %s", async (_, override, message) => {
    const { forge } = github({ ...happy, ...override });
    await expect(forge.propose(fork, change, never)).rejects.toThrow(message);
  });
});

describe("GitData.read", () => {
  it("reads a file at a commit, and null when absent", async () => {
    const { forge } = github({
      [`GET /repos/nestjs/nest/contents/package.json?ref=${base}`]: { status: 200, body: { name: "nest" } },
      [`GET /repos/nestjs/nest/contents/.npmrc?ref=${base}`]: { status: 404 },
    });
    expect(await forge.read({ owner: "nestjs", name: "nest" }, base, "package.json", never)).toBe(
      '{"name":"nest"}',
    );
    expect(await forge.read({ owner: "nestjs", name: "nest" }, base, ".npmrc", never)).toBeNull();
  });
});
