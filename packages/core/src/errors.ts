import { z } from "zod";

export const ErrorCode = z
  .enum([
    "invalid",
    "unauthorized",
    "unapproved",
    "missing",
    "busy",
    "shipped",
    "unsupported",
    "range",
    "limited",
    "upstream",
    "internal",
  ])
  .describe("A stable error code");
export type ErrorCode = z.infer<typeof ErrorCode>;

export const errorTable: Readonly<
  Record<ErrorCode, { readonly status: number; readonly retryable: boolean }>
> = {
  invalid: { status: 400, retryable: false },
  unauthorized: { status: 401, retryable: false },
  unapproved: { status: 403, retryable: false },
  missing: { status: 404, retryable: false },
  busy: { status: 409, retryable: true },
  shipped: { status: 409, retryable: false },
  unsupported: { status: 422, retryable: false },
  range: { status: 422, retryable: false },
  limited: { status: 429, retryable: true },
  upstream: { status: 502, retryable: true },
  internal: { status: 500, retryable: false },
};

export const ErrorBody = z.object({
  error: z.object({
    code: ErrorCode,
    message: z.string().describe("A safe message: no stack, path, or secret"),
  }),
});
export type ErrorBody = z.infer<typeof ErrorBody>;

/** The base of every package's errors. */
export abstract class Fault extends Error {
  abstract readonly code: string;
  abstract readonly surface: ErrorCode;
}

export class EnvError extends Fault {
  readonly code = "env.invalid";
  readonly surface = "internal";
  readonly names: readonly string[];

  constructor(names: readonly string[]) {
    super(`Invalid or missing environment variables: ${names.join(", ")}`);
    this.name = "EnvError";
    this.names = names;
  }
}
