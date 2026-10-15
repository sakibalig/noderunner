# LLM providers

How the agent talks to a model without depending on any one vendor. The agent loop, the eval runner, and every
test drive the `Model` port in `packages/core`; one adapter per provider translates that port to the provider's
own API. A deployment picks its provider in configuration, and switching provider changes no code outside the
adapters.

| Owner | Tasks | Layer | Depends on |
| --- | --- | --- | --- |
| Sakib | T16 (OpenAI adapter, registry); Anthropic and Gemini adapters later | Core (port, config) and adapter (`apps/worker/src/adapters/model`) | `packages/core`; `openai`, later `@anthropic-ai/sdk` and `@google/genai` |

## Decisions

| # | Decision | Why |
| --- | --- | --- |
| 1 | One provider per deployment, chosen by `LLM_PROVIDER` | Hidden reasoning cannot move between providers mid-run, and per-run choice adds UI and API work the demo does not need |
| 2 | The port supports OpenAI, Anthropic, and Gemini; only the OpenAI adapter is built before the deadline | Each further adapter is one file and about two to three hours, with no change elsewhere |
| 3 | One hand-written adapter per provider over its official SDK | The port already is the neutral layer; per-provider adapters keep reasoning pass-back, caching, and stop mapping explicit and tested. A unified SDK would be an abstraction over ours, and OpenAI-compatible endpoints drop Anthropic thinking and Gemini thought signatures |

Not included: choosing a provider per run, and falling back to another provider when one fails.

## Configuration

| Variable | Values | Default |
| --- | --- | --- |
| `LLM_PROVIDER` | `openai`, `anthropic`, `gemini` | `openai` |
| `LLM_MODEL` | any model id the provider accepts | `gpt-5`, `claude-sonnet-5-5`, `gemini-3.1-pro-preview` by provider |
| `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY` | the provider's key | — |

`parseEnv` requires only the selected provider's key and names it when it is missing. `LLM_MODEL` is a free string,
so a new model needs no code change; a wrong id fails on the first call as `upstream`. `llmConfig(env)` in
`packages/core/src/llm.ts` returns `{ provider, model, id, key }`, where `id` is `<provider>/<model>`; runs and the
`worker.started` event record that id. A cheaper model is just another `LLM_MODEL` value. The defaults were checked
against each provider's model list on 2026-10-15 and are verified again with a real key before the demo.

## The port

`packages/core/src/ports/model.ts`. The loop owns the message history, appends every block back exactly as
received, and never reads `carry`.

```ts
type Provider = "openai" | "anthropic" | "gemini";
type Carry = { provider: Provider; raw: Json };     // returned to the same provider unchanged next turn

type Block =
  | { type: "text"; text: string; carry?: Carry }
  | { type: "tool_use"; id: string; name: string; input: Json; carry?: Carry }
  | { type: "tool_result"; toolUseId: string; name: string; content: string; isError: boolean }
  | { type: "opaque"; carry: Carry };

type Turn = { stop: "tool_use" | "end" | "limit" | "refusal"; content: Block[];
              usage: { input: number; output: number; cached: number } };
// usage.input includes cached tokens; usage.output includes reasoning tokens

interface Model { turn(request, onText, signal): Promise<Turn> }
```

`tool_result` blocks follow the order of the `tool_use` blocks they answer, because Gemini matches results by name
and position. Tool input schemas use only objects, strings, numbers, booleans, enums, and arrays, with no unions or
`$ref`, which is the subset all three providers accept.

## Adapters

```text
apps/worker/src/adapters/model/
  index.ts       modelFor(llm): Model — picks the adapter for llm.provider
  openai.ts      built with T16
  anthropic.ts   later
  gemini.ts      later
  recorded.ts    replays a recorded run's turns; provider-neutral
```

`modelFor` is called once, in the composition root. A provider whose adapter is not built yet fails at start-up
with an actionable message, never at the first run.

| Concern | OpenAI | Anthropic | Gemini |
| --- | --- | --- | --- |
| API | Responses API, `responses.stream` | Messages API, `messages.stream` | `generateContentStream` |
| System prompt | `instructions` | `system` | `systemInstruction` |
| Hidden reasoning | encrypted reasoning items with `store: false` → `opaque` | thinking blocks → `opaque` | thought signatures on parts → `carry` on `text` and `tool_use` |
| Tool result | `function_call_output` by `call_id` | `tool_result` by `tool_use_id` | `functionResponse` by `name` |
| Caching | automatic for a stable prefix | `cache_control` on the last tool and on the last message, so the growing history is cached too | implicit caching |
| `end` | completed with no function call | `stop_reason: end_turn` or `stop_sequence` | `finishReason: STOP` with no function call |
| `limit` | incomplete for `max_output_tokens` | `stop_reason: max_tokens` or `model_context_window_exceeded` | `finishReason: MAX_TOKENS` |
| `refusal` | refusal content | `stop_reason: refusal` | `finishReason` `SAFETY`, `RECITATION`, `PROHIBITED_CONTENT`, `BLOCKLIST`, `SPII`, or `promptFeedback.blockReason` with no candidate |
| Any other ending | a failed or unrecognised response | an unrecognised `stop_reason` | `MALFORMED_FUNCTION_CALL`, `OTHER`, or an unrecognised reason |
| `usage.input` | `input_tokens` | `input_tokens + cache_read_input_tokens + cache_creation_input_tokens` | `promptTokenCount` |
| `usage.cached` | `input_tokens_details.cached_tokens` | `cache_read_input_tokens` | `cachedContentTokenCount` |
| `usage.output` | `output_tokens` | `output_tokens` | `candidatesTokenCount + thoughtsTokenCount` |

Any other ending is an `upstream` failure, never a guessed stop. An adapter sends only `carry` and `opaque` blocks
tagged with its own provider and drops the rest; this matters when a conversation is replayed live on a different
provider, while `recorded.ts` itself makes no call. Every adapter keeps the system prompt and tool list free of
run-specific text, so the cached prefix is shared across runs. SDK retries apply; after them a failure is
`upstream`.

## Tests

- Each adapter has a pure request builder and a pure response mapper, tested against recorded provider responses:
  text, a tool call, reasoning carried back, each stop reason, and cached-token counts.
- The agent loop's tests run on `recorded.ts` and need no key and no network.
- `llmConfig` and `parseEnv` cover the defaults, an explicit model, and a missing key for the selected provider.

## Open points

- The Anthropic and Gemini adapters are not built; adding one means its file, its SDK dependency, and a line in
  `modelFor`.
- The default model ids are verified with a real key before the demo, since provider model lists change often.
