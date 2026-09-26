/**
 * The detector (phase 4). Listens to the store (it hears an event only after the store applied
 * it, including events released from the pending buffer) and emits structured records.
 *
 * Rules come from the calibration on the 2026-09-26 night capture (docs/ANALISIS_calibracion.md),
 * not from the original prompt. Both use the stream only: no REST, no API key beyond the stream.
 *
 * RED   creator-adds-liquidity  `liquidity` add whose provider is the token's creator. No threshold:
 *                               it is a fact of the event. 422/431 confirmed (97.9 %), 431 wallets,
 *                               lead p5 189 s, p50 485 s.
 * AMBER repeat-rugger           a token graduates and its creator already drained another token
 *                               earlier (a confirmed rug below). 359/435 (82.5 %), lead p50 129 s.
 * RUG   (confirmation)          a graduated token's TRADABLE liquidity reached the configured peak
 *                               and fell to the floor (`detection.liquidityCollapse`).
 *
 * Tried and DISCARDED with data (kept out on purpose, see README "Signals we dropped"): sell share
 * (the red signal seen from another angle; inverted with the corrected metric), repeated final
 * liquidity (final is ~0), name reuse (52 % vs 50 %), bundlers_count (0–2 in both groups),
 * "> 10 launches / 24 h" alone (1.0 % precision) and graduation speed.
 *
 * Not seen in advance (limitation, in the README): dev dumps and migration pulls by first-time
 * ruggers. Their event IS the drain; they are only confirmed as rugs, and feed the amber rule.
 */
import type { Decimal } from 'decimal.js';
import { millisValue, secondsValue } from '../core/time.js';
import type { GraduationEvent, LiquidityEvent, SwapEvent } from '../events/types.js';
import { toUnits, WRAPPED_SOL } from '../state/quote-prices.js';
import type { StoreListener } from '../state/store.js';
import { tradableLiquidityUsd } from '../state/token-state.js';
import type { TokenState } from '../state/types.js';
import {
  tokenUrl,
  type Alert,
  type AlertLevel,
  type ChainRef,
  type Confidence,
  type DetectorRecord,
  type DetectorStats,
  type LevelStats,
  type RugMechanism,
  type RugRecord,
} from './types.js';

const MEASURED_ON = '2026-09-26 night capture, 10.3 h (docs/ANALISIS_calibracion.md)';
/** Per-level precision, measured separately. Never averaged: an alert carries its own rule's number. */
export const CONFIDENCE: Readonly<Record<AlertLevel, Confidence>> = {
  red: { precision: 422 / 431, confirmed: 422, fired: 431, measuredOn: MEASURED_ON },
  amber: { precision: 359 / 435, confirmed: 359, fired: 435, measuredOn: MEASURED_ON },
};
const MAX_PRIOR_RUGS_SHOWN = 5;

export interface DetectorOptions {
  readonly collapse: { readonly minPeakUsd: Decimal; readonly maxLiquidityUsd: Decimal };
  readonly fingerprint: { readonly minSol: Decimal; readonly maxSol: Decimal };
  readonly liveResolveSeconds: number;
  readonly maxRememberedMints: number;
  readonly maxRememberedCreators: number;
}

export interface DetectorSink {
  (record: DetectorRecord): void;
}

interface PriorRug {
  readonly mint: string;
  readonly at: number;
  readonly mechanism: RugMechanism;
}

/** Map with insertion-order eviction: the detector's memory is bounded like everything else. */
function boundedSet<K, V>(map: Map<K, V>, key: K, value: V, max: number): void {
  map.delete(key);
  map.set(key, value);
  for (const oldest of map.keys()) {
    if (map.size <= max) break;
    map.delete(oldest);
  }
}

const chainRef = (e: LiquidityEvent | SwapEvent | GraduationEvent): ChainRef =>
  e.type === 'graduation'
    ? { signature: null, slot: e.slot, txIndex: null, ixIndex: null, innerIxIndex: null }
    : { signature: e.signature, slot: e.slot, txIndex: e.txIndex, ixIndex: e.ixIndex, innerIxIndex: e.innerIxIndex };

