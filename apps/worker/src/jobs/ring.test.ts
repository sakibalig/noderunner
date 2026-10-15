import type { RunEvent } from "@noderunner/core";
import { describe, expect, it } from "vitest";
import { Ring } from "./ring.ts";

const delta = (text: string): RunEvent => ({ type: "message.delta", text });

describe("Ring", () => {
  it("numbers events from 1", () => {
    const ring = new Ring(10, 2);
    expect([ring.push(delta("a")).id, ring.push(delta("b")).id]).toEqual([1, 2]);
  });

  it("returns the events after an id", () => {
    const ring = new Ring(10, 2);
    for (const text of ["a", "b", "c"]) ring.push(delta(text));
    expect(ring.since(1)?.map((framed) => framed.id)).toEqual([2, 3]);
    expect(ring.since(3)).toEqual([]);
  });

  it("keeps only the last size events and reports a resume point that was evicted", () => {
    const ring = new Ring(2, 2);
    for (const text of ["a", "b", "c"]) ring.push(delta(text));
    expect(ring.since(0)).toBeNull();
    expect(ring.since(1)?.map((framed) => framed.id)).toEqual([2, 3]);
  });

  it("fans out to listeners until they unsubscribe", () => {
    const ring = new Ring(10, 2);
    const seen: number[] = [];
    const stop = ring.listen((framed) => seen.push(framed.id));
    ring.push(delta("a"));
    stop?.();
    ring.push(delta("b"));
    expect(seen).toEqual([1]);
  });

  it("refuses a listener over the cap", () => {
    const ring = new Ring(10, 1);
    expect(ring.listen(() => {})).not.toBeNull();
    expect(ring.listen(() => {})).toBeNull();
  });
});
