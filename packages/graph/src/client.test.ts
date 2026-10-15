import { randomBytes } from "node:crypto";
import { type Db, type G, GraphName, type Params } from "@noderunner/core";
import { FalkorDB } from "falkordb";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { connect } from "./client.ts";
import { query, write } from "./cypher/index.ts";
import { GraphError } from "./errors.ts";

// Integration tests: a real FalkorDB from `docker compose up falkordb`. Graph names are unique per test.
const url = process.env.FALKORDB_URL ?? "redis://localhost:6379";
const never = new AbortController().signal;
const failures: GraphError[] = [];
let db: Db;
const made: G[] = [];

function token(): string {
  const alphabet = "0123456789abcdefghjkmnpqrstvwxyz";
  return [...randomBytes(26)].map((byte) => alphabet[byte % 32]).join("");
}

function scratch(): G {
  const g = db.graph(GraphName.parse(`verify:${token()}`));
  made.push(g);
  return g;
}

const createNode = write("test.createNode", "CREATE (:T {key: $key, n: $n})");
const readNode = query(
  "test.readNode",
  "MATCH (t:T) RETURN t.key AS key, t.n AS n ORDER BY key LIMIT 10",
  z.object({ key: z.string(), n: z.number() }),
);
const readHops = query(
  "test.readHops",
  "MATCH (t:T) RETURN t.key AS key ORDER BY key LIMIT 10",
  z.object({ hops: z.number() }),
);
const countNodes = query("test.countNodes", "MATCH (t:T) RETURN count(t) AS c", z.object({ c: z.number() }));
const mergeRows = write(
  "test.mergeRows",
  "UNWIND $rows AS r MERGE (t:T {key: r.key}) SET t.n = r.n, t.sha = $sha",
);
const broken = write("test.broken", "MATC (t:T) RETURN t");

async function count(g: G): Promise<number> {
  const [row] = await g.query(countNodes, {}, never);
  return row?.c ?? -1;
}

async function failure(work: Promise<unknown>): Promise<GraphError> {
  try {
    await work;
  } catch (error) {
    if (error instanceof GraphError) return error;
    throw error;
  }
  throw new Error("expected a GraphError");
}

function rows(n: number): Params[] {
  return Array.from({ length: n }, (_, i) => ({ key: `k${String(i).padStart(5, "0")}`, n: i }));
}

beforeAll(async () => {
  db = await connect({ url, signal: never, onError: (error) => failures.push(error) });
});

// A dropped graph waits for any read still running on it, such as an abandoned slow read.
afterEach(async () => {
  for (const g of made.splice(0)) await g.drop();
}, 30_000);

afterAll(async () => {
  await db.close();
});

describe("query", () => {
  it("parses rows with the constant's schema", async () => {
    const g = scratch();
    await g.query(createNode, { key: "a", n: 7 }, never);
    expect(await g.query(readNode, {}, never)).toEqual([{ key: "a", n: 7 }]);
  });

  it("raises graph.row when a row does not match its schema", async () => {
    const g = scratch();
    await g.query(createNode, { key: "a", n: 1 }, never);
    const error = await failure(g.query(readHops, {}, never));
    expect(error).toMatchObject({ code: "graph.row", surface: "internal" });
    expect(error.message).toBe("test.readHops: a row did not match its schema");
  });

  it("raises graph.query for rejected text without echoing parameter values", async () => {
    const error = await failure(scratch().query(broken, { key: "secret-value" }, never));
    expect(error).toMatchObject({ code: "graph.query", surface: "internal" });
    expect(error.message).toBe("test.broken: FalkorDB rejected the query");
  });

  it("raises graph.timeout without sending when the signal has already fired", async () => {
    const g = scratch();
    const error = await failure(g.query(createNode, { key: "a", n: 1 }, AbortSignal.abort()));
    expect(error).toMatchObject({ code: "graph.timeout", surface: "upstream" });
    expect(await count(g)).toBe(0);
  });

  it("releases the caller with graph.timeout when the signal fires during a slow read", async () => {
    // The server keeps running the abandoned read to its own TIMEOUT; this one finishes in a few seconds.
    const slow = query(
      "test.slow",
      "UNWIND range(1, 10000000) AS x WITH x WHERE x % 7 = 0 RETURN count(x) AS c",
      z.object({ c: z.number() }),
    );
    const started = Date.now();
    const error = await failure(scratch().query(slow, {}, AbortSignal.timeout(50)));
    expect(error.code).toBe("graph.timeout");
    expect(Date.now() - started).toBeLessThan(1_000);
  }, 30_000);

  it("lets a read run past FalkorDB's 1-second default", async () => {
    const long = query(
      "test.long",
      "UNWIND range(1, 8000000) AS x WITH x WHERE x % 7 = 0 RETURN count(x) AS c",
      z.object({ c: z.number() }),
    );
    expect(await scratch().query(long, {}, never)).toEqual([{ c: 1142857 }]);
  }, 30_000);
});

