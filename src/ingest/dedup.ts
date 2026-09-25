/**
 * Event deduplication. On (re)connect Solami replays the last `backfill` events of each type;
 * events we already delivered must not be delivered twice.
 *
 * The key was chosen from the real captures (data/*.jsonl, 181k tx events), not by intuition:
 *
 * | key                                        | swap collisions with DIFFERENT content |
 * |--------------------------------------------|----------------------------------------|
 * | signature                                  | 17,980                                 |
 * | signature + ix_index                       | 16,174                                 |
 * | signature + ix_index + inner_ix_index      |  5,868  ← one instruction, TWO swaps   |
 * | … + mint                                   |      0                                 |
 *
 * A single swap instruction is reported once per side of the pair (mint and quote_mint
 * swapped), so the instruction position alone merges two different events. Adding the mint
 * separates them. The same key is unique for transfer, token_create, pool_create and
 * liquidity (whose mint field is `base_mint`). `tx_index` adds nothing: the signature already
 * identifies the transaction.
 *
 * - graduation has no signature: `mint + slot` (unique in the data).
 * - meme, metadata and the other state/analytics types have no natural identity (even
 *   `mint + block_time` collides with different content): hash of the whole content.
 *   Verified live with two overlapping connections: backfill replays are byte-identical to
 *   the realtime originals for every backfilled type (200/200 each, incl. meme and swap).
 * - control events are never deduplicated.
 *
 * Memory: the server can only replay its last `backfill` events per type, so remembering the
 * last N ≥ backfill keys PER TYPE is enough. A global window would not be: at ~900 swaps and
 * transfers per second they would push token_create keys out within seconds.
 */
import { createHash } from 'node:crypto';
import type { SolamiEvent } from '../events/types.js';
import { TtlLruCache } from '../rest/ttl-lru-cache.js';

function contentHash(event: SolamiEvent): string {
  const text = JSON.stringify(event, function (this: unknown, key, value: unknown) {
    // `origin` and `receivedAt` differ between a backfill replay and the original.
    if (this === event && (key === 'origin' || key === 'receivedAt')) return undefined;
    return typeof value === 'bigint' ? value.toString() : value;
  });
  return createHash('sha1').update(text).digest('base64');
}

/** null = never deduplicate this event. */
export function dedupKey(event: SolamiEvent): string | null {
  switch (event.type) {
    case 'swap':
    case 'transfer':
    case 'token_create':
    case 'pool_create':
      return `${event.signature}|${event.ixIndex}|${event.innerIxIndex}|${event.mint}`;
    case 'liquidity':
      return `${event.signature}|${event.ixIndex}|${event.innerIxIndex}|${event.baseMint}`;
    case 'graduation':
      return `${event.mint}|${event.slot}`;
    case 'connected':
    case 'backfill_end':
      return null;
    default:
      return contentHash(event);
  }
}

export class DedupWindow {
  private readonly byType = new Map<string, TtlLruCache<string, true>>();

  constructor(private readonly windowPerType: number) {}

  /** true if this event was already seen (and should be dropped); records it otherwise. */
  isDuplicate(event: SolamiEvent): boolean {
    const key = dedupKey(event);
    if (key === null) return false;
    let seen = this.byType.get(event.type);
    if (seen === undefined) {
      seen = new TtlLruCache({ maxEntries: this.windowPerType, ttlMs: Infinity });
      this.byType.set(event.type, seen);
    }
    if (seen.get(key) !== undefined) return true;
    seen.set(key, true);
    return false;
  }
}
