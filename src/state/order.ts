/**
 * Event ordering independent of arrival order.
 *
 * A reconnect backfill delivers old events after newer ones, and a replay of the two persisted
 * tiers is not time-ordered either. So the state never trusts arrival order: every update that
 * can be superseded carries its on-chain POSITION, and an older position never overwrites a newer
 * one. For transaction events the position is exact (slot, tx index, instruction, inner
 * instruction); `meme`/`graduation` only have a block time, so they get a coarser position.
 */
import { secondsValue, type UnixSeconds } from '../core/time.js';

/** [blockTime, slot, txIndex, ixIndex, innerIxIndex]; compared lexicographically. */
export type Position = readonly [number, number, number, number, number];

export function txPosition(e: {
  readonly blockTime: UnixSeconds;
  readonly slot: number;
  readonly txIndex: number;
  readonly ixIndex: number;
  readonly innerIxIndex: number;
}): Position {
  return [secondsValue(e.blockTime), e.slot, e.txIndex, e.ixIndex, e.innerIxIndex];
}

/** For events that only carry a block time (and for REST observations). */
export function timePosition(t: UnixSeconds): Position {
  return [secondsValue(t), 0, 0, 0, 0];
}

export function comparePositions(a: Position, b: Position): number {
  for (let i = 0; i < a.length; i += 1) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
