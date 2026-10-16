import { type Block, Fault, Json, type Model, type Turn } from "@noderunner/core";
import OpenAI from "openai";
import type {
  Response,
  ResponseCreateParamsStreaming,
  ResponseInputItem,
} from "openai/resources/responses/responses";

type Request = Parameters<Model["turn"]>[0];

/** The model provider failed after the SDK's own retries. */
export class ModelError extends Fault {
  readonly code = "model.upstream";
  readonly surface = "upstream";
}

/**
 * Re-sends an item the provider returned, unchanged. The item came from OpenAI's own response and was kept as JSON,
 * so it is the provider's shape by construction.
 */
function echo(raw: Json): ResponseInputItem {
  return raw as unknown as ResponseInputItem;
}

/** The Responses request for one turn: no conversation stored on OpenAI's side, reasoning returned encrypted. */
export function request(model: string, req: Request): Omit<ResponseCreateParamsStreaming, "stream"> {
  const input: ResponseInputItem[] = [];
  for (const message of req.messages) {
    for (const block of message.content) {
      if (block.type === "opaque") input.push(echo(block.carry.raw));
      else if (block.type === "tool_result") {
        input.push({ type: "function_call_output", call_id: block.toolUseId, output: block.content });
      } else if (block.type === "tool_use") {
        input.push(
          block.carry?.provider === "openai"
            ? echo(block.carry.raw)
            : {
                type: "function_call",
                call_id: block.id,
                name: block.name,
                arguments: JSON.stringify(block.input),
              },
        );
      } else if (block.carry?.provider === "openai") {
        input.push(echo(block.carry.raw));
      } else {
        input.push({ role: message.role, content: block.text });
      }
    }
  }
  return {
    model,
    instructions: req.system,
    input,
    tools: req.tools.map((tool) => ({
      type: "function" as const,
      name: tool.name,
      description: tool.description,
      parameters: tool.schema as Record<string, unknown>,
      strict: false,
    })),
    tool_choice: "auto",
    max_output_tokens: req.maxTokens,
    store: false,
    include: ["reasoning.encrypted_content"],
  };
}

/** The core Turn for a finished response; every item the loop must send back keeps its raw form. */
export function parse(response: Response): Turn {
  const content: Block[] = [];
  let refused = false;
  for (const item of response.output) {
    const raw = Json.parse(JSON.parse(JSON.stringify(item)));
    if (item.type === "reasoning") {
      content.push({ type: "opaque", carry: { provider: "openai", raw } });
    } else if (item.type === "function_call") {
      let input: Json = {};
      try {
        input = Json.parse(JSON.parse(item.arguments || "{}"));
      } catch {
        input = { unparsed: item.arguments };
      }
      content.push({
        type: "tool_use",
        id: item.call_id,
        name: item.name,
        input,
        carry: { provider: "openai", raw },
      });
    } else if (item.type === "message") {
      const text = item.content.map((part) => (part.type === "output_text" ? part.text : "")).join("");
      if (item.content.some((part) => part.type === "refusal")) refused = true;
      if (text !== "") content.push({ type: "text", text, carry: { provider: "openai", raw } });
    }
  }
  const usage = {
    input: response.usage?.input_tokens ?? 0,
    output: response.usage?.output_tokens ?? 0,
    cached: response.usage?.input_tokens_details?.cached_tokens ?? 0,
  };
  const stop: Turn["stop"] = refused
    ? "refusal"
    : content.some((b) => b.type === "tool_use")
      ? "tool_use"
      : response.status === "incomplete" && response.incomplete_details?.reason === "max_output_tokens"
        ? "limit"
        : "end";
  return { stop, content, usage };
}

/** `Model` over OpenAI's Responses API, streaming text deltas as they arrive. */
export class OpenAIModel implements Model {
  readonly #client: OpenAI;

  constructor(
    key: string,
    private readonly model: string,
  ) {
    this.#client = new OpenAI({ apiKey: key });
  }

  async turn(req: Request, onText: (text: string) => void, signal: AbortSignal): Promise<Turn> {
    try {
      const stream = this.#client.responses.stream(request(this.model, req), { signal });
      stream.on("response.output_text.delta", (event) => onText(event.delta));
      return parse(await stream.finalResponse());
    } catch (error) {
      if (signal.aborted) throw error;
      const status = error instanceof OpenAI.APIError ? ` (${error.status})` : "";
      throw new ModelError(`The model provider failed${status}`);
    }
  }
}
