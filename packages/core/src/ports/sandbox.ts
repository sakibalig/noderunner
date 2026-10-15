/** Lockfile regeneration with `--ignore-scripts`, isolated from the worker. */
export interface Sandbox {
  regenerate(
    files: { readonly manifest: string; readonly lock: string },
    refresh: readonly string[],
    signal: AbortSignal,
  ): Promise<{ readonly lock: string }>;
}
