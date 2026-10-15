import { z } from "zod";

export type Json = string | number | boolean | null | readonly Json[] | { readonly [key: string]: Json };

export const Json: z.ZodType<Json> = z.lazy(() =>
  z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(Json), z.record(z.string(), Json)]),
);
