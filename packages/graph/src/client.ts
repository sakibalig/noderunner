import {
  type Db,
  type G,
  GraphName,
  type Json,
  limits,
  type Param,
  type Params,
  type Query,
} from "@noderunner/core";
import { FalkorDB, type Graph as Remote } from "falkordb";
import { type GraphCode, GraphError } from "./errors.ts";
import { json } from "./values.ts";

type Options = NonNullable<Parameters<Remote["query"]>[1]>;
type Wire = NonNullable<Options["params"]>[string];

// FalkorDB's own default stops reads after 1 s (S1), so every call sends its own limit; the caller's signal is
// the real deadline. Writes ignore TIMEOUT on the server and always run to completion.
const queryMs = limits.toolMs;

// The client exposes FalkorDB failures only as message text and class names, so this is the one place they map.
const replies: readonly (readonly [string, GraphCode])[] = [
  ["Query timed out", "graph.timeout"],
  ["graph.RO_QUERY is to be executed only on read-only queries", "graph.readonly"],
  ["NOAUTH", "graph.unavailable"],
  ["WRONGPASS", "graph.unavailable"],
];
const transport = new Set([
  "ClientClosedError",
  "ConnectionTimeoutError",
  "ReconnectStrategyError",
  "SocketClosedUnexpectedlyError",
  "SocketTimeoutError",
]);
const absent = "Invalid graph operation on empty key";

const summaries: Readonly<Record<GraphCode, string>> = {
  "graph.unavailable": "FalkorDB is unavailable",
  "graph.timeout": "the query timed out",
  "graph.query": "FalkorDB rejected the query",
  "graph.readonly": "a write clause reached the read-only path",
  "graph.row": "a row did not match its schema",
  "graph.protected": "only a verification graph can be dropped",
};

function classify(error: unknown): GraphCode {
  if (!(error instanceof Error)) return "graph.query";
  if (transport.has(error.constructor.name)) return "graph.unavailable";
  if ("code" in error && typeof error.code === "string") return "graph.unavailable";
  for (const [prefix, code] of replies) if (error.message.includes(prefix)) return code;
  return "graph.query";
}

function fault(error: unknown, name: string): GraphError {
  if (error instanceof GraphError) return error;
  const code = classify(error);
  return new GraphError(code, `${name}: ${summaries[code]}`);
}

/** The read-only path returns FalkorDB's reason without its echo of the query, so a model can correct itself. */
function freeform(error: unknown): GraphError {
  const code = classify(error);
  if (code !== "graph.query" || !(error instanceof Error)) return fault(error, "read_only_cypher");
  // GRAPH.RO_QUERY on a graph that was never written fails before parsing; GRAPH.QUERY would create it.
  if (error.message.includes(absent)) {
    return new GraphError(code, "read_only_cypher: the graph does not exist yet", "missing");
  }
  const reason =
    error.message
      .split(" errCtx:")[0]
      ?.replace(/^errMsg: /, "")
      .slice(0, 300) ?? "";
  return new GraphError(code, `read_only_cypher: ${reason}`, "invalid");
}

function wire(value: Param): Wire {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item: Param) => wire(item));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, wire(item)]));
}

function wireAll(params: Params): Record<string, Wire> {
  return Object.fromEntries(Object.entries(params).map(([key, value]) => [key, wire(value)]));
}

/** Settles `work`, or rejects with `graph.timeout` as soon as `signal` fires; the server call is not cancelled. */
function within<T>(work: Promise<T>, signal: AbortSignal, name: string, map: (error: unknown) => GraphError) {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new GraphError("graph.timeout", `${name}: ${summaries["graph.timeout"]}`));
    if (signal.aborted) {
      work.catch(() => undefined);
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    work
      .then(resolve, (error: unknown) => reject(map(error)))
      .finally(() => {
        signal.removeEventListener("abort", abort);
      });
  });
}

function rows<R>(data: readonly Record<string, unknown>[] | undefined, q: Query<R>): R[] {
  return (data ?? []).map((raw) => {
    const parsed = q.row.safeParse(json(raw, q.name));
    if (!parsed.success) throw new GraphError("graph.row", `${q.name}: ${summaries["graph.row"]}`);
    return parsed.data;
  });
}

