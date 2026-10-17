import type { Message } from "@noderunner/core";
import type { Response } from "openai/resources/responses/responses";
import { describe, expect, it } from "vitest";
import { TRIAGE } from "../../agent/prompt.ts";
import { parse, request } from "./openai.ts";

const tools = [{ name: "list_alerts", description: "d", schema: { type: "object", properties: {} } }];
const reasoning = { id: "rs_1", type: "reasoning", summary: [], encrypted_content: "secret-blob" };
const fnCall = {
  id: "fc_1",
  type: "function_call",
  call_id: "call_1",
  name: "list_alerts",
  arguments: "{}",
  status: "completed",
};

function response(output: unknown[], status = "completed", reason?: string): Response {
  return {
    output,
    status,
    incomplete_details: reason === undefined ? null : { reason },
    usage: {
      input_tokens: 50,
      output_tokens: 7,
      total_tokens: 57,
      input_tokens_details: { cached_tokens: 32 },
      output_tokens_details: { reasoning_tokens: 3 },
    },
  } as unknown as Response;
}

describe("request", () => {
  it("stores nothing at OpenAI, asks for encrypted reasoning, and keeps instructions and tools identical across runs", () => {
    const one = request("gpt-5", {
      system: TRIAGE,
      tools,
      maxTokens: 16_000,
      messages: [{ role: "user", content: [{ type: "text", text: "Triage a/b." }] }],
    });
    const two = request("gpt-5", {
      system: TRIAGE,
      tools,
      maxTokens: 16_000,
      messages: [{ role: "user", content: [{ type: "text", text: "Triage c/d." }] }],
    });
    expect(one).toMatchObject({
      store: false,
      include: ["reasoning.encrypted_content"],
      max_output_tokens: 16_000,
      tool_choice: "auto",
    });
    expect(JSON.stringify([one.instructions, one.tools])).toBe(JSON.stringify([two.instructions, two.tools]));
    expect(one.tools?.[0]).toMatchObject({ type: "function", name: "list_alerts", strict: false });
  });

  it("sends no tools and no tool_choice for a turn offered no tools", () => {
    const req = request("gpt-5", {
      system: TRIAGE,
      tools: [],
      maxTokens: 16_000,
      messages: [{ role: "user", content: [{ type: "text", text: "Write the report." }] }],
    });
    expect("tools" in req || "tool_choice" in req).toBe(false);
  });

  it("sends reasoning and function calls back as they came, and tool results as function_call_output", () => {
    const history: Message[] = [
      { role: "user", content: [{ type: "text", text: "Triage a/b." }] },
      {
        role: "assistant",
        content: [
          { type: "opaque", carry: { provider: "openai", raw: reasoning } },
          {
            type: "tool_use",
            id: "call_1",
            name: "list_alerts",
            input: {},
            carry: { provider: "openai", raw: fnCall },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            toolUseId: "call_1",
            name: "list_alerts",
            content: '{"ok":true}',
            isError: false,
          },
        ],
      },
    ];
    expect(request("gpt-5", { system: "s", tools, maxTokens: 10, messages: history }).input).toEqual([
      { role: "user", content: "Triage a/b." },
      reasoning,
      fnCall,
      { type: "function_call_output", call_id: "call_1", output: '{"ok":true}' },
    ]);
  });
});

describe("parse", () => {
  it("maps reasoning to opaque and a function call to tool_use, keeping both raw", () => {
    const turn = parse(response([reasoning, fnCall]));
    expect(turn.stop).toBe("tool_use");
    expect(turn.content).toEqual([
      { type: "opaque", carry: { provider: "openai", raw: reasoning } },
      {
        type: "tool_use",
        id: "call_1",
        name: "list_alerts",
        input: {},
        carry: { provider: "openai", raw: fnCall },
      },
    ]);
    expect(turn.usage).toEqual({ input: 50, output: 7, cached: 32 });
  });

  it("drops the SDK's parsed_arguments and parsed fields, which the API rejects when they are sent back", () => {
    const streamed = { ...fnCall, parsed_arguments: {} };
    const message = {
      id: "m",
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "hi", annotations: [], parsed: null }],
    };
    const turn = parse(response([streamed, message]));
    expect(turn.content[0]).toMatchObject({ carry: { raw: fnCall } });
    expect(JSON.stringify(turn.content)).not.toMatch(/parsed/);
    const echoed = request("gpt-5", {
      system: "s",
      tools: [],
      maxTokens: 10,
      messages: [{ role: "assistant", content: turn.content }],
    });
    expect(JSON.stringify(echoed.input)).not.toMatch(/parsed/);
  });

  it("ends on a text message, stops at the output limit, and fails on a refusal", () => {
    const text = {
      id: "m",
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "report", annotations: [] }],
    };
    expect(parse(response([text])).stop).toBe("end");
    expect(parse(response([text]))?.content[0]).toMatchObject({ type: "text", text: "report" });
    expect(parse(response([text], "incomplete", "max_output_tokens")).stop).toBe("limit");
    const refusal = { ...text, content: [{ type: "refusal", refusal: "no" }] };
    expect(parse(response([refusal])).stop).toBe("refusal");
  });
});
