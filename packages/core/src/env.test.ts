import { describe, expect, it } from "vitest";
import { parseEnv } from "./env.ts";
import { EnvError } from "./errors.ts";

const token = "t".repeat(32);
const worker = {
  FALKORDB_URL: "redis://localhost:6379",
  OPENAI_API_KEY: "key-value",
  GITHUB_TOKEN: "gh-value",
  PR_TARGET_OWNER: "sakibalig",
  WORKER_TOKEN: token,
  WEB_ORIGIN: "http://localhost:3001",
};

describe("parseEnv", () => {
  it("applies defaults for the worker", () => {
    const env = parseEnv("worker", worker);
    expect(env.PORT).toBe(8787);
    expect(env.LLM_PROVIDER).toBe("openai");
    expect(env.LLM_MODEL).toBeUndefined();
    expect(env.CACHE_DIR).toBe(".cache");
  });

  it("names every bad variable in one error and never a value", () => {
    const secret = "sk-supersecret-value";
    const bad = {
      ...worker,
      WORKER_TOKEN: undefined,
      FALKORDB_URL: "http://x",
      OPENAI_API_KEY: secret,
      LLM_PROVIDER: "grok",
    };
    try {
      parseEnv("worker", bad);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(EnvError);
      expect((error as EnvError).names).toEqual(["FALKORDB_URL", "LLM_PROVIDER", "WORKER_TOKEN"]);
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

  it("requires only the selected provider's key", () => {
    const { OPENAI_API_KEY: _, ...noOpenai } = worker;
    try {
      parseEnv("worker", noOpenai);
      expect.unreachable();
    } catch (error) {
      expect((error as EnvError).names).toEqual(["OPENAI_API_KEY"]);
    }
    expect(
      parseEnv("worker", { ...noOpenai, LLM_PROVIDER: "gemini", GEMINI_API_KEY: "g" }).LLM_PROVIDER,
    ).toBe("gemini");
  });

  it("names the missing key together with every other bad variable", () => {
    const { OPENAI_API_KEY: _, WORKER_TOKEN: __, ...bad } = worker;
    try {
      parseEnv("worker", { ...bad, LLM_PROVIDER: "anthropic" });
      expect.unreachable();
    } catch (error) {
      expect((error as EnvError).names).toEqual(["ANTHROPIC_API_KEY", "WORKER_TOKEN"]);
    }
  });

  it("requires the key for eval and not for mcp or web", () => {
    const evalEnv = { FALKORDB_URL: "redis://localhost:6379", LLM_PROVIDER: "gemini" };
    expect(() => parseEnv("eval", evalEnv)).toThrow(EnvError);
    expect(
      parseEnv("mcp", { FALKORDB_URL: "redis://localhost:6379", MCP_GRAPH: "repo:acme/api" }).MCP_GRAPH,
    ).toBe("repo:acme/api");
    expect(parseEnv("web", { WORKER_URL: "http://localhost:8787", WORKER_TOKEN: token }).WORKER_URL).toBe(
      "http://localhost:8787",
    );
  });

  it("treats a blank LLM_MODEL as unset", () => {
    expect(parseEnv("worker", { ...worker, LLM_MODEL: "" }).LLM_MODEL).toBeUndefined();
  });
  it("runs the command-line triage with only FalkorDB, and an optional GitHub token", () => {
    expect(parseEnv("cli", { FALKORDB_URL: "redis://localhost:6379" })).toEqual({
      FALKORDB_URL: "redis://localhost:6379",
      LLM_PROVIDER: "openai",
      CACHE_DIR: ".cache",
    });
    expect(parseEnv("cli", { FALKORDB_URL: "redis://localhost:6379", GITHUB_TOKEN: "t" }).GITHUB_TOKEN).toBe(
      "t",
    );
    expect(() => parseEnv("cli", {})).toThrow("FALKORDB_URL");
  });
});
