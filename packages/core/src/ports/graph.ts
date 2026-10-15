import type { z } from "zod";
import type { GraphName } from "../ids.ts";
import type { Json } from "../json.ts";

export type Param = string | number | boolean | null | readonly Param[] | { readonly [key: string]: Param };

export type Params = Readonly<Record<string, Param>>;

/** A named Cypher constant from packages/graph, with the schema every returned row is parsed with. */
export type Query<R> = { readonly name: string; readonly text: string; readonly row: z.ZodType<R> };

export interface G {
  readonly name: GraphName;
  query<R>(q: Query<R>, params: Params, signal: AbortSignal): Promise<readonly R[]>;
  /** Runs free-form text through FalkorDB's read-only query command. */
  roQuery(text: string, params: Params, signal: AbortSignal): Promise<readonly Json[]>;
  /** Runs a named `UNWIND $rows` query in chunks of limits.batchRows. */
  batch(q: Query<unknown>, rows: readonly Params[], params: Params, signal: AbortSignal): Promise<number>;
  drop(): Promise<void>;
}

export interface Db {
  graph(name: GraphName): G;
  list(): Promise<readonly GraphName[]>;
  close(): Promise<void>;
}
