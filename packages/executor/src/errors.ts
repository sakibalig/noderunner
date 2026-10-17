import { type ErrorCode, Fault } from "@noderunner/core";

export type ExecutorCode =
  | "executor.unapproved"
  | "executor.shipped"
  | "executor.busy"
  | "executor.missing"
  | "executor.range"
  | "executor.unsupported"
  | "executor.sandbox"
  | "executor.forge"
  | "executor.verify";

const surfaces: Readonly<Record<ExecutorCode, ErrorCode>> = {
  "executor.unapproved": "unapproved",
  "executor.shipped": "shipped",
  "executor.busy": "busy",
  "executor.missing": "missing",
  "executor.range": "range",
  "executor.unsupported": "unsupported",
  "executor.sandbox": "upstream",
  "executor.forge": "upstream",
  "executor.verify": "internal",
};

/** A shipping failure; the message is safe to show and never carries file content or a token. */
export class ExecutorError extends Fault {
  readonly code: ExecutorCode;
  readonly surface: ErrorCode;

  constructor(code: ExecutorCode, message: string) {
    super(message);
    this.name = "ExecutorError";
    this.code = code;
    this.surface = surfaces[code];
  }
}
