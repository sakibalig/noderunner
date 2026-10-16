import { Sha } from "@noderunner/core";
import { describe, expect, it } from "vitest";
import { IngestError } from "../errors.ts";
import { GitHub } from "./github.ts";

const sha = "d".repeat(40);
const repo = { owner: "acme", name: "api" };
const never = new AbortController().signal;

type Answer = Response | Error;

/** A fetch double that answers in order and records each request's URL and headers. */
function fake(answers: Answer[]) {
  const seen: { url: string; headers: Record<string, string> }[] = [];
  const impl: typeof fetch = async (input, init) => {
    seen.push({ url: String(input), headers: (init?.headers ?? {}) as Record<string, string> });
    const next = answers.shift();
    if (next === undefined) throw new Error("no more answers");
    if (next instanceof Error) throw next;
    return next;
  };
  return { impl, seen };
}

async function failure(work: Promise<unknown>): Promise<IngestError> {
  try {
    await work;
  } catch (error) {
    if (error instanceof IngestError) return error;
    throw error;
  }
  throw new Error("expected an IngestError");
}

async function collect(chunks: AsyncIterable<Uint8Array>): Promise<string> {
  const parts: Uint8Array[] = [];
  for await (const chunk of chunks) parts.push(chunk);
  return Buffer.concat(parts).toString("utf8");
}

describe("GitHub.head", () => {
  it("reads the default branch and then its commit, sending the token", async () => {
    const { impl, seen } = fake([
      Response.json({ default_branch: "trunk", private: false }),
      new Response(`${sha}\n`),
    ]);
    const head = await new GitHub({ token: "t0ken", fetch: impl, retryMs: 0 }).head(repo, never);
    expect(head).toEqual({ branch: "trunk", sha: Sha.parse(sha) });
    expect(seen.map((s) => s.url)).toEqual([
      "https://api.github.com/repos/acme/api",
      "https://api.github.com/repos/acme/api/commits/trunk",
    ]);
    expect(seen[0]?.headers.Authorization).toBe("Bearer t0ken");
    expect(seen[1]?.headers.Accept).toBe("application/vnd.github.sha");
  });

  it("sends no Authorization header without a token", async () => {
    const { impl, seen } = fake([Response.json({ default_branch: "main" }), new Response(sha)]);
    await new GitHub({ fetch: impl, retryMs: 0 }).head(repo, never);
    expect(seen[0]?.headers.Authorization).toBeUndefined();
  });

  it("answers ingest.missing for a 404", async () => {
    const { impl } = fake([new Response("", { status: 404 })]);
    const error = await failure(new GitHub({ fetch: impl, retryMs: 0 }).head(repo, never));
    expect(error).toMatchObject({ code: "ingest.missing", surface: "missing" });
  });

  it("retries a 502 and a network error, then succeeds", async () => {
    const { impl, seen } = fake([
      new Response("", { status: 502 }),
      new TypeError("fetch failed"),
      Response.json({ default_branch: "main" }),
      new Response(sha),
    ]);
    expect((await new GitHub({ fetch: impl, retryMs: 0 }).head(repo, never)).sha).toBe(sha);
    expect(seen).toHaveLength(4);
  });

  it("gives up with ingest.upstream after three 5xx answers", async () => {
    const { impl, seen } = fake([
      new Response("", { status: 500 }),
      new Response("", { status: 503 }),
      new Response("", { status: 500 }),
    ]);
    const error = await failure(new GitHub({ fetch: impl, retryMs: 0 }).head(repo, never));
    expect(error).toMatchObject({ code: "ingest.upstream", message: "GitHub answered 500 after 3 attempts" });
    expect(seen).toHaveLength(3);
  });

  it("does not retry a 403 and never puts the token in the message", async () => {
    const { impl, seen } = fake([new Response("rate limited", { status: 403 })]);
    const error = await failure(new GitHub({ token: "t0ken", fetch: impl, retryMs: 0 }).head(repo, never));
    expect(error.code).toBe("ingest.upstream");
    expect(error.message).not.toContain("t0ken");
    expect(seen).toHaveLength(1);
  });

  it("answers ingest.upstream for a body without a default branch, or a commit id that is not a sha", async () => {
    const first = fake([Response.json({ name: "api" })]);
    expect((await failure(new GitHub({ fetch: first.impl, retryMs: 0 }).head(repo, never))).code).toBe(
      "ingest.upstream",
    );
    const second = fake([Response.json({ default_branch: "main" }), new Response("not-a-sha")]);
    expect((await failure(new GitHub({ fetch: second.impl, retryMs: 0 }).head(repo, never))).code).toBe(
      "ingest.upstream",
    );
  });

  it("answers ingest.aborted when the signal fires", async () => {
    const controller = new AbortController();
    const impl: typeof fetch = async () => {
      controller.abort();
      throw new DOMException("aborted", "AbortError");
    };
    const error = await failure(new GitHub({ fetch: impl, retryMs: 0 }).head(repo, controller.signal));
    expect(error.code).toBe("ingest.aborted");
  });
});

describe("GitHub.tarball", () => {
  it("streams the archive of the commit", async () => {
    const { impl, seen } = fake([new Response("archive-bytes")]);
    const text = await collect(new GitHub({ fetch: impl, retryMs: 0 }).tarball(repo, Sha.parse(sha), never));
    expect(text).toBe("archive-bytes");
    expect(seen[0]?.url).toBe(`https://api.github.com/repos/acme/api/tarball/${sha}`);
  });

  it("answers ingest.missing when the commit does not exist", async () => {
    const { impl } = fake([new Response("", { status: 404 })]);
    const error = await failure(
      collect(new GitHub({ fetch: impl, retryMs: 0 }).tarball(repo, Sha.parse(sha), never)),
    );
    expect(error.code).toBe("ingest.missing");
  });
});
