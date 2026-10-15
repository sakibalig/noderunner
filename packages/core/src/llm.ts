import { z } from "zod";
import type { Env } from "./env.ts";
import { EnvError } from "./errors.ts";

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

export const keyNames: Readonly<Record<Provider, "OPENAI_API_KEY" | "ANTHROPIC_API_KEY" | "GEMINI_API_KEY">> =
  {
    openai: "OPENAI_API_KEY",
    anthropic: "ANTHROPIC_API_KEY",
    gemini: "GEMINI_API_KEY",
  };

type LlmEnv = Pick<
  Env<"worker">,
  "LLM_PROVIDER" | "LLM_MODEL" | "OPENAI_API_KEY" | "ANTHROPIC_API_KEY" | "GEMINI_API_KEY"
>;

/** The deployment's provider and model; safe to log. `id` is `<provider>/<model>`, as recorded on runs. */
export type Llm = { readonly provider: Provider; readonly model: string; readonly id: string };

export function llmConfig(env: LlmEnv): Llm {
  const provider = env.LLM_PROVIDER;
  const model = env.LLM_MODEL ?? defaultModels[provider];
  return { provider, model, id: `${provider}/${model}` };
}

/** The selected provider's key, kept apart from the loggable config. @throws EnvError when it is unset. */
export function llmKey(env: LlmEnv): string {
  const name = keyNames[env.LLM_PROVIDER];
  const key = env[name];
  if (key === undefined) throw new EnvError([name]);
  return key;
}
