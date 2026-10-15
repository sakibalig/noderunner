import { type ErrorCode, Fault } from "@noderunner/core";

/** A failure the worker answers with a stable code. */
export class WorkerError extends Fault {
  readonly code: string;
  readonly surface: ErrorCode;

  constructor(surface: ErrorCode, code: string, message: string) {
    super(message);
    this.name = "WorkerError";
    this.surface = surface;
    this.code = code;
  }
}

/** Any package's `Fault` keeps its code and safe message; anything else is `internal` with a generic message. */
export function surfaceOf(
  error: unknown,
  fallback: string,
): { readonly code: ErrorCode; readonly message: string } {
  if (error instanceof Fault) return { code: error.surface, message: error.message };
  return { code: "internal", message: fallback };
}