export class Detector implements StoreListener {
  /** id (`level:mint`) → the alert and, once confirmed, its rug time. */
  private readonly alerts = new Map<string, { alert: Alert; rugAt: number | null }>();
  private readonly rugged = new Map<string, RugRecord>();
  /** creator → its confirmed rugs, newest last. What the amber rule remembers. */
  private readonly ruggers = new Map<string, PriorRug[]>();
  private fingerprintHits = 0;

  constructor(
    private readonly options: DetectorOptions,
    private readonly sink: DetectorSink,
    /** Seconds; the store watermark (event time), so a replay resolves alerts like live does. */
    private readonly now: () => number,
  ) {}

  // ---------- rules ----------

  liquidity(token: TokenState, e: LiquidityEvent): void {
    if (e.kind !== 'add' || token.creator === null || e.provider !== token.creator) return;
    const id = `red:${token.mint}`;
    if (this.alerts.has(id) || this.rugged.has(token.mint)) return;
    const tokenIsBase = e.baseMint === token.mint;
    const quoteMint = tokenIsBase ? e.quoteMint : e.baseMint;
    const amount = toUnits(tokenIsBase ? e.quoteAmount : e.baseAmount, tokenIsBase ? e.quoteDecimals : e.baseDecimals);
    const { minSol, maxSol } = this.options.fingerprint;
    const fingerprint = quoteMint === WRAPPED_SOL && amount.gte(minSol) && amount.lte(maxSol);
    if (fingerprint) this.fingerprintHits += 1;
    this.raise({
      kind: 'alert',
      id,
      level: 'red',
      rule: 'creator-adds-liquidity',
      mint: token.mint,
      creator: token.creator,
      at: secondsValue(e.blockTime),
      detectedAt: millisValue(e.receivedAt),
      origin: e.origin,
      trigger: { type: 'liquidity', pool: e.pool, dex: e.dex, ...chainRef(e) },
      evidence: { quoteAmount: amount.toString(), quoteMint, fingerprint },
      confidence: CONFIDENCE.red,
      url: tokenUrl(token.mint),
    });
  }

  graduation(token: TokenState, e: GraduationEvent): void {
    const creator = token.creator ?? e.creator;
    const id = `amber:${token.mint}`;
    if (this.alerts.has(id) || this.rugged.has(token.mint)) return;
    const at = secondsValue(e.blockTime);
    const prior = (this.ruggers.get(creator) ?? []).filter((r) => r.mint !== token.mint && r.at < at);
    if (prior.length === 0) return;
    this.raise({
      kind: 'alert',
      id,
      level: 'amber',
      rule: 'repeat-rugger',
      mint: token.mint,
      creator,
      at,
      detectedAt: millisValue(e.receivedAt),
      origin: e.origin,
      trigger: { type: 'graduation', pool: e.pool, dex: e.dex, ...chainRef(e) },
      evidence: { priorRugs: [...prior].reverse().slice(0, MAX_PRIOR_RUGS_SHOWN), priorRugCount: prior.length },
      confidence: CONFIDENCE.amber,
      url: tokenUrl(token.mint),
    });
  }

  /** Confirmation: the tradable liquidity of a graduated token reached the peak and then the floor. */
  poolReading(token: TokenState, e: LiquidityEvent | SwapEvent): void {
    if (token.stage !== 'graduated' || this.rugged.has(token.mint)) return;
    const { minPeakUsd, maxLiquidityUsd } = this.options.collapse;
    if (token.tradablePeakUsd === null || token.tradablePeakUsd.lt(minPeakUsd)) return;
    const now = tradableLiquidityUsd(token);
    if (now === null || now.gt(maxLiquidityUsd)) return;

    const actor = e.type === 'liquidity' ? e.provider : e.trader;
    const byCreator = token.creator !== null && actor === token.creator;
    let mechanism: RugMechanism;
    if (e.type === 'liquidity') mechanism = byCreator ? (this.alerts.has(`red:${token.mint}`) ? 'creator-pull' : 'migration-pull') : 'third-party-remove';
    else mechanism = byCreator ? 'dev-dump' : 'sell-off';

    const at = secondsValue(e.blockTime);
    const confirms = (['red', 'amber'] as const).flatMap((level) => {
      const entry = this.alerts.get(`${level}:${token.mint}`);
      if (entry === undefined) return [];
      entry.rugAt = at;
      return [{ id: entry.alert.id, level, at: entry.alert.at, leadSeconds: at - entry.alert.at }];
    });
    const rug: RugRecord = {
      kind: 'rug',
      mint: token.mint,
      creator: token.creator,
      at,
      detectedAt: millisValue(e.receivedAt),
      origin: e.origin,
      mechanism,
      trigger: { type: e.type, actor, pool: e.pool, dex: e.dex, ...chainRef(e) },
      peakUsd: token.tradablePeakUsd.toFixed(2),
      lastUsd: now.toFixed(2),
      alerts: confirms,
      url: tokenUrl(token.mint),
    };
    this.remember(rug);
    this.sink(rug);
  }