class Graph implements G {
  readonly name: GraphName;
  readonly #remote: Remote;

  constructor(name: GraphName, remote: Remote) {
    this.name = name;
    this.#remote = remote;
  }

  async query<R>(q: Query<R>, params: Params, signal: AbortSignal): Promise<readonly R[]> {
    if (signal.aborted) throw new GraphError("graph.timeout", `${q.name}: ${summaries["graph.timeout"]}`);
    const work = this.#remote.query<Record<string, unknown>>(q.text, {
      params: wireAll(params),
      TIMEOUT: queryMs,
    });
    const reply = await within(work, signal, q.name, (error) => fault(error, q.name));
    return rows(reply.data, q);
  }

  async roQuery(text: string, params: Params, signal: AbortSignal): Promise<readonly Json[]> {
    if (signal.aborted)
      throw new GraphError("graph.timeout", `read_only_cypher: ${summaries["graph.timeout"]}`);
    const work = this.#remote.roQuery<Record<string, unknown>>(text, {
      params: wireAll(params),
      TIMEOUT: limits.cypherMs,
    });
    const reply = await within(work, signal, "read_only_cypher", freeform);
    return (reply.data ?? []).map((raw) => json(raw, "read_only_cypher"));
  }

  async batch(
    q: Query<unknown>,
    all: readonly Params[],
    params: Params,
    signal: AbortSignal,
  ): Promise<number> {
    if ("rows" in params) throw new GraphError("graph.query", `${q.name}: $rows is reserved for the batch`);
    const shared = wireAll(params);
    for (let at = 0; at < all.length; at += limits.batchRows) {
      // A write cannot be cut short once sent, so the signal is honoured between chunks only.
      if (signal.aborted) throw new GraphError("graph.timeout", `${q.name}: ${summaries["graph.timeout"]}`);
      const chunk = all.slice(at, at + limits.batchRows).map(wireAll);
      try {
        await this.#remote.query(q.text, { params: { ...shared, rows: chunk }, TIMEOUT: queryMs });
      } catch (error) {
        throw fault(error, q.name);
      }
    }
    return all.length;
  }

  async drop(): Promise<void> {
    if (!this.name.startsWith("verify:")) {
      throw new GraphError("graph.protected", `${this.name}: ${summaries["graph.protected"]}`);
    }
    try {
      await this.#remote.delete();
    } catch (error) {
      if (error instanceof Error && error.message.includes(absent)) return;
      throw fault(error, "drop");
    }
  }
}

class Connection implements Db {
  readonly #client: FalkorDB;
  #closed = false;

  constructor(client: FalkorDB) {
    this.#client = client;
  }

  graph(name: GraphName): G {
    return new Graph(name, this.#client.selectGraph(name));
  }

  async list(): Promise<readonly GraphName[]> {
    let names: string[];
    try {
      names = await this.#client.list();
    } catch (error) {
      throw fault(error, "list");
    }
    return names
      .flatMap((name) => {
        const parsed = GraphName.safeParse(name);
        return parsed.success ? [parsed.data] : [];
      })
      .sort();
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#client.close();
  }
}

/**
 * Opens the process's one FalkorDB client. `onError` receives connection failures the client reports between
 * calls; without a listener such an event would crash the process. The client reconnects on its own.
 */
export async function connect(opts: {
  readonly url: string;
  readonly signal: AbortSignal;
  readonly onError: (error: GraphError) => void;
}): Promise<Db> {
  const opening = FalkorDB.connect({ url: opts.url });
  let client: FalkorDB;
  try {
    client = await within(
      opening,
      opts.signal,
      "connect",
      () => new GraphError("graph.unavailable", `connect: ${summaries["graph.unavailable"]}`),
    );
  } catch (error) {
    if (opts.signal.aborted) void opening.then((late) => late.close()).catch(() => undefined);
    throw error;
  }
  client.on("error", (error: unknown) => {
    const name = error instanceof Error ? error.constructor.name : "unknown";
    opts.onError(
      new GraphError("graph.unavailable", `connection: ${summaries["graph.unavailable"]} (${name})`),
    );
  });
  return new Connection(client);
}
