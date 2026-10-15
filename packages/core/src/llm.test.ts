import { describe, expect, it } from "vitest";
import { llmConfig } from "./llm.ts";

describe("llmConfig", () => {
  it("uses the provider's default model when none is set", () => {
    expect(llmConfig({ LLM_PROVIDER: "gemini", GEMINI_API_KEY: "g" })).toEqual({
      provider: "gemini",
      model: "gemini-3.1-pro-preview",
      id: "gemini/gemini-3.1-pro-preview",
      key: "g",
    });
  });

  it("uses LLM_MODEL and the selected provider's key only", () => {
    const llm = llmConfig({
      LLM_PROVIDER: "anthropic",
      LLM_MODEL: "claude-opus-5-5",
      OPENAI_API_KEY: "o",
      ANTHROPIC_API_KEY: "a",
    });
    expect([llm.id, llm.key]).toEqual(["anthropic/claude-opus-5-5", "a"]);
  });
});
