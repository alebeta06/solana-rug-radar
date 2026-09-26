/**
 * Does the memory survive a restart? Decision: YES, by replaying the persisted raw log.
 *
 * Phase 2 already writes every lifecycle event (everything except swap/transfer) to
 * `data/live/lifecycle-<UTC start>Z-<seq>.jsonl`, capped at 1 GB by default (~30 h at the
 * measured ~780 MB/day). That log IS the persistence: on a live start the last N hours are
 * replayed through the same state machine before connecting, so no second format, no snapshot
 * schema to version, no extra dependency. The store is order-independent and idempotent, so the
 * overlap between the replayed tail and the live backfill is harmless.
 *
 * Why not rely on dev-history alone: it rebuilds a creator in one call, but only once we know
 * whom to ask; after a restart we learn a serial creator again only when it launches again, and
 * our own liquidity readings (the collapse as an event in time) are not in dev-history at all.
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const FILE = /^lifecycle-(\d{8}T\d{6})Z-\d+\.jsonl$/;

function startOf(name: string): number | null {
  const match = FILE.exec(name);
  if (match?.[1] === undefined) return null;
  const s = match[1];
  return Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(9, 11), +s.slice(11, 13), +s.slice(13, 15));
}

/**
 * Lifecycle files that may hold events from the last `hours`, oldest first. A file's name is
 * its START time, so the newest file that started before the cutoff is included too.
 */
export function warmStartFiles(dir: string, hours: number, nowMs: number): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const files = names
    .map((name) => ({ name, start: startOf(name) }))
    .filter((f): f is { name: string; start: number } => f.start !== null)
    .sort((a, b) => a.start - b.start || a.name.localeCompare(b.name));
  const cutoff = nowMs - hours * 3_600_000;
  const firstInside = files.findIndex((f) => f.start >= cutoff);
  const from = firstInside === -1 ? Math.max(0, files.length - 1) : Math.max(0, firstInside - 1);
  return files.slice(from).map((f) => join(dir, f.name));
}
