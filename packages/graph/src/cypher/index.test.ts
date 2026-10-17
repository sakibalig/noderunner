import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Query } from "@noderunner/core";
import { describe, expect, it } from "vitest";
import * as cypher from "./index.ts";

const folder = import.meta.dirname;
const root = join(folder, "../../../..");

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [path] : [];
  });
}

function isQuery(value: unknown): value is Query<unknown> {
  return typeof value === "object" && value !== null && "name" in value && "text" in value && "row" in value;
}

function constants(value: unknown): Query<unknown>[] {
  if (isQuery(value)) return [value];
  if (Array.isArray(value)) return value.flatMap(constants);
  if (typeof value === "object" && value !== null) return Object.values(value).flatMap(constants);
  return [];
}

const all = constants(
  Object.fromEntries(Object.entries(cypher).filter(([, value]) => typeof value !== "function")),
);

describe("cypher constants", () => {
  it("finds the constants to check", () => {
    expect(all.length).toBe(81);
  });

  it("gives every constant a unique <file>.<constant> name", () => {
    const names = all.map((q) => q.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^[a-z]+\.[A-Za-z]+$/);
  });

  it("bounds every variable-length relationship", () => {
    for (const q of all) {
      for (const match of q.text.matchAll(/\[[^\]]*\*([^\]]*)\]/g)) {
        expect(match[1], `${q.name} has an unbounded pattern`).toMatch(/^\d*\.\.\d+$/);
      }
    }
  });

  it("has no interpolation in any file under src/cypher", () => {
    for (const path of sources(folder)) {
      expect(readFileSync(path, "utf8").includes("${"), path).toBe(false);
    }
  });
});

describe("schema", () => {
  it("creates exactly the indexes in the graph contract", () => {
    const contract = readFileSync(join(root, "contracts/graph/schema.md"), "utf8");
    const listed = [...contract.matchAll(/CREATE INDEX FOR \(\w+:(\w+)\)\s+ON \(\w+\.(\w+)\)/g)].map(
      (m) => `${m[1]}.${m[2]}`,
    );
    expect(cypher.schema.repo.map((index) => `${index.label}.${index.property}`)).toEqual(listed);
  });

  it("matches each index's text to its label and property", () => {
    for (const index of [...cypher.schema.repo, ...cypher.schema.advisories]) {
      expect(index.create.text).toBe(`CREATE INDEX FOR (n:${index.label}) ON (n.${index.property})`);
    }
  });

  it("indexes PV.key and Adv.id on the advisories graph", () => {
    expect(cypher.schema.advisories.map((index) => `${index.label}.${index.property}`)).toEqual([
      "PV.key",
      "Adv.id",
    ]);
  });
});
