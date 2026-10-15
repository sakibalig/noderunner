import { randomBytes } from "node:crypto";
import { type Commit, type Db, type G, GraphName, Sha } from "@noderunner/core";
import { connect } from "@noderunner/graph";
import { query, write } from "@noderunner/graph/cypher";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { people, tally } from "./people.ts";

const sha = Sha.parse("a".repeat(40));
const commit = (login: string | null, at: number, files: string[], name = "Someone"): Commit => ({
  sha: Sha.parse(randomBytes(20).toString("hex")),
  login,
  name,
  at,
  files,
});

describe("tally", () => {
  const files = new Set(["src/a.ts", "src/b.ts"]);

  it("counts commits per person per file and keeps the latest time", () => {
    const rows = tally(
      [commit("Alice", 1, ["src/a.ts"]), commit("alice", 5, ["src/a.ts", "src/b.ts"])],
      files,
    );
    expect(rows).toEqual([
      { handle: "@alice", name: "Someone", path: "src/a.ts", commits: 2, last_at: 5 },
      { handle: "@alice", name: "Someone", path: "src/b.ts", commits: 1, last_at: 5 },
    ]);
  });

  it("drops bots, commits without a login, and paths that are not source files", () => {
    const rows = tally(
      [
        commit("dependabot[bot]", 1, ["src/a.ts"]),
        commit("renovate-bot", 1, ["src/a.ts"]),
        commit(null, 1, ["src/a.ts"]),
        commit("bob", 1, ["README.md"]),
      ],
      files,
    );
    expect(rows).toEqual([]);
  });
});

// Integration: a real FalkorDB from `docker compose up falkordb`.
const never = new AbortController().signal;
let db: Db;
const made: G[] = [];

function scratch(): G {
  const alphabet = "0123456789abcdefghjkmnpqrstvwxyz";
  const id = [...randomBytes(26)].map((byte) => alphabet[byte % 32]).join("");
  const g = db.graph(GraphName.parse(`verify:${id}`));
  made.push(g);
  return g;
}

const seedFiles = write("test.files", "UNWIND $rows AS r CREATE (:File {path: r.path})");
const edges = query(
  "test.edges",
  `MATCH (p:Person)-[e]->(f:File)
RETURN p.handle AS handle, p.kind AS kind, type(e) AS type, f.path AS path, e.commits AS commits
ORDER BY handle, type, path LIMIT 100`,
  z.object({
    handle: z.string(),
    kind: z.string(),
    type: z.string(),
    path: z.string(),
    commits: z.number().nullable(),
  }),
);

beforeAll(async () => {
  db = await connect({
    url: process.env.FALKORDB_URL ?? "redis://localhost:6379",
    signal: never,
    onError: () => {},
  });
});
afterAll(async () => {
  for (const g of made) await g.drop();
  await db.close();
});

const files = ["src/api/server.ts", "src/util.ts"];
const codeowners = "* @acme/core\n/src/api/ @bob\n";
const repo = { owner: "acme", name: "api" };

async function seeded(): Promise<G> {
  const g = scratch();
  await g.batch(
    seedFiles,
    files.map((path) => ({ path })),
    {},
    never,
  );
  return g;
}

describe("people stage", () => {
  it("writes OWNS from CODEOWNERS and CHANGED from history", async () => {
    const g = await seeded();
    const forge = { history: async () => [commit("Bob", 7, ["src/api/server.ts"], "Bob B")] };
    const result = await people({ g, repo, sha, files, codeowners }, { forge }, never);
    expect(result).toEqual({ people: 2, warnings: [] });
    expect(await g.query(edges, {}, never)).toEqual([
      { handle: "@acme/core", kind: "team", type: "OWNS", path: "src/util.ts", commits: null },
      { handle: "@bob", kind: "user", type: "CHANGED", path: "src/api/server.ts", commits: 1 },
      { handle: "@bob", kind: "user", type: "OWNS", path: "src/api/server.ts", commits: null },
    ]);
  });

  it("replaces the previous edges on a second run", async () => {
    const g = await seeded();
    const forge = { history: async () => [commit("bob", 1, ["src/util.ts"])] };
    await people({ g, repo, sha, files, codeowners }, { forge }, never);
    await people({ g, repo, sha, files, codeowners: "* @carol\n" }, { forge }, never);
    const rows = await g.query(edges, {}, never);
    expect(rows.filter((row) => row.type === "OWNS").map((row) => [row.handle, row.path])).toEqual([
      ["@carol", "src/api/server.ts"],
      ["@carol", "src/util.ts"],
    ]);
    expect(rows.filter((row) => row.type === "CHANGED")).toHaveLength(1);
  });

  it("keeps the previous CHANGED edges and warns once when history fails, still writing OWNS", async () => {
    const g = await seeded();
    const ok = { history: async () => [commit("bob", 1, ["src/util.ts"])] };
    await people({ g, repo, sha, files, codeowners }, { forge: ok }, never);
    const broken = {
      history: async (): Promise<Commit[]> => {
        throw new Error("network down");
      },
    };
    const result = await people({ g, repo, sha, files, codeowners: "* @carol\n" }, { forge: broken }, never);
    expect(result.warnings).toEqual([{ code: "people", count: 1, sample: ["Error"] }]);
    const rows = await g.query(edges, {}, never);
    expect(rows.filter((row) => row.type === "CHANGED").map((row) => row.handle)).toEqual(["@bob"]);
    expect(new Set(rows.filter((row) => row.type === "OWNS").map((row) => row.handle))).toEqual(
      new Set(["@carol"]),
    );
  });

  it("writes no OWNS without a CODEOWNERS file and warns about e-mail owners", async () => {
    const g = await seeded();
    const forge = { history: async () => [] };
    expect((await people({ g, repo, sha, files, codeowners: null }, { forge }, never)).people).toBe(0);
    const warned = await people({ g, repo, sha, files, codeowners: "* ops@acme.dev\n" }, { forge }, never);
    expect(warned.warnings).toEqual([{ code: "people", count: 1, sample: ["ops@acme.dev"] }]);
    expect(await g.query(edges, {}, never)).toEqual([]);
  });
});
