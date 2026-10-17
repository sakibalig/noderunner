import type { Upgrade } from "@noderunner/core";
import { applyEdits, type FormattingOptions, modify, type ParseError, parse } from "jsonc-parser";
import semver from "semver";
import { ExecutorError } from "./errors.ts";

type Change = Pick<Upgrade, "kind" | "package" | "to">;
type Json = { [key: string]: unknown };

const sections = ["dependencies", "devDependencies", "optionalDependencies"] as const;
const plain = /^([\^~]?)\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Pure: applies bumps and overrides to `package.json` text. Only the changed values are spliced in, so every other
 * byte, including inline arrays, indentation, line endings, and the final newline, stays as it was.
 */
export function edit(
  manifest: string,
  upgrades: readonly Change[],
): { readonly manifest: string; readonly refresh: readonly string[] } {
  const errors: ParseError[] = [];
  const parsed: unknown = parse(manifest, errors, { disallowComments: true, allowTrailingComma: false });
  if (errors.length > 0 || !isObject(parsed))
    throw new ExecutorError("executor.range", "package.json is not a JSON object");
  const indent = /^\{\r?\n([ \t]+)"/.exec(manifest)?.[1] ?? "  ";
  const formattingOptions: FormattingOptions = {
    insertSpaces: !indent.includes("\t"),
    tabSize: indent.includes("\t") ? 1 : indent.length,
    eol: manifest.includes("\r\n") ? "\r\n" : "\n",
  };
  let text = manifest;
  const set = (path: string[], value: string) => {
    text = applyEdits(text, modify(text, path, value, { formattingOptions }));
  };
  const refresh: string[] = [];
  for (const u of upgrades) {
    if (u.kind === "refresh") refresh.push(u.package);
    else if (u.kind === "bump") {
      const [section, value] = bump(parsed, u);
      set([section, u.package], value);
    } else set(["overrides", u.package], override(parsed, u));
  }
  return { manifest: text, refresh: [...new Set(refresh)] };
}

function bump(manifest: Json, u: Change): [string, string] {
  const name = sections.find((s) => {
    const section = manifest[s];
    return isObject(section) && u.package in section;
  });
  const section = name === undefined ? undefined : manifest[name];
  if (name === undefined || !isObject(section))
    throw new ExecutorError("executor.range", `${u.package} is not a direct dependency to bump`);
  const spec = section[u.package];
  const match = typeof spec === "string" ? plain.exec(spec) : null;
  if (match === null || semver.valid(u.to) === null)
    throw new ExecutorError("executor.range", `${u.package} has a range the executor cannot rewrite`);
  return [name, `${match[1]}${u.to}`];
}

function override(manifest: Json, u: Change): string {
  const existing = manifest.overrides;
  if (existing !== undefined && !isObject(existing))
    throw new ExecutorError("executor.range", "package.json has an overrides field that is not an object");
  if (isObject(existing) && isObject(existing[u.package]))
    throw new ExecutorError("executor.range", `${u.package} already has a nested override`);
  if (semver.valid(u.to) === null)
    throw new ExecutorError("executor.range", `${u.to} is not a version the executor can pin`);
  return direct(manifest, u) ?? u.to;
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
  const below = specs.some((spec) => {
    if (semver.validRange(spec) === null) return true;
    const floor = semver.minVersion(spec);
    return floor === null || semver.lt(floor, u.to);
  });
  if (below)
    throw new ExecutorError(
      "executor.range",
      `${u.package} is a direct dependency below ${u.to}; bump it instead`,
    );
  return `$${u.package}`;
}
