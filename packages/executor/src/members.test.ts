import { describe, expect, it } from "vitest";
import { members } from "./ship.ts";

const lock = (paths: string[]) =>
  JSON.stringify({ lockfileVersion: 3, packages: Object.fromEntries(paths.map((p) => [p, {}])) });

describe("members", () => {
  it("lists workspace packages and skips the root and installs", () => {
    expect(
      members(
        lock(["", "packages/core", "node_modules/qs", "packages/core/node_modules/ws", "packages/@scope/x"]),
      ),
    ).toEqual(["packages/core", "packages/@scope/x"]);
  });

  it.each(["../etc", "packages/../../x", "/abs"])("refuses %j, which leaves the repository", (path) => {
    expect(() => members(lock([path]))).toThrow(expect.objectContaining({ code: "executor.unsupported" }));
  });
});
