import type { Db, G } from "@noderunner/core";
import { connect } from "@noderunner/graph";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createToolbox } from "../call.ts";
import { ids, manual, packuments, seeded, silent } from "../fixture.ts";
import { createTools } from "../registry.ts";
import { glob } from "./files.ts";
import { MATCHES } from "./search.ts";

const url = process.env.FALKORDB_URL ?? "redis://localhost:6379";
const never = new AbortController().signal;
let db: Db;
const made: G[] = [];

const files = new Map<string, string>([
  ["src/server.ts", 'import express from "express";\nconst re = /.*/;\n'],
  ["src/util.ts", 'import leftPad from "left-pad";\n'],
  ["test/app.test.ts", 'import express from "express";\n'],
  ["src/long.ts", Array.from({ length: 450 }, (_, i) => `line ${i} hit`).join("\n")],
]);

async function setup() {
  const { ctx } = await seeded(db, made);
  const clock = manual();
  const tools = createTools({ db, clock, ids, registry: packuments(), files: async () => files });
  const box = createToolbox({ db, clock, ids, tools }, { access: ["read", "derive", "act"] });
  const call = (tool: string, input: unknown, actor: "baseline" | "triage" = "baseline") =>
    box.callTool(tool, input, { ...ctx, actor }, silent);
  return { call };
}

beforeAll(async () => {
  db = await connect({ url, signal: never, onError: () => {} });
});
afterEach(async () => {
  for (const g of made.splice(0)) await g.drop().catch(() => undefined);
});
afterAll(async () => {
  await db.close();
});

describe("glob", () => {
  it.each([
    ["src/**/*.ts", "src/a/b.ts", true],
    ["src/**/*.ts", "src/b.ts", true],
    ["src/*.ts", "src/a/b.ts", false],
    ["*.ts", "a.ts", true],
    ["a.(b)", "a.(b)", true],
    ["a.(b)", "axb", false],
  ])("%s matches %s: %s", (pattern, path, want) => {
    expect(glob(pattern).test(path)).toBe(want);
  });
});

describe("search_files", () => {
  it("finds a literal substring, so .* matches only the text .*", async () => {
    const { call } = await setup();
    const result = await call("search_files", { text: ".*" });
    expect(result).toMatchObject({
      ok: true,
      data: {
        matches: [{ path: "src/server.ts", line: 2, excerpt: { quoted: "const re = /.*/;" } }],
        truncated: false,
      },
    });
  });

  it("filters by glob", async () => {
    const { call } = await setup();
    const result = await call("search_files", { text: "express", glob: "src/**" });
    expect(result.ok && (result.data as { matches: { path: string }[] }).matches.map((m) => m.path)).toEqual([
      "src/server.ts",
    ]);
  });

  it(`stops at ${MATCHES} matches and says so`, async () => {
    const { call } = await setup();
    const result = await call("search_files", { text: "hit" });
    expect(result).toMatchObject({ ok: true, data: { truncated: true } });
    expect(result.ok && (result.data as { matches: unknown[] }).matches).toHaveLength(MATCHES);
  });

  it("is not offered to the triage agent", async () => {
    const { call } = await setup();
    expect((await call("search_files", { text: "x" }, "triage")).ok).toBe(false);
  });
});

describe("read_file", () => {
  it("returns 400 lines from the offset, never line 401", async () => {
    const { call } = await setup();
    const result = await call("read_file", { path: "src/long.ts" });
    const data = result.ok ? (result.data as { lines: { quoted: string }; truncated: boolean }) : null;
    const lines = data?.lines.quoted.split("\n") ?? [];
    expect([lines.length, lines.at(-1), data?.truncated]).toEqual([400, "line 399 hit", true]);
    const rest = await call("read_file", { path: "src/long.ts", offset: 400 });
    expect(rest).toMatchObject({ ok: true, data: { offset: 400, truncated: false } });
  });

  it("refuses a path outside the fetched files", async () => {
    const { call } = await setup();
    expect(await call("read_file", { path: "../../etc/passwd" })).toMatchObject({ ok: false });
  });
});
