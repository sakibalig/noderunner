import type { Clock } from "@noderunner/core";

/** A sliding-window rate limit per client, holding at most `clients` clients; the oldest is evicted first. */
export class Limiter {
  readonly #hits = new Map<string, number[]>();

  constructor(
    private readonly options: { readonly limit: number; readonly windowMs: number; readonly clients: number },
    private readonly clock: Clock,
  ) {}

  /** Records a hit; false when the client is over the limit. */
  take(client: string): boolean {
    const now = this.clock.now();
    const recent = (this.#hits.get(client) ?? []).filter((at) => at > now - this.options.windowMs);
    this.#hits.delete(client);
    if (recent.length >= this.options.limit) {
      this.#hits.set(client, recent);
      return false;
    }
    recent.push(now);
    this.#hits.set(client, recent);
    if (this.#hits.size > this.options.clients) {
      const oldest = this.#hits.keys().next().value;
      if (oldest !== undefined) this.#hits.delete(oldest);
    }
    return true;
  }
}
