/**
 * Events that arrived before their token (out of order). A `liquidity` or `pool_create` names
 * two mints and we only follow launches, so an event whose mints are both unknown is either
 * about a token we don't follow (~90% of `liquidity` in the real capture) or about one whose
 * `token_create` is still to come (reconnect backfill). It is held briefly under each candidate
 * mint and released if that token appears; otherwise it expires. Bounded in mints and per mint.
 */
export interface PendingOptions {
  readonly maxMints: number;
  readonly maxEventsPerMint: number;
  readonly ttlSeconds: number;
}

export class PendingEvents<E> {
  held = 0;
  released = 0;
  expired = 0;
  /** Map order = order of first hold, so the first entry is always the oldest. */
  private readonly byMint = new Map<string, { readonly since: number; readonly events: E[] }>();

  constructor(private readonly options: PendingOptions) {}

  get mints(): number {
    return this.byMint.size;
  }

  hold(mints: readonly string[], event: E, at: number): void {
    for (const mint of mints) {
      let entry = this.byMint.get(mint);
      if (entry === undefined) {
        entry = { since: at, events: [] };
        this.byMint.set(mint, entry);
        if (this.byMint.size > this.options.maxMints) this.dropOldest();
      }
      if (entry.events.length >= this.options.maxEventsPerMint) {
        entry.events.shift();
        this.expired += 1;
      }
      entry.events.push(event);
      this.held += 1;
    }
  }

  take(mint: string): E[] {
    const entry = this.byMint.get(mint);
    if (entry === undefined) return [];
    this.byMint.delete(mint);
    this.released += entry.events.length;
    return entry.events;
  }

  expire(now: number): void {
    for (const [mint, entry] of this.byMint) {
      if (now - entry.since <= this.options.ttlSeconds) break;
      this.byMint.delete(mint);
      this.expired += entry.events.length;
    }
  }

  private dropOldest(): void {
    for (const [mint, entry] of this.byMint) {
      this.byMint.delete(mint);
      this.expired += entry.events.length;
      return;
    }
  }
}
