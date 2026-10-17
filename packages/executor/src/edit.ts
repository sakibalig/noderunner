import type { Upgrade } from "@noderunner/core";
import semver from "semver";
import { ExecutorError } from "./errors.ts";

type Change = Pick<Upgrade, "kind" | "package" | "to">;
type Json = { [key: string]: unknown };

const sections = ["dependencies", "devDependencies", "optionalDependencies"] as const;
const plain = /^([\^~]?)\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Pure: applies bumps and overrides to `package.json` text, keeping its indentation, key order, and final newline. */
export function edit(
  manifest: string,
  upgrades: readonly Change[],
): { readonly manifest: string; readonly refresh: readonly string[] } {
  const parsed: unknown = JSON.parse(manifest);
  if (!isObject(parsed)) throw new ExecutorError("executor.range", "package.json is not an object");
  const refresh: string[] = [];
  for (const u of upgrades) {
    if (u.kind === "refresh") refresh.push(u.package);
    else if (u.kind === "bump") bump(parsed, u);
    else override(parsed, u);
  }
  const indent = /^\{\r?\n([ \t]+)"/.exec(manifest)?.[1] ?? "  ";
  const text = JSON.stringify(parsed, null, indent);
  return { manifest: manifest.endsWith("\n") ? `${text}\n` : text, refresh: [...new Set(refresh)] };
}

function bump(manifest: Json, u: Change): void {
  const section = sections.map((name) => manifest[name]).find((s) => isObject(s) && u.package in s);
  if (!isObject(section))
    throw new ExecutorError("executor.range", `${u.package} is not a direct dependency to bump`);
  const spec = section[u.package];
  const match = typeof spec === "string" ? plain.exec(spec) : null;
  if (match === null)
    throw new ExecutorError("executor.range", `${u.package} has a range the executor cannot rewrite`);
  section[u.package] = `${match[1]}${u.to}`;
}

function override(manifest: Json, u: Change): void {
  const existing = manifest.overrides;
  if (existing !== undefined && !isObject(existing))
    throw new ExecutorError("executor.range", "package.json has an overrides field that is not an object");
  const overrides = existing ?? {};
  if (isObject(overrides[u.package]))
    throw new ExecutorError("executor.range", `${u.package} already has a nested override`);
  overrides[u.package] = direct(manifest, u) ?? u.to;
  manifest.overrides = overrides;
}

/**
 * npm refuses an override that conflicts with a direct dependency (EOVERRIDE), so a direct one is pinned with `$name`,
 * npm's reference to the root's own spec, when that spec already starts at or above the fixed version.
 */
function direct(manifest: Json, u: Change): string | null {
  const specs = sections.flatMap((name) => {
    const section = manifest[name];
    const spec = isObject(section) ? section[u.package] : undefined;
    return typeof spec === "string" ? [spec] : [];
  });
  if (specs.length === 0) return null;
  const floor = specs.map((spec) => semver.minVersion(spec));
  if (floor.some((v) => v === null || semver.lt(v, u.to)))
    throw new ExecutorError(
      "executor.range",
      `${u.package} is a direct dependency below ${u.to}; bump it instead`,
    );
  return `$${u.package}`;
}
