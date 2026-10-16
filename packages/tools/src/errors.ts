import { type ErrorCode, Fault } from "@noderunner/core";

export type ToolCode = "tool.unavailable" | "tool.input" | "tool.missing" | "tool.timeout" | "tool.cancelled";

const surfaces: Readonly<Record<ToolCode, ErrorCode>> = {
  "tool.unavailable": "invalid",
  "tool.input": "invalid",
  "tool.missing": "missing",
  "tool.timeout": "upstream",
  "tool.cancelled": "internal",
};

/** A tool call that failed for a reason the caller can act on; the message is safe to show a model. */
export class ToolError extends Fault {
  readonly code: ToolCode;
  readonly surface: ErrorCode;

  constructor(code: ToolCode, message: string) {
    super(message);
    this.name = "ToolError";
    this.code = code;
    this.surface = surfaces[code];
  }
}
