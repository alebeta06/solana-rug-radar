/** Builds the phase-4 detector from the validated config. */
import type { AppConfig } from '../config.js';
import { secondsValue } from '../core/time.js';
import type { StateStore } from '../state/store.js';
import { Detector, type DetectorSink } from './detector.js';
import type { DetectorRecord } from './types.js';

export function createDetector(config: AppConfig, store: StateStore, sink: DetectorSink): Detector {
  const d = config.detection;
  return new Detector(
    {
      collapse: d.liquidityCollapse,
      fingerprint: d.fingerprint,
      liveResolveSeconds: d.liveResolveMinutes * 60,
      maxRememberedMints: d.maxRememberedMints,
      maxRememberedCreators: d.maxRememberedCreators,
    },
    sink,
    () => (store.watermark === null ? 0 : secondsValue(store.watermark)),
  );
}

/** One human line per record for the console; the structured record goes to the registry. */
export function describeRecord(r: DetectorRecord): string {
  const time = (s: number) => new Date(s * 1000).toISOString().slice(0, 19).replace('T', ' ');
  if (r.kind === 'alert') {
    const why =
      'fingerprint' in r.evidence
        ? `creator added ${r.evidence.quoteAmount} ${r.evidence.quoteMint.startsWith('So111') ? 'SOL' : r.evidence.quoteMint}${r.evidence.fingerprint ? ' [85-SOL fingerprint]' : ''}`
        : `creator already drained ${r.evidence.priorRugCount} token(s), last ${r.evidence.priorRugs[0]?.mint ?? '?'}`;
    return `[ALERT ${r.level.toUpperCase()}] ${time(r.at)} ${r.mint} — ${why} — precision ${(100 * r.confidence.precision).toFixed(1)}% (${r.confidence.confirmed}/${r.confidence.fired})${r.origin === 'realtime' ? '' : ` (${r.origin})`} ${r.url}`;
  }
  const confirms = r.alerts.map((a) => `${a.level} alert ${a.leadSeconds} s earlier`).join(', ');
  return `[RUG] ${time(r.at)} ${r.mint} — ${r.mechanism} by ${r.trigger.actor.slice(0, 8)}… ($${r.peakUsd} → $${r.lastUsd})${confirms ? ` — confirms ${confirms}` : ''} ${r.url}`;
}
