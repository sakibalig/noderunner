import type { G } from "@noderunner/core";
import { schema } from "./cypher/index.ts";

/** Creates the contract's indexes that are missing; safe to run on every start. */
export async function migrate(g: G, kind: "repo" | "advisories", signal: AbortSignal): Promise<void> {
  const existing = await g.query(schema.indexes, {}, signal);
  const have = new Set(
    existing.flatMap((row) => row.properties.map((property) => `${row.label}.${property}`)),
  );
  for (const index of kind === "repo" ? schema.repo : schema.advisories) {
    if (!have.has(`${index.label}.${index.property}`)) await g.query(index.create, {}, signal);
  }
}
