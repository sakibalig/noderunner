import { describe, expect, it } from "vitest";
import { Evidence } from "./evidence.ts";
import { limits } from "./limits.ts";

const node = (id: number) => ({ id, key: `k${id}`, label: "Install", name: `n${id}` });

describe("Evidence", () => {
  it("accepts exactly the node cap and rejects one more", () => {
    const at = Array.from({ length: limits.evidenceNodes }, (_, i) => node(i));
    expect(Evidence.safeParse({ nodes: at, edges: [], cypher: [] }).success).toBe(true);
    expect(Evidence.safeParse({ nodes: [...at, node(-0)], edges: [], cypher: [] }).success).toBe(false);
  });
});
