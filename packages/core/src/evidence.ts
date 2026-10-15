import { z } from "zod";
import { Json } from "./json.ts";
import { limits } from "./limits.ts";

export const EvNode = z.object({
  id: z.number().int().nonnegative().describe("The FalkorDB internal id, valid within the current snapshot"),
  key: z.string().min(1).describe("The node's stable key from the graph schema"),
  label: z.string().min(1).describe("The node label, such as Install"),
  name: z.string().describe("A display name"),
  props: z.record(z.string(), Json).optional().describe("A few display properties"),
});
export type EvNode = z.infer<typeof EvNode>;

export const EvEdge = z.object({
  id: z.number().int().nonnegative().describe("The FalkorDB internal id, valid within the current snapshot"),
  key: z.string().min(1).describe("The stable edge key"),
  type: z.string().min(1).describe("The relationship type, such as DEPENDS_ON"),
  from: z.number().int().nonnegative().describe("The internal id of the start node"),
  to: z.number().int().nonnegative().describe("The internal id of the end node"),
  fromKey: z.string().min(1).describe("The stable key of the start node"),
  toKey: z.string().min(1).describe("The stable key of the end node"),
});
export type EvEdge = z.infer<typeof EvEdge>;

/** What one tool call touched; goes to the UI and the graph, never to the model. */
export const Evidence = z.object({
  nodes: z.array(EvNode).max(limits.evidenceNodes).describe("Touched nodes"),
  edges: z.array(EvEdge).max(limits.evidenceEdges).describe("Touched edges"),
  cypher: z.array(z.string()).describe("The exact query texts run"),
});
export type Evidence = z.infer<typeof Evidence>;

export function edgeKey(fromKey: string, type: string, toKey: string): string {
  return `${fromKey}|${type}|${toKey}`;
}
