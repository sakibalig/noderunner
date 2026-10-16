import { type Db, Json, limits, type ToolDef, type ToolOutput } from "@noderunner/core";
import { z } from "zod";
import { ToolError } from "../errors.ts";
import { Collector } from "../evidence.ts";
import { type Quoted, quoted } from "../quoted.ts";

const MAX_CHARS = 4_000;
const FETCH = limits.cypherRows + 1;

const Scalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const Input = z
  .object({
    query: z
      .string()
      .min(1)
      .max(MAX_CHARS)
      .describe("One read-only Cypher query over this repository's graph"),
    params: z
      .record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.union([Scalar, z.array(Scalar)]))
      .default({})
      .describe("Query parameters, referenced as $name"),
  })
  .strict();

/** Each label's key property, from contracts/graph/schema.md, so a node in a row can become evidence. */
const keys: Readonly<Record<string, string>> = {
  Repo: "url",
  File: "path",
  Package: "name",
  Install: "lock_path",
  Vuln: "id",
  Person: "handle",
  Run: "id",
  Step: "id",
  Finding: "key",
  Plan: "id",
  Upgrade: "id",
  Decision: "id",
  PullRequest: "url",
};

const blocked: readonly (readonly [RegExp, string])[] = [
  [/\bCALL\s+db\./i, "db. procedures are not allowed"],
  [/\bGRAPH\./i, "GRAPH commands are not allowed"],
  [/\bLOAD\s+CSV\b/i, "LOAD CSV is not allowed"],
  [/;\s*\S/, "only one statement is allowed"],
  [
    /\b(CREATE|MERGE|DELETE|DETACH|SET|REMOVE|DROP)\b/i,
    "the query must only read; write clauses are not allowed",
  ],
];

type Row = { readonly [key: string]: Value };
type Value = string | number | boolean | null | Quoted | readonly Value[] | { readonly [key: string]: Value };
export type Data = { readonly rows: readonly Row[]; readonly truncated: boolean };

/** The query text with string literals emptied, so the guard never matches inside a string. */
function bare(text: string): string {
  return text.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g, "''");
}

/** Caps the rows returned: a trailing LIMIT above 201 is lowered, and a query without one gets LIMIT 201. */
export function bounded(text: string): string {
  const trimmed = text.trim().replace(/;\s*$/, "");
  const tail = /\bLIMIT\s+(\S+)\s*$/i.exec(bare(trimmed));
  if (tail === null) return `${trimmed} LIMIT ${FETCH}`;
  const n = Number(tail[1]);
  if (Number.isInteger(n) && n >= 0 && n <= FETCH) return trimmed;
  return `${trimmed.slice(0, trimmed.length - tail[0].length)}LIMIT ${FETCH}`;
}

/** Rejects anything but one read-only query; FalkorDB's read-only path is the guarantee, this is the explanation. */
export function guard(text: string): void {
  const stripped = bare(text.trim().replace(/;\s*$/, ""));
  for (const [pattern, reason] of blocked) {
    if (pattern.test(stripped)) throw new ToolError("tool.input", `Rejected: ${reason}`);
  }
}

const NodeShape = z.object({
  id: z.number().int(),
  labels: z.array(z.string()),
  properties: z.record(z.string(), Json),
});
const EdgeShape = z.object({
  id: z.number().int(),
  relationshipType: z.string(),
  sourceId: z.number().int(),
  destinationId: z.number().int(),
});

function isList(value: Json): value is readonly Json[] {
  return Array.isArray(value);
}

/** Every string becomes `{ quoted }`; numbers, booleans, and null stay as they are. */
function mark(value: Json): Value {
  if (typeof value === "string") return quoted(value);
  if (isList(value)) return value.map(mark);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mark(item)]));
  }
  return value;
}

/** A row keyed by column, every value marked; a row that is not an object is kept under `value`. */
function markRow(row: Json): Row {
  if (row !== null && typeof row === "object" && !isList(row)) {
    return Object.fromEntries(Object.entries(row).map(([key, item]) => [key, mark(item)]));
  }
  return { value: mark(row) };
}

/** The free-form escape hatch: one read-only query, at most 200 rows, run on this repository's graph only. */
export function readOnlyCypher(deps: { readonly db: Db }): ToolDef<typeof Input, Data> {
  return {
    name: "read_only_cypher",
    description:
      "Runs one read-only Cypher query on this repository's graph and returns at most 200 rows. Writes, db. " +
      "procedures, GRAPH commands, and LOAD CSV are rejected. Prefer the typed tools; use this for questions " +
      "they do not answer. Labels: Repo, File, Package, Install, Vuln, Finding, Person, Decision, Plan, Upgrade.",
    input: Input,
    access: "read",
    timeoutMs: limits.toolMs,
    async run(ctx, input): Promise<ToolOutput<Data>> {
      guard(input.query);
      const text = bounded(input.query);
      const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(limits.cypherMs)]);
      const raw = await deps.db.graph(ctx.graph).roQuery(text, input.params, signal);
      const truncated = raw.length > limits.cypherRows;
      const rows = raw.slice(0, limits.cypherRows);

      const evidence = new Collector().ran(text);
      const nodes = new Map<number, { label: string; key: string }>();
      const edges: { id: number; type: string; from: number; to: number }[] = [];
      const visit = (value: Json) => {
        const node = NodeShape.safeParse(value);
        if (node.success) {
          const label = node.data.labels[0] ?? "";
          const property = keys[label];
          const key = property === undefined ? undefined : node.data.properties[property];
          if (typeof key === "string") nodes.set(node.data.id, { label, key });
          return;
        }
        const edge = EdgeShape.safeParse(value);
        if (edge.success) {
          const { id, relationshipType: type, sourceId: from, destinationId: to } = edge.data;
          edges.push({ id, type, from, to });
          return;
        }
        if (isList(value)) for (const item of value) visit(item);
        else if (value !== null && typeof value === "object")
          for (const item of Object.values(value)) visit(item);
      };
      for (const row of rows) visit(row);
      for (const [id, node] of nodes) evidence.node({ id, key: node.key, label: node.label, name: node.key });
      for (const edge of edges) {
        const [from, to] = [nodes.get(edge.from), nodes.get(edge.to)];
        if (from !== undefined && to !== undefined) {
          evidence.edge({ ...edge, fromKey: from.key, toKey: to.key });
        }
      }
      const marked = rows.map(markRow);
      return {
        data: { rows: marked, truncated },
        summary: `${rows.length} rows${truncated ? ` (cut at ${limits.cypherRows})` : ""}`,
        evidence: evidence.done(),
      };
    },
  };
}
