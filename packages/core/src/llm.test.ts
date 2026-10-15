import { describe, expect, it } from "vitest";
import { EnvError } from "./errors.ts";
import { llmConfig, llmKey } from "./llm.ts";

describe("llmConfig", () => {
  it("uses the provider's default model when none is set", () => {
    expect(llmConfig({ LLM_PROVIDER: "gemini" })).toEqual({
      provider: "gemini",
      model: "gemini-3.1-pro-preview",
      id: "gemini/gemini-3.1-pro-preview",
    });
  });

  it("uses LLM_MODEL when set and never carries a key", () => {
    const llm = llmConfig({
      LLM_PROVIDER: "anthropic",
      LLM_MODEL: "claude-opus-5-5",
      ANTHROPIC_API_KEY: "a",
    });
    expect(llm).toEqual({ provider: "anthropic", model: "claude-opus-5-5", id: "anthropic/claude-opus-5-5" });
  });
});

describe("llmKey", () => {
  it("returns only the selected provider's key", () => {
    expect(llmKey({ LLM_PROVIDER: "anthropic", OPENAI_API_KEY: "o", ANTHROPIC_API_KEY: "a" })).toBe("a");
  });

  it("fails fast naming the key when it is unset", () => {
    expect(() => llmKey({ LLM_PROVIDER: "gemini", OPENAI_API_KEY: "o" })).toThrow(EnvError);
  });
});
