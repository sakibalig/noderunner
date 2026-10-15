export type Packument = {
  readonly name: string;
  readonly versions: Readonly<Record<string, { readonly deps: Readonly<Record<string, string>> }>>;
};

/** The npm registry. */
export interface Registry {
  packument(name: string, signal: AbortSignal): Promise<Packument | null>;
}
