import { z } from "zod";

export const Provider = z
  .enum(["openai", "anthropic", "gemini"])
  .describe("The LLM provider of a deployment");
export type Provider = z.infer<typeof Provider>;

/** The model a provider uses when `LLM_MODEL` is unset. */
export const defaultModels: Readonly<Record<Provider, string>> = {
  openai: "gpt-5",
  anthropic: "claude-sonnet-5-5",
  gemini: "gemini-3.1-pro-preview",
};

/** The environment variable that holds each provider's key. */
export const keyNames: Readonly<Record<Provider, "OPENAI_API_KEY" | "ANTHROPIC_API_KEY" | "GEMINI_API_KEY">> =
  {
    openai: "OPENAI_API_KEY",
    anthropic: "ANTHROPIC_API_KEY",
    gemini: "GEMINI_API_KEY",
  };

export type LlmEnv = {
  readonly LLM_PROVIDER: Provider;
  readonly LLM_MODEL?: string | undefined;
  readonly OPENAI_API_KEY?: string | undefined;
  readonly ANTHROPIC_API_KEY?: string | undefined;
  readonly GEMINI_API_KEY?: string | undefined;
};

/** The deployment's provider, model, and key; `id` is `<provider>/<model>`, as recorded on runs. */
export type Llm = {
  readonly provider: Provider;
  readonly model: string;
  readonly id: string;
  readonly key: string;
};

/** Reads the LLM settings from a parsed environment, whose schema already required the selected key. */
export function llmConfig(env: LlmEnv): Llm {
  const provider = env.LLM_PROVIDER;
  const model = env.LLM_MODEL ?? defaultModels[provider];
  return { provider, model, id: `${provider}/${model}`, key: env[keyNames[provider]] ?? "" };
}