  // ---------- memory ----------

  /** Rebuilds memory from the registry (no emission): dedup, amber's ruggers, live precision. */
  load(records: Iterable<DetectorRecord>): void {
    for (const r of records) {
      if (r.kind === 'alert') {
        const existing = this.alerts.get(r.id);
        boundedSet(this.alerts, r.id, { alert: r, rugAt: existing?.rugAt ?? null }, this.options.maxRememberedMints);
        if (r.level === 'red' && 'fingerprint' in r.evidence && r.evidence.fingerprint) this.fingerprintHits += 1;
      } else {
        this.remember(r);
        for (const a of r.alerts) {
          const entry = this.alerts.get(a.id);
          if (entry !== undefined) entry.rugAt = r.at;
        }
      }
    }
  }

  private raise(alert: Alert): void {
    boundedSet(this.alerts, alert.id, { alert, rugAt: null }, this.options.maxRememberedMints);
    this.sink(alert);
  }

  private remember(rug: RugRecord): void {
    boundedSet(this.rugged, rug.mint, rug, this.options.maxRememberedMints);
    if (rug.creator === null) return;
    const list = this.ruggers.get(rug.creator) ?? [];
    if (!list.some((r) => r.mint === rug.mint)) list.push({ mint: rug.mint, at: rug.at, mechanism: rug.mechanism });
    boundedSet(this.ruggers, rug.creator, list.slice(-MAX_PRIOR_RUGS_SHOWN * 4), this.options.maxRememberedCreators);
  }

  stats(): DetectorStats {
    const now = this.now();
    const level = (l: AlertLevel): LevelStats => {
      const s: LevelStats = { fired: 0, confirmed: 0, unconfirmed: 0, open: 0, precision: null, medianLeadSeconds: null };
      const leads: number[] = [];
      for (const { alert, rugAt } of this.alerts.values()) {
        if (alert.level !== l) continue;
        s.fired += 1;
        if (rugAt !== null) {
          s.confirmed += 1;
          leads.push(rugAt - alert.at);
        } else if (now - alert.at > this.options.liveResolveSeconds) s.unconfirmed += 1;
        else s.open += 1;
      }
      if (s.confirmed + s.unconfirmed > 0) s.precision = s.confirmed / (s.confirmed + s.unconfirmed);
      if (leads.length > 0) s.medianLeadSeconds = leads.sort((a, b) => a - b)[Math.floor(leads.length / 2)]!;
      return s;
    };
    const byMechanism: Partial<Record<RugMechanism, number>> = {};
    for (const r of this.rugged.values()) byMechanism[r.mechanism] = (byMechanism[r.mechanism] ?? 0) + 1;
    return {
      alerts: { red: level('red'), amber: level('amber') },
      rugs: { total: this.rugged.size, byMechanism },
      rememberedRuggers: this.ruggers.size,
      fingerprintHits: this.fingerprintHits,
    };
  }
}

export function summarizeDetector(s: DetectorStats): string {
  const lvl = (name: string, l: LevelStats) =>
    `${name}=${l.fired} (confirmed ${l.confirmed}, unconfirmed ${l.unconfirmed}, open ${l.open}${l.precision === null ? '' : `, live precision ${(100 * l.precision).toFixed(1)}%`})`;
  return `[detector] ${lvl('red', s.alerts.red)} ${lvl('amber', s.alerts.amber)} rugs=${s.rugs.total} ${JSON.stringify(s.rugs.byMechanism)}`;
}

