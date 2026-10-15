import { type ErrorCode, Fault } from "@noderunner/core";

export type GraphCode =
  | "graph.unavailable"
  | "graph.timeout"
  | "graph.query"
  | "graph.readonly"
  | "graph.row"
  | "graph.protected";

const surfaces: Readonly<Record<GraphCode, ErrorCode>> = {
  "graph.unavailable": "upstream",
  "graph.timeout": "upstream",
  "graph.query": "internal",
  "graph.readonly": "invalid",
  "graph.row": "internal",
  "graph.protected": "internal",
};

/** A FalkorDB failure; the message names the constant and the failure, never a parameter value. */
export class GraphError extends Fault {
  readonly code: GraphCode;
  readonly surface: ErrorCode;

  constructor(code: GraphCode, message: string, surface: ErrorCode = surfaces[code]) {
    super(message);
    this.name = "GraphError";
    this.code = code;
    this.surface = surface;
  }
}
