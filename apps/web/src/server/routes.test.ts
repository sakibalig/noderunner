import { describe, expect, it } from "vitest";
import { forwardable } from "./routes.ts";

describe("forwardable", () => {
  it.each([
    ["POST", "/repos"],
    ["GET", "/repos/acme/api/summary"],
    ["GET", "/jobs/01JQZ8/events"],
    ["POST", "/plans/01JQZ8/ship"],
    ["GET", "/healthz"],
    ["GET", "/runs/01JQZ8/plan"],
  ])("forwards %s %s", (method, path) => {
    expect(forwardable(method, path)).toBe(true);
  });

  it.each([
    ["DELETE", "/repos"],
    ["GET", "/repos/acme/api/summary/extra"],
    ["POST", "/repos/acme/api/summary"],
    ["GET", "/admin"],
    ["GET", "/jobs/../repos"],
  ])("refuses %s %s", (method, path) => {
    expect(forwardable(method, path)).toBe(false);
  });
});