describe("batch", () => {
  it("writes 1,201 rows in chunks and returns the count", async () => {
    const g = scratch();
    expect(await g.batch(mergeRows, rows(1201), { sha: "s1" }, never)).toBe(1201);
    expect(await count(g)).toBe(1201);
  });

  it("stops between chunks once the signal fires, and a rerun completes", async () => {
    const g = scratch();
    let checks = 0;
    const firesAfterFirstChunk = {
      get aborted() {
        checks += 1;
        return checks > 1;
      },
    } as unknown as AbortSignal;
    const error = await failure(g.batch(mergeRows, rows(1201), { sha: "s1" }, firesAfterFirstChunk));
    expect(error.code).toBe("graph.timeout");
    expect(await count(g)).toBe(500);
    await g.batch(mergeRows, rows(1201), { sha: "s1" }, never);
    expect(await count(g)).toBe(1201);
  });

  it("refuses a shared parameter named rows", async () => {
    const error = await failure(scratch().batch(mergeRows, rows(1), { rows: [] }, never));
    expect(error.code).toBe("graph.query");
  });

  it("returns 0 and writes nothing for no rows", async () => {
    const g = scratch();
    expect(await g.batch(mergeRows, [], { sha: "s1" }, never)).toBe(0);
    expect(await count(g)).toBe(0);
  });
});

describe("roQuery", () => {
  it("returns rows as JSON, with nodes in the client's shape", async () => {
    const g = scratch();
    await g.query(createNode, { key: "a", n: 2 }, never);
    const [row] = await g.roQuery("MATCH (t:T) RETURN t, t.n * $k AS m", { k: 3 }, never);
    expect(row).toMatchObject({ t: { labels: ["T"], properties: { key: "a", n: 2 } }, m: 6 });
  });

  it.each([
    "CREATE (:T {key: 'x', n: 0})",
    "MERGE (:T {key: 'x', n: 0})",
    "MATCH (t:T) SET t.n = 99",
    "MATCH (t:T) DELETE t",
  ])("refuses %s with graph.readonly and writes nothing", async (text) => {
    const g = scratch();
    await g.query(createNode, { key: "a", n: 1 }, never);
    const error = await failure(g.roQuery(text, {}, never));
    expect(error).toMatchObject({ code: "graph.readonly", surface: "invalid" });
    expect(await g.query(readNode, {}, never)).toEqual([{ key: "a", n: 1 }]);
  });

  it("returns FalkorDB's reason for bad text, without the echoed query", async () => {
    const g = scratch();
    await g.query(createNode, { key: "a", n: 1 }, never);
    const error = await failure(g.roQuery("MATC (t) RETURN t", {}, never));
    expect(error).toMatchObject({ code: "graph.query", surface: "invalid" });
    expect(error.message.startsWith("read_only_cypher: Invalid input")).toBe(true);
    expect(error.message.includes("errCtx")).toBe(false);
  });

  it("answers missing for a graph that was never written", async () => {
    const error = await failure(scratch().roQuery("MATCH (t) RETURN count(t) AS c", {}, never));
    expect(error).toMatchObject({ code: "graph.query", surface: "missing" });
    expect(error.message).toBe("read_only_cypher: the graph does not exist yet");
  });
});

describe("drop and list", () => {
  it("drops a verification graph and it leaves the list", async () => {
    const g = db.graph(GraphName.parse(`verify:${token()}`));
    await g.query(createNode, { key: "a", n: 1 }, never);
    expect(await db.list()).toContain(g.name);
    await g.drop();
    expect(await db.list()).not.toContain(g.name);
  });

  it("treats dropping a verification graph that does not exist as done", async () => {
    await expect(db.graph(GraphName.parse(`verify:${token()}`)).drop()).resolves.toBeUndefined();
  });

  it("refuses to drop a repository graph, which stays listed", async () => {
    const name = GraphName.parse(`repo:t03/${token()}`);
    const g = db.graph(name);
    await g.query(createNode, { key: "a", n: 1 }, never);
    try {
      const error = await failure(g.drop());
      expect(error).toMatchObject({ code: "graph.protected", surface: "internal" });
      expect(await db.list()).toContain(name);
    } finally {
      const raw = await FalkorDB.connect({ url });
      await raw.selectGraph(name).delete();
      await raw.close();
    }
  });

  it("lists only names that parse as a graph name", async () => {
    const raw = await FalkorDB.connect({ url });
    const stray = `t03-stray-${token()}`;
    try {
      await raw.selectGraph(stray).query("CREATE (:S)");
      const listed: readonly string[] = await db.list();
      expect(listed).not.toContain(stray);
    } finally {
      await raw.selectGraph(stray).delete();
      await raw.close();
    }
  });
});

describe("connect and close", () => {
  it("raises graph.unavailable when nothing listens", async () => {
    const error = await failure(connect({ url: "redis://127.0.0.1:1", signal: never, onError: () => {} }));
    expect(error).toMatchObject({ code: "graph.unavailable", surface: "upstream" });
  });

  it("closes twice without error, and a later call is graph.unavailable", async () => {
    const own = await connect({ url, signal: never, onError: () => {} });
    await own.close();
    await own.close();
    const error = await failure(own.list());
    expect(error.code).toBe("graph.unavailable");
  });

  it("reports no connection failures during a healthy run", () => {
    expect(failures).toEqual([]);
  });
});
