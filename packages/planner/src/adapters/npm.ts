import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Clock, Packument, Registry } from "@noderunner/core";
import { z } from "zod";
import { PlannerError } from "../errors.ts";

const REGISTRY = "https://registry.npmjs.org";
const MEMORY_NAMES = 2_000;
const FRESH_MS = 24 * 60 * 60 * 1000;
const AT_ONCE = 8;

const Ranges = z.record(z.string(), z.string()).optional();
const Abbreviated = z
  .object({
    name: z.string(),
    versions: z.record(
      z.string(),
      z.object({ dependencies: Ranges, optionalDependencies: Ranges, peerDependencies: Ranges }).loose(),
    ),
  })
  .loose();
const Stored = z.object({
  fetchedAt: z.number(),
  packument: z.object({
    name: z.string(),
    versions: z.record(z.string(), z.object({ deps: z.record(z.string(), z.string()) })),
  }),
});

/** Merges each version's dependency maps; `dependencies` wins over optional, which wins over peer. */
function packumentOf(raw: z.infer<typeof Abbreviated>): Packument {
  const versions = Object.fromEntries(
    Object.entries(raw.versions).map(([version, v]) => [
      version,
      { deps: { ...v.peerDependencies, ...v.optionalDependencies, ...v.dependencies } },
    ]),
  );
  return { name: raw.name, versions };
}

/** The registry path of a name: a scope keeps its `@` and its slash is encoded. */
function encoded(name: string): string {
  return name.startsWith("@") ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name);
}

/**
 * `Registry` over the npm registry's abbreviated packuments, with a bounded memory cache and a disk cache under
 * `dir`. A disk entry under 24 hours old answers without a request; an older one answers when the request fails,
 * so a warm demo works offline. A 404 is null.
 */
export function npm(opts: {
  readonly dir: string;
  readonly fetch?: typeof fetch;
  readonly clock: Clock;
  readonly registry?: string;
}): Registry {
  const http = opts.fetch ?? fetch;
  const base = opts.registry ?? REGISTRY;
  const memory = new Map<string, Packument | null>();
  let running = 0;
  const waiting: (() => void)[] = [];

  const slot = async () => {
    if (running >= AT_ONCE) await new Promise<void>((resolve) => waiting.push(resolve));
    running += 1;
  };
  const release = () => {
    running -= 1;
    waiting.shift()?.();
  };
  const remember = (name: string, value: Packument | null) => {
    if (memory.size >= MEMORY_NAMES) {
      const oldest = memory.keys().next().value;
      if (oldest !== undefined) memory.delete(oldest);
    }
    memory.set(name, value);
  };
  const file = (name: string) => join(opts.dir, "registry", `${encodeURIComponent(name)}.json`);

  const fromDisk = async (name: string): Promise<z.infer<typeof Stored> | null> => {
    try {
      return Stored.parse(JSON.parse(await readFile(file(name), "utf8")));
    } catch {
      return null;
    }
  };

  return {
    async packument(name, signal) {
      if (memory.has(name)) return memory.get(name) ?? null;
      const stored = await fromDisk(name);
      if (stored !== null && opts.clock.now() - stored.fetchedAt < FRESH_MS) {
        remember(name, stored.packument);
        return stored.packument;
      }
      await slot();
      try {
        const response = await http(`${base}/${encoded(name)}`, {
          headers: { Accept: "application/vnd.npm.install-v1+json" },
          signal,
        });
        if (response.status === 404) {
          remember(name, null);
          return null;
        }
        if (!response.ok) throw new Error(`npm answered ${response.status}`);
        const packument = packumentOf(Abbreviated.parse(await response.json()));
        remember(name, packument);
        await mkdir(join(opts.dir, "registry"), { recursive: true });
        await writeFile(file(name), JSON.stringify({ fetchedAt: opts.clock.now(), packument }));
        return packument;
      } catch {
        signal.throwIfAborted();
        if (stored !== null) {
          remember(name, stored.packument);
          return stored.packument;
        }
        throw new PlannerError("registry.upstream", `The npm registry could not give ${name}`);
      } finally {
        release();
      }
    },
  };
}
