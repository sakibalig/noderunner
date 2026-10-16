import { type Agent, type Json, Json as JsonSchema, type ModelTool } from "@noderunner/core";
import { type AnyTool, available } from "@noderunner/tools";
import { z } from "zod";

export type AgentKind = Extract<Agent, "triage" | "fixer" | "baseline">;

/** The agent's tools, from the same per-actor sets callTool enforces; access never narrows an agent's set. */
export function toolsFor(agent: AgentKind, defs: readonly AnyTool[]): readonly AnyTool[] {
  return available(agent, ["read", "derive", "act"], defs);
}

/** A tool's JSON Schema as a model reads it, without the `$schema` marker, in registry order. */
export function specs(defs: readonly AnyTool[]): ModelTool[] {
  return defs.map((def) => {
    const schema: Json = JsonSchema.parse(z.toJSONSchema(def.input, { io: "input" }));
    const plain =
      schema !== null && typeof schema === "object" && !Array.isArray(schema)
        ? Object.fromEntries(Object.entries(schema).filter(([key]) => key !== "$schema"))
        : schema;
    return { name: def.name, description: def.description, schema: plain };
  });
}
