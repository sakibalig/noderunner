import type { Query } from "@noderunner/core";
import { z } from "zod";

const none = z.record(z.string(), z.never()).describe("A write returns no rows");

/** Builds a named read constant; `name` is `<file>.<constant>`. */
export function query<R>(name: string, text: string, row: z.ZodType<R>): Query<R> {
  return Object.freeze({ name, text, row });
}

/** Builds a named write constant, which returns no rows. */
export function write(name: string, text: string): Query<Record<string, never>> {
  return query(name, text, none);
}
