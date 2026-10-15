import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ErrorCode, errorTable } from "./errors.ts";

describe("errorTable", () => {
  it("equals contracts/api/errors.json", () => {
    const url = new URL("../../../contracts/api/errors.json", import.meta.url);
    const file = JSON.parse(readFileSync(url, "utf8")) as {
      errors: Record<string, { status: number; retryable: boolean }>;
    };
    const fromFile = Object.fromEntries(
      Object.entries(file.errors).map(([code, entry]) => [
        code,
        { status: entry.status, retryable: entry.retryable },
      ]),
    );
    expect(errorTable).toEqual(fromFile);
    expect([...ErrorCode.options].sort()).toEqual(Object.keys(file.errors).sort());
  });
});
