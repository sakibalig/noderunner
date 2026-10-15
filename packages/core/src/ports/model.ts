import type { Json } from "../json.ts";

/** `opaque` holds a reasoning item, returned to the model unchanged. */
export type Block =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "tool_use"; readonly id: string; readonly name: string; readonly input: Json }
  | {
      readonly type: "tool_result";
      readonly toolUseId: string;
      readonly content: string;
      readonly isError: boolean;
    }
  | { readonly type: "opaque"; readonly raw: Json };

export type Message = { readonly role: "user" | "assistant"; readonly content: readonly Block[] };

export type ModelTool = { readonly name: string; readonly description: string; readonly schema: Json };

export type Turn = {
  readonly stop: "tool_use" | "end" | "limit" | "refusal";
  readonly content: readonly Block[];
  readonly usage: { readonly input: number; readonly output: number };
};

export interface Model {
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
