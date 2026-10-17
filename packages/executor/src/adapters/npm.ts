import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import type { Sandbox } from "@noderunner/core";
import { ExecutorError } from "../errors.ts";

export const SANDBOX_MS = 120_000;
/** How long npm gets to exit after SIGTERM before its whole process group is killed. */
const GRACE_MS = 5_000;

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
 * only package manifests and the lockfile; no shell, no lifecycle scripts, and no repository code.
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
        const at = resolve(dir, w.path);
        if (!at.startsWith(dir + sep))
          throw new ExecutorError("executor.unsupported", "A workspace path leaves the sandbox folder");
        await mkdir(at, { recursive: true });
        await writeFile(join(at, "package.json"), w.manifest);
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
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** Runs one npm command in its own process group, so an abort kills npm and everything it started. */
  #run(args: readonly string[], cwd: string, signal: AbortSignal, limit: AbortSignal): Promise<void> {
    const env = {
      PATH: process.env.PATH ?? "",
      HOME: cwd,
      npm_config_cache: this.options.cache,
      npm_config_update_notifier: "false",
    };
    const seconds = (this.options.ms ?? SANDBOX_MS) / 1000;
    return new Promise((done, fail) => {
      if (signal.aborted) return fail(new ExecutorError("executor.sandbox", "The regeneration was stopped"));
      const child = spawn(this.options.bin ?? "npm", args, { cwd, env, stdio: "ignore", detached: true });
      let kill: NodeJS.Timeout | undefined;
      const group = (sig: NodeJS.Signals) => {
        try {
          if (child.pid !== undefined) process.kill(-child.pid, sig);
        } catch {
          // Already gone.
        }
      };
      const stop = () => {
        group("SIGTERM");
        kill = setTimeout(() => group("SIGKILL"), GRACE_MS);
      };
      signal.addEventListener("abort", stop, { once: true });
      const settle = () => {
        clearTimeout(kill);
        signal.removeEventListener("abort", stop);
      };
      child.once("error", () => {
        settle();
        fail(new ExecutorError("executor.sandbox", "npm could not run"));
      });
      child.once("close", (code) => {
        settle();
        if (signal.aborted)
          fail(
            new ExecutorError(
              "executor.sandbox",
              limit.aborted ? `npm took longer than ${seconds} s` : "The regeneration was stopped",
            ),
          );
        else if (code === 0) done();
        else fail(new ExecutorError("executor.sandbox", `npm ${args[0]} exited with code ${code ?? "null"}`));
      });
    });
  }
}
