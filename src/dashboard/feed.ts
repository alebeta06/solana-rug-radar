/**
 * What the dashboard remembers of the detector's output: the latest alerts and confirmed rugs,
 * bounded like everything else. Fed by the detector's sink; live, also seeded from the registry at
 * startup (so a restart shows the last days' evidence, not an empty screen).
 *
 * The detector keeps its own memory for its rules; this is only what the screen draws.
 */
import type { Alert, DetectorRecord, RugMechanism, RugRecord } from '../detector/types.js';

export class Feed {
  /** id → alert, insertion order = arrival order. */
  readonly alerts = new Map<string, Alert>();
  /** mint → rug. */
  readonly rugs = new Map<string, RugRecord>();
  /** Alert ids some rug confirmed (kept while the alert is kept). */
  private readonly confirmedIds = new Set<string>();
  /** Counted over everything seen, not only what is still kept. */
  private rugsSeen = 0;
  private warnedRugs = 0;
  private readonly unwarnedByMechanism: Partial<Record<RugMechanism, number>> = {};

  constructor(private readonly maxRecords = 5000) {}

  load(records: Iterable<DetectorRecord>): void {
    for (const r of records) this.add(r);
  }

  add(r: DetectorRecord): void {
    if (r.kind === 'alert') {
      if (this.alerts.has(r.id)) return;
      this.alerts.set(r.id, r);
      this.trim(this.alerts, (id) => this.confirmedIds.delete(id));
      return;
    }
    if (this.rugs.has(r.mint)) return;
    this.rugs.set(r.mint, r);
    this.trim(this.rugs);
    this.rugsSeen += 1;
    if (r.alerts.length > 0) this.warnedRugs += 1;
    else this.unwarnedByMechanism[r.mechanism] = (this.unwarnedByMechanism[r.mechanism] ?? 0) + 1;
    for (const a of r.alerts) if (this.alerts.has(a.id)) this.confirmedIds.add(a.id);
  }

  isConfirmed(alertId: string): boolean {
    return this.confirmedIds.has(alertId);
  }

  counts(): { rugs: number; warned: number; unwarnedByMechanism: Partial<Record<RugMechanism, number>> } {
    return { rugs: this.rugsSeen, warned: this.warnedRugs, unwarnedByMechanism: { ...this.unwarnedByMechanism } };
  }

  private trim<K, V>(map: Map<K, V>, onEvict?: (key: K) => void): void {
    for (const oldest of map.keys()) {
      if (map.size <= this.maxRecords) break;
      map.delete(oldest);
      onEvict?.(oldest);
    }
  }
}
