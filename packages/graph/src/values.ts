import type { Json } from "@noderunner/core";
import { GraphError } from "./errors.ts";

/**
 * Converts one value from the falkordb client into plain JSON. Nodes, edges, and paths arrive as plain objects;
 * temporal values arrive as objects with `toJSON` and become their ISO text.
 */
export function json(value: unknown, at: string): Json {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (Number.isFinite(value)) return value;
    throw new GraphError("graph.row", `${at}: a non-finite number cannot be represented`);
  }
  if (Array.isArray(value)) return value.map((item) => json(item, at));
  if (typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto === Object.prototype || proto === null) {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, json(item, at)]));
    }
    if ("toJSON" in value && typeof value.toJSON === "function") {
      const text: unknown = value.toJSON();
      if (typeof text === "string") return text;
    }
  }
  throw new GraphError("graph.row", `${at}: an unsupported value of type ${typeof value}`);
}
