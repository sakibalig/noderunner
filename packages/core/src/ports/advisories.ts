import type { OsvRecord } from "../range.ts";

export type Pair = { readonly name: string; readonly version: string };

export type Hit = { readonly id: string; readonly modified: number };

/** OSV. */
export interface Advisories {
  query(pairs: readonly Pair[], signal: AbortSignal): Promise<readonly (readonly Hit[])[]>;
  record(id: string, signal: AbortSignal): Promise<OsvRecord | null>;
}
