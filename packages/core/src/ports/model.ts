import type { Json } from "../json.ts";
import type { Provider } from "../llm.ts";

/** Provider data the loop never reads and returns to the same provider unchanged on the next turn. */
export type Carry = { readonly provider: Provider; readonly raw: Json };

/**
 * `opaque` is a standalone reasoning item (OpenAI reasoning, Anthropic thinking); `carry` on text and tool calls
 * holds data a provider attaches to them (Gemini thought signatures).
 */
export type Block =
  | { readonly type: "text"; readonly text: string; readonly carry?: Carry }
  | {
      readonly type: "tool_use";
      readonly id: string;
      readonly name: string;
      readonly input: Json;
      readonly carry?: Carry;
    }
  | {
      readonly type: "tool_result";
      readonly toolUseId: string;
      readonly name: string;
      readonly content: string;
      readonly isError: boolean;
    }
  | { readonly type: "opaque"; readonly carry: Carry };

export type Message = { readonly role: "user" | "assistant"; readonly content: readonly Block[] };

/** A tool as a model sees it; `schema` uses only objects, strings, numbers, booleans, enums, and arrays. */
export type ModelTool = { readonly name: string; readonly description: string; readonly schema: Json };

export type Turn = {
  readonly stop: "tool_use" | "end" | "limit" | "refusal";
  readonly content: readonly Block[];
  readonly usage: { readonly input: number; readonly output: number; readonly cached: number };
};

/** One provider behind one interface; the adapter owns caching, schema conversion, and stop mapping. */
export interface Model {
  readonly provider: Provider;
  turn(
    request: {
      readonly system: string;
      readonly tools: readonly ModelTool[];
      readonly messages: readonly Message[];
      readonly maxTokens: number;
    },
    onText: (text: string) => void,
    signal: AbortSignal,
  ): Promise<Turn>;
}
