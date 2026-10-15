import { describe, expect, it } from "vitest";
import { parseEnv } from "./env.ts";
import { EnvError } from "./errors.ts";

const token = "t".repeat(32);
const worker = {
  FALKORDB_URL: "redis://localhost:6379",
  ANTHROPIC_API_KEY: "key-value",
  GITHUB_TOKEN: "gh-value",
  PR_TARGET_OWNER: "sakibalig",
  WORKER_TOKEN: token,
  WEB_ORIGIN: "http://localhost:3001",
};

describe("parseEnv", () => {
  it("applies defaults for the worker", () => {
    const env = parseEnv("worker", worker);
    expect(env.PORT).toBe(8787);
    expect(env.MODEL).toBe("claude-opus-5-5");
    expect(env.CACHE_DIR).toBe(".cache");
  });

  it("names every bad variable in one error and never a value", () => {
    const secret = "sk-supersecret-value";
    const bad = {
      ...worker,
      WORKER_TOKEN: undefined,
      FALKORDB_URL: "http://x",
      ANTHROPIC_API_KEY: secret,
      MODEL: "gpt",
    };
    try {
      parseEnv("worker", bad);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(EnvError);
      expect((error as EnvError).names).toEqual(["FALKORDB_URL", "MODEL", "WORKER_TOKEN"]);
      expect((error as EnvError).message).not.toContain(secret);
    }
  });

  it("treats an empty string as unset", () => {
    expect(() => parseEnv("worker", { ...worker, GITHUB_TOKEN: "" })).toThrow(EnvError);
  });

  it("maps MCP_ALLOW_WRITES to a boolean and rejects anything but true or false", () => {
    const mcp = { FALKORDB_URL: "redis://localhost:6379", MCP_GRAPH: "repo:acme/api" };
    expect(parseEnv("mcp", mcp).MCP_ALLOW_WRITES).toBe(false);
    expect(parseEnv("mcp", { ...mcp, MCP_ALLOW_WRITES: "true" }).MCP_ALLOW_WRITES).toBe(true);
    expect(() => parseEnv("mcp", { ...mcp, MCP_ALLOW_WRITES: "yes" })).toThrow(EnvError);
  });

  it("requires MCP_TOKEN when MCP serves HTTP", () => {
    const mcp = { FALKORDB_URL: "redis://localhost:6379", MCP_GRAPH: "repo:acme/api", MCP_HTTP_PORT: "8788" };
    expect(() => parseEnv("mcp", mcp)).toThrow(EnvError);
    expect(parseEnv("mcp", { ...mcp, MCP_TOKEN: token }).MCP_HTTP_PORT).toBe(8788);
  });

  it("refuses an MCP graph that is not a repository graph", () => {
    expect(() =>
      parseEnv("mcp", { FALKORDB_URL: "redis://localhost:6379", MCP_GRAPH: "advisories" }),
    ).toThrow(EnvError);
  });
});
