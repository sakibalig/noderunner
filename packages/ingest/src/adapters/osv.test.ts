import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { IngestError } from "../errors.ts";
import { OSV, OSV_BATCH } from "./osv.ts";

const fixtures = join(import.meta.dirname, "../../../../fixtures/osv");
const fixture = (name: string): unknown => JSON.parse(readFileSync(join(fixtures, name), "utf8"));
const never = new AbortController().signal;

type Seen = { url: string; body: { queries: { version: string; page_token?: string }[] } | null };

function fake(answer: (seen: Seen, call: number) => Response | Error) {
  const seen: Seen[] = [];
  const impl: typeof fetch = async (input, init) => {
    const entry: Seen = {
      url: String(input),
      body: typeof init?.body === "string" ? (JSON.parse(init.body) as Seen["body"]) : null,
    };
    seen.push(entry);
    const out = answer(entry, seen.length);
    if (out instanceof Error) throw out;
    return out;
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

describe("OSV.query", () => {
  it("maps the recorded batch answer back to each pair, with modified times in milliseconds", async () => {
    const { impl, seen } = fake(() => Response.json(fixture("querybatch.json")));
    const pairs = [
      { name: "qs", version: "6.7.0" },
      { name: "lodash", version: "4.17.15" },
      { name: "minimist", version: "1.2.0" },
      { name: "express", version: "4.17.1" },
      { name: "left-pad", version: "1.3.0" },
    ];
    const hits = await new OSV({ fetch: impl, retryMs: 0 }).query(pairs, never);
    expect(hits.map((list) => list.length)).toEqual([4, 6, 2, 2, 0]);
    expect(hits[3]?.map((hit) => hit.id)).toEqual(["GHSA-qw6h-vgh9-j6wx", "GHSA-rv95-896h-c2vc"]);
    expect(Number.isInteger(hits[0]?.[0]?.modified)).toBe(true);
    expect(seen[0]?.url).toBe("https://api.osv.dev/v1/querybatch");
    expect(seen[0]?.body?.queries[0]).toEqual({
      package: { name: "qs", ecosystem: "npm" },
      version: "6.7.0",
    });
  });

  it("splits more than 1,000 pairs into batches of at most 1,000", async () => {
    const { impl, seen } = fake((entry) =>
      Response.json({
        results: (entry.body?.queries ?? []).map((q) => ({
          vulns: [{ id: `ID-${q.version}`, modified: "2026-01-01T00:00:00Z" }],
        })),
      }),
    );
    const pairs = Array.from({ length: OSV_BATCH + 1 }, (_, i) => ({ name: "p", version: `1.0.${i}` }));
    const hits = await new OSV({ fetch: impl, retryMs: 0 }).query(pairs, never);
    expect(seen.map((s) => s.body?.queries.length)).toEqual([1000, 1]);
    expect(hits[OSV_BATCH]?.[0]?.id).toBe(`ID-1.0.${OSV_BATCH}`);
  });

  it("follows next_page_token for a query with more results", async () => {
    const { impl, seen } = fake((_, call) =>
      call === 1
        ? Response.json({
            results: [
              { vulns: [{ id: "A", modified: "2026-01-01T00:00:00Z" }], next_page_token: "tok" },
              { vulns: [{ id: "C", modified: "2026-01-01T00:00:00Z" }] },
            ],
          })
        : Response.json({ results: [{ vulns: [{ id: "B", modified: "2026-01-01T00:00:00Z" }] }] }),
    );
    const hits = await new OSV({ fetch: impl, retryMs: 0 }).query(
      [
        { name: "x", version: "1.0.0" },
        { name: "y", version: "1.0.0" },
      ],
      never,
    );
    expect(hits.map((list) => list.map((hit) => hit.id))).toEqual([["A", "B"], ["C"]]);
    expect(seen[1]?.body?.queries).toEqual([
      { package: { name: "x", ecosystem: "npm" }, version: "1.0.0", page_token: "tok" },
    ]);
  });

  it("retries a 503 and fails ingest.upstream on a 400 without retrying", async () => {
    let calls = 0;
    const retried = fake(() => {
      calls += 1;
      return calls === 1 ? new Response("", { status: 503 }) : Response.json({ results: [{}] });
    });
    expect(
      await new OSV({ fetch: retried.impl, retryMs: 0 }).query([{ name: "x", version: "1" }], never),
    ).toEqual([[]]);
    const refused = fake(() => Response.json({ code: 3, message: "too many queries" }, { status: 400 }));
    const error = await failure(
      new OSV({ fetch: refused.impl, retryMs: 0 }).query([{ name: "x", version: "1" }], never),
    );
    expect(error).toMatchObject({ code: "ingest.upstream", message: "OSV refused the request (400)" });
    expect(refused.seen).toHaveLength(1);
  });

  it("fails ingest.upstream when the answer has the wrong number of results", async () => {
    const { impl } = fake(() => Response.json({ results: [] }));
    const error = await failure(
      new OSV({ fetch: impl, retryMs: 0 }).query([{ name: "x", version: "1" }], never),
    );
    expect(error.code).toBe("ingest.upstream");
  });
});

describe("OSV.record", () => {
  it("parses a recorded advisory", async () => {
    const { impl, seen } = fake(() => Response.json(fixture("GHSA-rv95-896h-c2vc.json")));
    const record = await new OSV({ fetch: impl, retryMs: 0 }).record("GHSA-rv95-896h-c2vc", never);
    expect(record?.id).toBe("GHSA-rv95-896h-c2vc");
    expect(record?.affected.map((a) => a.package.name)).toEqual(["express", "express"]);
    expect(seen[0]?.url).toBe("https://api.osv.dev/v1/vulns/GHSA-rv95-896h-c2vc");
  });

  it("answers null for an id OSV does not know", async () => {
    const { impl } = fake(() =>
      Response.json({ code: 5, message: "Vulnerability not found" }, { status: 404 }),
    );
    expect(await new OSV({ fetch: impl, retryMs: 0 }).record("GHSA-0000-0000-0000", never)).toBeNull();
  });

  it("fails ingest.upstream for a record without the required fields", async () => {
    const { impl } = fake(() => Response.json({ id: "X" }));
    expect((await failure(new OSV({ fetch: impl, retryMs: 0 }).record("X", never))).code).toBe(
      "ingest.upstream",
    );
  });
});
