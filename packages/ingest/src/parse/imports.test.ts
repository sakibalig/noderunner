import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { imports } from "./imports.ts";

const dir = join(import.meta.dirname, "../../../../fixtures/imports");
const read = (name: string) => imports(name, readFileSync(join(dir, name), "utf8"));

describe("imports", () => {
  it.each([
    ["esm.ts", ["lodash", "./util.js", "@scope/pkg/sub", "./side"]],
    ["cjs.js", ["express", "./helper"]],
    ["dynamic.mjs", ["chalk", "./lazy.js"]],
    ["reexport.ts", ["./util", "zod"]],
    ["equals.ts", ["fs", "qs"]],
    ["types.ts", []],
    ["view.tsx", ["react"]],
    ["widget.jsx", ["preact"]],
  ])("parses %s", (name, expected) => {
    expect(read(name)).toEqual({ sources: expected, parsed: "ast" });
  });

  it("falls back to the regex for a file that does not parse", () => {
    expect(read("broken.ts")).toEqual({ sources: ["lodash", "express"], parsed: "regex" });
  });

  it("keeps the fallback to real import statements and calls, in order", () => {
    const text = [
      "import type { T } from 'types-only';",
      "import { a } from 'first';",
      "class K { [X](@Query('q') from: string, other: string) {} }",
      "const = ;",
      "export { b } from './second';",
      "import 'third';",
      "const c = require('fourth');",
    ].join("\n");
    expect(imports("a.ts", text)).toEqual({
      sources: ["first", "./second", "third", "fourth"],
      parsed: "regex",
    });
  });

  it("reports each source once and ignores a require with a computed argument", () => {
    const text = 'import a from "x";\nimport b from "x";\nconst n = "y";\nrequire(n);\nrequire("z" + n);';
    expect(imports("a.ts", text)).toEqual({ sources: ["x"], parsed: "ast" });
  });

  it("keeps a TypeScript generic arrow in a .ts file, where JSX would not parse", () => {
    expect(imports("a.ts", 'import q from "q";\nexport const id = <T,>(v: T) => v;').sources).toEqual(["q"]);
  });

  it("finds imports nested inside functions and conditionals", () => {
    const text = 'export function f(on) {\n  if (on) {\n    return require("deep");\n  }\n}';
    expect(imports("a.cjs", text).sources).toEqual(["deep"]);
  });
});
