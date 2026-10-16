import type { Json } from "@noderunner/core";
import type { Manifest } from "./manifest.ts";

export type FileKind = "prod" | "test" | "script" | "config";

const test =
  /(^|\/)(__tests__|__mocks__)\/|\.(test|spec)\.[^/]+$|^(test|tests|e2e|cypress|playwright|\.storybook)\/|\.stories\.[^/]+$/;
const config = /(^|\/)([^/]+\.config\.[^/]+|\.eslintrc[^/]*|babel\.config\.[^/]+|jest\.setup\.[^/]+)$/;
const script = /^(scripts|tools|bench)\//;
const conventional = /^(src\/)?(pages|app)\/|^(src\/)?(index|server)\.[^/]+$/;

/** The first matching kind of test, config, script, then prod. */
export function kind(path: string): FileKind {
  if (test.test(path)) return "test";
  if (config.test(path)) return "config";
  if (script.test(path)) return "script";
  return "prod";
}

function leaves(value: Json | undefined): string[] {
  if (value === undefined || value === null) return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap((item: Json) => leaves(item));
  if (typeof value === "object") return Object.values(value).flatMap((item) => leaves(item));
  return [];
}

function normal(path: string): string {
  return path.replace(/^\.\//, "");
}

/** The kept files that are entry points: named by package.json, or by framework and file-name convention. */
export function entries(manifest: Manifest, paths: Iterable<string>): ReadonlySet<string> {
  const bin = typeof manifest.bin === "string" ? [manifest.bin] : Object.values(manifest.bin ?? {});
  const named = new Set(
    [manifest.main, manifest.module, ...bin, ...leaves(manifest.exports)]
      .filter((path): path is string => typeof path === "string")
      .map(normal),
  );
  const found = new Set<string>();
  for (const path of paths) if (named.has(path) || conventional.test(path)) found.add(path);
  return found;
}
