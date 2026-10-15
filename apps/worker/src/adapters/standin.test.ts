import type { RunEvent } from "@noderunner/core";
import { describe, expect, it } from "vitest";
import { Standin } from "./standin.ts";

describe("Standin", () => {
  it("emits the six stages, then lists and summarises the repository", async () => {
    const standin = new Standin({ now: () => 42 }, 0);
    const seen: RunEvent[] = [];
    const repo = { owner: "acme", name: "api" };
    const report = await standin.ingest(repo, {
      onProgress: (event) => seen.push(event),
      signal: new AbortController().signal,
    });
    expect(seen.map((event) => (event.type === "ingest.progress" ? event.stage : ""))).toEqual([
      "fetch",
      "lockfile",
      "imports",
      "advisories",
      "people",
      "prune",
    ]);
    expect(report.graph).toBe("repo:acme/api");
    expect((await standin.list()).map((entry) => [entry.repoId, entry.ingestedAt])).toEqual([
      ["acme/api", 42],
    ]);
    expect(await standin.summary({ owner: "acme", name: "other" })).toBeNull();
  });

  it("stops when aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const standin = new Standin({ now: () => 0 }, 0);
    await expect(
      standin.ingest({ owner: "a", name: "b" }, { onProgress: () => {}, signal: controller.signal }),
    ).rejects.toThrow();
  });
});

describe("Standin demo repository", () => {
  it("serves acme/api with its funnel and filtered findings before anything is ingested", async () => {
    const standin = new Standin({ now: () => 0 }, 0);
    const repo = { owner: "acme", name: "api" };
    expect((await standin.list()).map((entry) => entry.repoId)).toEqual(["acme/api"]);
    expect((await standin.summary(repo))?.funnel).toEqual({ total: 3, production: 2, reachable: 1, open: 1 });
    expect((await standin.findings(repo, { tier: "import-reachable" }))?.map((f) => f.package)).toEqual([
      "qs",
    ]);
    expect(await standin.findings({ owner: "acme", name: "none" }, {})).toBeNull();
  });
});
