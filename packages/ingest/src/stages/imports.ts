import { builtinModules } from "node:module";
import { posix } from "node:path";
import type { G, RunEvent, Sha, Warning } from "@noderunner/core";
import { ingest } from "@noderunner/graph/cypher";
import { entries, type FileKind, kind } from "../parse/classify.ts";
import { imports as found } from "../parse/imports.ts";
import type { Manifest } from "../parse/manifest.ts";

export type FileRow = { readonly path: string; readonly kind: FileKind; readonly is_entry: boolean };
export type LinkRow = { readonly from: string; readonly to: string };
export type UseRow = { readonly from: string; readonly name: string; readonly specifier: string };
export type LoadRow = { readonly from: string; readonly to: string };

export type Graph = {
  readonly files: readonly FileRow[];
  readonly links: readonly LinkRow[];
  readonly uses: readonly UseRow[];
  readonly loads: readonly LoadRow[];
  readonly warnings: readonly Warning[];
};

const extensions = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const swaps: Readonly<Record<string, readonly string[]>> = {
  ".js": [".ts", ".tsx"],
  ".jsx": [".tsx"],
  ".mjs": [".mts"],
  ".cjs": [".cts"],
};
const source = /\.(js|mjs|cjs|ts|mts|cts|tsx|jsx)$/;
const npmName = /^(@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const builtins = new Set(builtinModules);

/** Where a relative specifier leads: a kept file, nothing (a missing source file), or outside what is tracked. */
export type Target =
  | { readonly kind: "file"; readonly path: string }
  | { readonly kind: "missing" }
  | { readonly kind: "ignored" };

/** A relative specifier's target among the kept files, trying extensions, index files, and TS ESM swaps. */
export function relative(from: string, specifier: string, files: ReadonlySet<string>): Target {
  const joined = posix.normalize(posix.join(posix.dirname(from), specifier));
  if (joined.startsWith("../") || joined === "..") return { kind: "ignored" };
  const base = joined === "." ? "" : joined.replace(/\/$/, "");
  const candidates = [base, ...extensions.map((ext) => `${base}${ext}`)];
  const ext = posix.extname(base);
  for (const swap of swaps[ext] ?? []) candidates.push(`${base.slice(0, -ext.length)}${swap}`);
  candidates.push(...extensions.map((e) => `${base ? `${base}/` : ""}index${e}`));
  for (const candidate of candidates) if (files.has(candidate)) return { kind: "file", path: candidate };
  if (ext !== "" && !source.test(base)) return { kind: "ignored" };
  return { kind: "missing" };
}

/** The package a bare specifier names, with its subpath kept; null for an alias that is not an npm name. */
export function bare(specifier: string): { readonly name: string } | null {
  const parts = specifier.split("/");
  const name = specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? "");
  return npmName.test(name) ? { name } : null;
}

/** Node's lookup from a file: `node_modules/<pkg>` in the file's folder, then in each folder above it. */
export function load(from: string, pkg: string, installs: ReadonlySet<string>): string | null {
  let dir = posix.dirname(from);
  for (;;) {
    const at = dir === "." ? "" : dir;
    const candidate = `${at ? `${at}/` : ""}node_modules/${pkg}`;
    if (installs.has(candidate)) return candidate;
    if (at === "") return null;
    dir = posix.dirname(at);
  }
}

function grouped(code: Warning["code"], items: readonly string[]): Warning[] {
  return items.length === 0 ? [] : [{ code, count: items.length, sample: items.slice(0, 5) }];
}

const byPath = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Builds every File, IMPORTS, and LOADS row from the kept source files; touches no graph. */
export function graph(
  files: ReadonlyMap<string, string>,
  manifest: Manifest,
  installs: ReadonlySet<string>,
): Graph {
  const paths = [...files.keys()].sort(byPath);
  const kept = new Set(paths);
  const entry = entries(manifest, paths);
  const rows: FileRow[] = paths.map((path) => ({ path, kind: kind(path), is_entry: entry.has(path) }));

  const links = new Map<string, LinkRow>();
  const uses = new Map<string, UseRow>();
  const loads = new Map<string, LoadRow>();
  const regex: string[] = [];
  const aliases: string[] = [];
  const unresolved: string[] = [];

  for (const path of paths) {
    const result = found(path, files.get(path) ?? "");
    if (result.parsed === "regex") regex.push(path);
    for (const specifier of result.sources) {
      if (specifier.startsWith("node:")) continue;
      if (
        specifier.startsWith("./") ||
        specifier.startsWith("../") ||
        specifier === "." ||
        specifier === ".."
      ) {
        const target = relative(path, specifier, kept);
        if (target.kind === "missing") unresolved.push(`${path} -> ${specifier}`);
        else if (target.kind === "file")
          links.set(`${path}\u0000${target.path}`, { from: path, to: target.path });
        continue;
      }
      const named = bare(specifier);
      if (named === null) {
        aliases.push(`${path} -> ${specifier}`);
        continue;
      }
      if (builtins.has(named.name) || builtins.has(specifier)) continue;
      const key = `${path}\u0000${named.name}`;
      if (!uses.has(key)) uses.set(key, { from: path, name: named.name, specifier });
      const to = load(path, named.name, installs);
      if (to === null) unresolved.push(`${path} -> ${specifier}`);
      else loads.set(`${path}\u0000${to}`, { from: path, to });
    }
  }

  const sorted = <T extends { from: string }>(map: Map<string, T>) =>
    [...map.entries()].sort(([a], [b]) => byPath(a, b)).map(([, row]) => row);
  return {
    files: rows,
    links: sorted(links),
    uses: sorted(uses),
    loads: sorted(loads),
    warnings: [
      ...grouped("parse", regex),
      ...grouped("alias", aliases),
      ...grouped("unresolved", unresolved),
    ],
  };
}

/** Stage 3. Writes the files, what each imports, and the install each bare import loads. */
export async function imports(
  input: {
    readonly g: G;
    readonly url: string;
    readonly sha: Sha;
    readonly files: ReadonlyMap<string, string>;
    readonly manifest: Manifest;
    readonly installs: ReadonlySet<string>;
  },
  opts: {
    readonly onProgress: (event: Extract<RunEvent, { type: "ingest.progress" }>) => void;
    readonly signal: AbortSignal;
  },
): Promise<{ readonly files: number; readonly warnings: readonly Warning[] }> {
  const { g, url, sha } = input;
  const { signal } = opts;
  const total = input.files.size;
  opts.onProgress({ type: "ingest.progress", stage: "imports", done: 0, total });
  signal.throwIfAborted();
  const built = graph(input.files, input.manifest, input.installs);
  await g.batch(ingest.imports.files, built.files, { sha, url }, signal);
  await g.batch(ingest.imports.links, built.links, { sha }, signal);
  await g.batch(ingest.imports.uses, built.uses, { sha }, signal);
  await g.batch(ingest.imports.loads, built.loads, { sha }, signal);
  opts.onProgress({ type: "ingest.progress", stage: "imports", done: total, total });
  return { files: built.files.length, warnings: built.warnings };
}
