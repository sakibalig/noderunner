import { describe, expect, it } from "vitest";
import { Limiter } from "./limit.ts";

function limiter(clients = 10) {
  const clock = {
    at: 0,
    now() {
      return this.at;
    },
  };
  return { clock, limiter: new Limiter({ limit: 2, windowMs: 1_000, clients }, clock) };
}

describe("Limiter", () => {
  it("allows up to the limit and refuses the next hit", () => {
    const { limiter: l } = limiter();
    expect([l.take("a"), l.take("a"), l.take("a")]).toEqual([true, true, false]);
  });

  it("counts clients separately", () => {
    const { limiter: l } = limiter();
    l.take("a");
    l.take("a");
    expect(l.take("b")).toBe(true);
  });

  it("allows again once the window has passed", () => {
    const { clock, limiter: l } = limiter();
    l.take("a");
    l.take("a");
    clock.at = 1_000;
    expect(l.take("a")).toBe(true);
  });

  it("evicts the oldest client when full", () => {
    const { limiter: l } = limiter(1);
    l.take("a");
    l.take("a");
    l.take("b");
    expect(l.take("a")).toBe(true);
  });
});
