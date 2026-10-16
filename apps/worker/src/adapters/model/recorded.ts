import { readFile } from "node:fs/promises";
import { type Block as CoreBlock, Json, type Model, type Turn } from "@noderunner/core";
import { z } from "zod";

const Carry = z.object({ provider: z.enum(["openai", "anthropic", "gemini"]), raw: Json });
const Block = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string(), carry: Carry.optional() }),
  z.object({
    type: z.literal("tool_use"),
    id: z.string(),
    name: z.string(),
    input: Json,
    carry: Carry.optional(),
  }),
  z.object({ type: z.literal("opaque"), carry: Carry }),
]);
/** A recorded model turn; tool_result blocks never appear in a model's own turn. */
export const RecordedTurn = z.object({
  stop: z.enum(["tool_use", "end", "limit", "refusal"]),
  content: z.array(Block),
  usage: z.object({ input: z.number(), output: z.number(), cached: z.number() }),
});

/** A parsed block without the `carry: undefined` an optional field leaves behind. */
function block(parsed: z.infer<typeof Block>): CoreBlock {
  if (parsed.type === "opaque") return parsed;
  const { carry, ...rest } = parsed;
  return carry === undefined ? rest : { ...rest, carry };
}

/** Thrown when a recorded script has no turn left; only tests and replays meet it. */
export class ScriptEnded extends Error {
  constructor() {
    super("The recorded model has no turn left");
    this.name = "ScriptEnded";
  }
}

/**
 * `Model` over a fixed list of turns, for tests, the evaluation, and replaying a run with no network. Each request
 * is kept so a test can check what the loop sent.
 */
export class Recorded implements Model {
  readonly requests: Parameters<Model["turn"]>[0][] = [];
  #next = 0;

  constructor(private readonly turns: readonly Turn[]) {}

  static async load(path: string): Promise<Recorded> {
    const parsed = z.array(RecordedTurn).parse(JSON.parse(await readFile(path, "utf8")));
    return new Recorded(parsed.map((turn) => ({ ...turn, content: turn.content.map(block) })));
  }

  async turn(request: Parameters<Model["turn"]>[0], onText: (text: string) => void, signal: AbortSignal) {
    signal.throwIfAborted();
    this.requests.push(structuredClone(request));
    const turn = this.turns[this.#next];
    if (turn === undefined) throw new ScriptEnded();
    this.#next += 1;
    for (const block of turn.content) if (block.type === "text") onText(block.text);
    return turn;
  }
}
