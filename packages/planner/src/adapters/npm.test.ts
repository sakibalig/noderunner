import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PlannerError } from "../errors.ts";
import { npm } from "./npm.ts";

const never = new AbortController().signal;
const qs = readFileSync(join(import.meta.dirname, "../../../../fixtures/npm/qs.json"), "utf8");
const dirs: string[] = [];
const servers: Server[] = [];

async function serve(): Promise<{ url: string; hits: string[]; server: Server }> {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    hits.push(`${req.url} ${req.headers.accept}`);
    if (req.url === "/qs") {
      res.writeHead(200, { "Content-Type": "application/json" }).end(qs);
    } else res.writeHead(404).end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, hits, server };
}

function dir(): string {
  const path = mkdtempSync(join(tmpdir(), "noderunner-npm-"));
  dirs.push(path);
  return path;
}

afterEach(() => {
  for (const s of servers.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("npm", () => {
  it("asks for the abbreviated packument and merges each version's dependencies", async () => {
    const { url, hits } = await serve();
    const packument = await npm({ dir: dir(), clock: { now: () => 0 }, registry: url }).packument(
      "qs",
      never,
    );
    expect(hits).toEqual(["/qs application/vnd.npm.install-v1+json"]);
    expect(packument?.name).toBe("qs");
    expect(Object.keys(packument?.versions ?? {})).toContain("6.7.0");
  });

  it("answers null for a 404", async () => {
    const { url } = await serve();
    expect(
      await npm({ dir: dir(), clock: { now: () => 0 }, registry: url }).packument("nope", never),
    ).toBeNull();
  });

  it("answers from disk with the server stopped, fresh or stale", async () => {
    const cache = dir();
    const { url, server } = await serve();
    await npm({ dir: cache, clock: { now: () => 0 }, registry: url }).packument("qs", never);
    server.close();
    const fresh = npm({ dir: cache, clock: { now: () => 1000 }, registry: url });
    expect((await fresh.packument("qs", never))?.name).toBe("qs");
    const stale = npm({ dir: cache, clock: { now: () => 2 * 24 * 60 * 60 * 1000 }, registry: url });
    expect((await stale.packument("qs", never))?.name).toBe("qs");
  });

  it("fails registry.upstream when the server is down and nothing is cached", async () => {
    const { url, server } = await serve();
    server.close();
    await expect(
      npm({ dir: dir(), clock: { now: () => 0 }, registry: url }).packument("qs", never),
    ).rejects.toBeInstanceOf(PlannerError);
  });
});
