import { describe, expect, it } from "vitest";
import { entries, kind } from "./classify.ts";

describe("kind", () => {
  it.each([
    ["src/__tests__/a.ts", "test"],
    ["src/__mocks__/fs.ts", "test"],
    ["src/a.test.ts", "test"],
    ["lib/a.spec.js", "test"],
    ["test/helpers.js", "test"],
    ["tests/setup.ts", "test"],
    ["e2e/login.ts", "test"],
    ["integration/microservices/src/app.controller.ts", "test"],
    ["cypress/support/e2e.ts", "test"],
    ["playwright/home.ts", "test"],
    [".storybook/main.ts", "test"],
    ["src/button.stories.tsx", "test"],
    ["vite.config.ts", "config"],
    ["packages/web/next.config.mjs", "config"],
    [".eslintrc.js", "config"],
    ["babel.config.cjs", "config"],
    ["jest.setup.ts", "config"],
    ["scripts/release.mjs", "script"],
    ["tools/gen.ts", "script"],
    ["bench/run.js", "script"],
    ["docs/examples/ca-fingerprint/index.js", "script"],
    ["examples/basic/server.js", "script"],
    ["example/app.ts", "script"],
    ["sample/39-file-storage/src/main.ts", "script"],
    ["src/index.ts", "prod"],
    ["src/test-utils/x.ts", "prod"],
    ["src/scripts/x.ts", "prod"],
    ["packages/web/test/x.ts", "prod"],
  ])("classifies %s as %s", (path, expected) => {
    expect(kind(path)).toBe(expected);
  });
});

describe("entries", () => {
  const paths = [
    "lib/main.js",
    "lib/esm.mjs",
    "bin/cli.js",
    "lib/sub.js",
    "src/pages/home.tsx",
    "app/layout.tsx",
    "src/app/page.tsx",
    "src/index.ts",
    "index.js",
    "server.ts",
    "src/util.ts",
    "packages/web/index.ts",
  ];

  it("marks files named by package.json and by convention", () => {
    const found = entries(
      {
        main: "./lib/main.js",
        module: "lib/esm.mjs",
        bin: { cli: "./bin/cli.js" },
        exports: { ".": { import: "./lib/esm.mjs", require: "./lib/main.js" }, "./sub": "./lib/sub.js" },
      },
      paths,
    );
    expect([...found].sort()).toEqual([
      "app/layout.tsx",
      "bin/cli.js",
      "index.js",
      "lib/esm.mjs",
      "lib/main.js",
      "lib/sub.js",
      "server.ts",
      "src/app/page.tsx",
      "src/index.ts",
      "src/pages/home.tsx",
    ]);
  });

  it("accepts a string bin and ignores a main that points at build output", () => {
    expect([...entries({ bin: "bin/cli.js", main: "dist/index.js" }, ["bin/cli.js", "src/util.ts"])]).toEqual(
      ["bin/cli.js"],
    );
  });
});
