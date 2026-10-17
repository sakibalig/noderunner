import { describe, expect, it } from "vitest";
import { edit } from "./edit.ts";

const manifest = (deps: Record<string, string>, indent: string | number = 2, extra: object = {}) =>
  `${JSON.stringify({ name: "app", dependencies: deps, devDependencies: { jest: "^29.0.0" }, ...extra }, null, indent)}\n`;

describe("edit", () => {
  it.each([
    ["^4.17.1", "^4.21.2"],
    ["~4.17.1", "~4.21.2"],
    ["4.17.1", "4.21.2"],
  ])("bumps %s to %s, keeping the prefix", (from, to) => {
    const out = edit(manifest({ express: from }), [{ kind: "bump", package: "express", to: "4.21.2" }]);
    expect(JSON.parse(out.manifest).dependencies.express).toBe(to);
  });

  it("bumps a dev dependency", () => {
    const out = edit(manifest({}), [{ kind: "bump", package: "jest", to: "29.7.0" }]);
    expect(JSON.parse(out.manifest).devDependencies.jest).toBe("^29.7.0");
  });

  it.each([4, "\t"])(
    "keeps %j indentation, key order, and everything outside the changed value",
    (indent) => {
      const before = manifest({ express: "^4.17.1", qs: "^6.0.0" }, indent);
      const out = edit(before, [{ kind: "bump", package: "express", to: "4.21.2" }]);
      expect(out.manifest).toBe(before.replace("^4.17.1", "^4.21.2"));
    },
  );

  it("keeps inline arrays and CRLF line endings untouched", () => {
    const before = '{\r\n  "files": ["dist", "lib"],\r\n  "dependencies": { "express": "^4.17.1" }\r\n}\r\n';
    const bumped = edit(before, [{ kind: "bump", package: "express", to: "4.21.2" }]).manifest;
    expect(bumped).toBe(before.replace("^4.17.1", "^4.21.2"));
    const pinned = edit(before, [{ kind: "override", package: "ws", to: "8.21.0" }]).manifest;
    expect(pinned.startsWith('{\r\n  "files": ["dist", "lib"],')).toBe(true);
    expect(/[^\r]\n/.test(pinned)).toBe(false);
    expect(JSON.parse(pinned).overrides).toEqual({ ws: "8.21.0" });
  });

  it("keeps a missing final newline missing", () => {
    const before = manifest({ express: "^4.17.1" }).trimEnd();
    expect(edit(before, [{ kind: "refresh", package: "qs", to: "6.7.3" }]).manifest.endsWith("}")).toBe(true);
  });

  it("creates overrides at the end and replaces an existing string override", () => {
    const created = edit(manifest({}), [{ kind: "override", package: "ws", to: "8.21.0" }]).manifest;
    expect(Object.keys(JSON.parse(created)).at(-1)).toBe("overrides");
    expect(JSON.parse(created).overrides).toEqual({ ws: "8.21.0" });
    const replaced = edit(manifest({}, 2, { overrides: { ws: "8.0.0", qs: "6.7.3" } }), [
      { kind: "override", package: "ws", to: "8.21.0" },
    ]).manifest;
    expect(JSON.parse(replaced).overrides).toEqual({ ws: "8.21.0", qs: "6.7.3" });
  });

  it("pins a direct dependency's override to the root spec, which npm requires, when the root is already fixed", () => {
    const out = edit(manifest({}, 2, { devDependencies: { ws: "8.22.0" } }), [
      { kind: "override", package: "ws", to: "8.21.0" },
    ]);
    expect(JSON.parse(out.manifest).overrides).toEqual({ ws: "$ws" });
    expect(() =>
      edit(manifest({ ws: "^8.0.0" }), [{ kind: "override", package: "ws", to: "8.21.0" }]),
    ).toThrow(expect.objectContaining({ surface: "range" }));
  });

  it("leaves the manifest identical for a refresh and lists each name once", () => {
    const before = manifest({ express: "^4.17.1" });
    const out = edit(before, [
      { kind: "refresh", package: "qs", to: "6.7.3" },
      { kind: "refresh", package: "qs", to: "6.7.3" },
    ]);
    expect(out).toEqual({ manifest: before, refresh: ["qs"] });
  });

  it.each([
    [
      "an aliased direct dependency",
      manifest({ ws: "npm:ws@8" }),
      { kind: "override" as const, package: "ws" },
    ],
    [
      "a git direct dependency",
      manifest({ ws: "github:websockets/ws" }),
      { kind: "override" as const, package: "ws" },
    ],
    ["a manifest that is not JSON", "{ nope", { kind: "bump" as const, package: "express" }],
    [
      "a range it cannot rewrite",
      manifest({ express: ">=1.0.0" }),
      { kind: "bump" as const, package: "express" },
    ],
    ["a package that is not direct", manifest({}), { kind: "bump" as const, package: "qs" }],
    [
      "a nested override",
      manifest({}, 2, { overrides: { ws: { ".": "8.0.0" } } }),
      { kind: "override" as const, package: "ws" },
    ],
  ])("refuses %s with range", (_, text, change) => {
    expect(() => edit(text, [{ ...change, to: "9.9.9" }])).toThrow(
      expect.objectContaining({ surface: "range" }),
    );
  });
});
