import { limits, type ToolResult } from "@noderunner/core";

type Value = null | boolean | number | string | Value[] | { [key: string]: Value };
type Slot =
  | { readonly parent: Value[]; readonly at: number }
  | { readonly parent: { [key: string]: Value }; readonly at: string };

function copy(value: unknown): Value {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return value;
  }
  if (Array.isArray(value)) return value.map(copy);
  if (typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, copy(v)]));
  return null;
}

/** Every non-empty array and every string inside `value`, with where it sits. */
function walk(value: Value, arrays: Value[][], strings: Slot[]): void {
  if (Array.isArray(value)) {
    if (value.length > 0) arrays.push(value);
    value.forEach((item, at) => {
      if (typeof item === "string") strings.push({ parent: value, at });
      walk(item, arrays, strings);
    });
  } else if (value !== null && typeof value === "object") {
    for (const [at, item] of Object.entries(value)) {
      if (typeof item === "string") strings.push({ parent: value, at });
      walk(item, arrays, strings);
    }
  }
}

function read(slot: Slot): string {
  let value: Value | undefined;
  if (Array.isArray(slot.parent) && typeof slot.at === "number") value = slot.parent[slot.at];
  else if (!Array.isArray(slot.parent) && typeof slot.at === "string") value = slot.parent[slot.at];
  return typeof value === "string" ? value : "";
}

function halve(slot: Slot): void {
  const text = read(slot);
  const cut = `${text.slice(0, Math.floor(text.length / 2))}…`;
  if (Array.isArray(slot.parent) && typeof slot.at === "number") slot.parent[slot.at] = cut;
  else if (!Array.isArray(slot.parent) && typeof slot.at === "string") slot.parent[slot.at] = cut;
}

/**
 * What a model or an MCP client reads: the tool, whether it worked, and its summary and data, never the evidence.
 * Longer than `limits.modelChars`, the largest array in `data` loses items from its tail, and once no array is left
 * the longest string is halved, until it fits; `omitted` counts the array items removed. Deterministic.
 */
export function forModel(tool: string, result: ToolResult<unknown>): string {
  if (!result.ok) return JSON.stringify({ tool, ok: false, error: result.error });
  const data = copy(result.data);
  const body = { tool, ok: true, summary: result.summary, data };
  let omitted = 0;
  const render = () => JSON.stringify(omitted > 0 ? { ...body, omitted } : body);
  for (let text = render(); text.length > limits.modelChars; text = render()) {
    const arrays: Value[][] = [];
    const strings: Slot[] = [];
    walk(data, arrays, strings);
    const largest = arrays.sort((a, b) => JSON.stringify(b).length - JSON.stringify(a).length)[0];
    if (largest !== undefined) {
      const remove = Math.max(1, Math.ceil(largest.length / 10));
      largest.splice(largest.length - remove, remove);
      omitted += remove;
      continue;
    }
    const longest = strings.sort((a, b) => read(b).length - read(a).length)[0];
    if (longest === undefined || read(longest).length < 2) break;
    halve(longest);
  }
  return render();
}
