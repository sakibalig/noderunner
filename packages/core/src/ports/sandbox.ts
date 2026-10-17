/** Lockfile regeneration with `--ignore-scripts`, isolated from the worker. */
export interface Sandbox {
  /** `workspaces` are the manifests of the lockfile's workspace packages, so npm keeps their entries. */
  regenerate(
    files: {
      readonly manifest: string;
      readonly lock: string;
      readonly workspaces: readonly { readonly path: string; readonly manifest: string }[];
    },
    refresh: readonly string[],
    signal: AbortSignal,
  ): Promise<{ readonly lock: string }>;
}
