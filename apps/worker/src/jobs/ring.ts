import type { RunEvent } from "@noderunner/core";

/** An event with its per-stream sequence number. */
export type Framed = { readonly id: number; readonly event: RunEvent };

type Listener = (framed: Framed) => void;

/** The last `size` events of one run or job, fanned out to at most `subscribers` listeners. */
export class Ring {
  readonly #size: number;
  readonly #subscribers: number;
  readonly #frames: Framed[] = [];
  readonly #listeners = new Set<Listener>();
  #next = 1;

  constructor(size: number, subscribers: number) {
    this.#size = size;
    this.#subscribers = subscribers;
  }

  push(event: RunEvent): Framed {
    const framed = { id: this.#next++, event };
    this.#frames.push(framed);
    if (this.#frames.length > this.#size) this.#frames.shift();
    for (const listener of this.#listeners) listener(framed);
    return framed;
  }

  /**
   * Hands an event to current listeners without storing it, under the last stored id, so a late or reconnecting
   * subscriber never loses stored events to a flood of transient ones (streamed text).
   */
  pass(event: RunEvent): void {
    const framed = { id: this.#next - 1, event };
    for (const listener of this.#listeners) listener(framed);
  }

  /** Events after `id`, or null when some of them were already evicted; `retained` then has what is left. */
  since(id: number): readonly Framed[] | null {
    const first = this.#frames[0]?.id ?? this.#next;
    if (id + 1 < first) return null;
    return this.#frames.filter((framed) => framed.id > id);
  }

  retained(): readonly Framed[] {
    return [...this.#frames];
  }

  /** @returns An unsubscribe function, or null when the stream already has its maximum of listeners. */
  listen(listener: Listener): (() => void) | null {
    if (this.#listeners.size >= this.#subscribers) return null;
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}
