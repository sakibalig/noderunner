import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Sandbox } from "@noderunner/core";
import { ExecutorError } from "../errors.ts";

export const SANDBOX_MS = 120_000;

const NAME = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
const FLAGS = ["--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"];

/**
 * The npm argument arrays for a regeneration; a name outside npm's grammar is refused before anything runs. `peers`
 * is `legacy` for a lockfile npm cannot reproduce with strict peer resolution.
 */
export function commands(
  refresh: readonly string[],
  peers: "strict" | "legacy",
): readonly (readonly string[])[] {
  const bad = refresh.find((name) => !NAME.test(name));
  if (bad !== undefined)
    throw new ExecutorError("executor.sandbox", "A refresh target is not a valid package name");
  const flags = peers === "legacy" ? [...FLAGS, "--legacy-peer-deps"] : FLAGS;
  return [["install", ...flags], ...(refresh.length > 0 ? [["update", ...flags, "--", ...refresh]] : [])];
}

/**
 * Regenerates the lockfile with npm as an unprivileged child process (D14), in a fresh temporary folder that holds
 * only the two package files; no shell, no lifecycle scripts, and no repository code.
 */
export class Npm implements Sandbox {
  constructor(
    private readonly options: { readonly cache: string; readonly bin?: string; readonly ms?: number },
  ) {}

  async regenerate(
    files: Parameters<Sandbox["regenerate"]>[0],
    refresh: readonly string[],
    signal: AbortSignal,
  ): Promise<{ readonly lock: string }> {
    commands(refresh, "strict");
    const dir = await mkdtemp(join(tmpdir(), "noderunner-"));
    try {
      await writeFile(join(dir, "package.json"), files.manifest);
      for (const w of files.workspaces) {
        await mkdir(join(dir, w.path), { recursive: true });
        await writeFile(join(dir, w.path, "package.json"), w.manifest);
      }
      await mkdir(this.options.cache, { recursive: true });
      const limit = AbortSignal.timeout(this.options.ms ?? SANDBOX_MS);
      const both = AbortSignal.any([signal, limit]);
      const attempt = async (peers: "strict" | "legacy") => {
        await writeFile(join(dir, "package-lock.json"), files.lock);
        for (const args of commands(refresh, peers)) await this.#run(args, dir, both, limit);
      };
      await attempt("strict").catch((error: unknown) => {
        if (both.aborted) throw error;
        return attempt("legacy");
      });
      return { lock: await readFile(join(dir, "package-lock.json"), "utf8") };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  #run(args: readonly string[], cwd: string, signal: AbortSignal, limit: AbortSignal): Promise<void> {
    const env = {
      PATH: process.env.PATH ?? "",
      HOME: cwd,
      npm_config_cache: this.options.cache,
      npm_config_update_notifier: "false",
    };
    return new Promise((resolve, reject) => {
      const child = spawn(this.options.bin ?? "npm", args, { cwd, env, signal, stdio: "ignore" });
      child.once("error", () =>
        reject(
          new ExecutorError(
            "executor.sandbox",
            limit.aborted
              ? `npm took longer than ${(this.options.ms ?? SANDBOX_MS) / 1000} s`
              : "npm could not run",
          ),
        ),
      );
      child.once("exit", (code) =>
        code === 0
          ? resolve()
          : reject(
              new ExecutorError("executor.sandbox", `npm ${args[0]} exited with code ${code ?? "null"}`),
            ),
      );
    });
  }
}
