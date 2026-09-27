/**
 * What the detector emits (phase 4). Structured records, not log lines: phase 5 draws them, a
 * webhook may send them, and the registry (./registry.ts) stores them as JSONL.
 *
 * Two alert levels, each with ITS OWN measured precision (never an average of both):
 * - red   'creator-adds-liquidity': the creator adds liquidity to its own token. "Get out."
 * - amber 'repeat-rugger': a token of a creator that already drained another one graduates.
 *         "Watch this one."
 * A `rug` record is not an alert: it is the confirmation (the tradable liquidity collapsed), the
 * evidence that closes an alert and the memory the amber rule needs.
 */

export type AlertLevel = 'red' | 'amber';
export type AlertRule = 'creator-adds-liquidity' | 'repeat-rugger';

/** Where an event sits on chain: enough to find it again and to order it. `graduation` events carry only the slot. */
export interface ChainRef {
  readonly signature: string | null;
  readonly slot: number;
  readonly txIndex: number | null;
  readonly ixIndex: number | null;
  readonly innerIxIndex: number | null;
}

/** Precision measured offline for this rule (docs/ANALISIS_calibracion.md), carried by every alert. */
export interface Confidence {
  readonly precision: number;
  readonly confirmed: number;
  readonly fired: number;
  readonly measuredOn: string;
}

export interface Alert {
  readonly kind: 'alert';
  /** `${level}:${mint}`: one alert of each level per token, ever. */
  readonly id: string;
  readonly level: AlertLevel;
  readonly rule: AlertRule;
  readonly mint: string;
  readonly creator: string;
  /** Block time of the triggering event (seconds). */
  readonly at: number;
  /** Local time the triggering frame was received (ms): `detectedAt - at*1000` is our latency. */
  readonly detectedAt: number;
  /** `realtime`, or `backfill`/`catchup` when it was raised from a reconnect replay. */
  readonly origin: string;
  readonly trigger: { readonly type: 'liquidity' | 'graduation'; readonly pool: string; readonly dex: string } & ChainRef;
  readonly evidence: RedEvidence | AmberEvidence;
  readonly confidence: Confidence;
  readonly url: string;
}

export interface RedEvidence {
  /** Quote amount added, in quote units (decimal string), and which quote. */
  readonly quoteAmount: string;
  readonly quoteMint: string;
  /** In the fingerprint SOL band (84.9–85.1): 420 of the 422 confirmed cases. Confirmation, not a rule. */
  readonly fingerprint: boolean;
}

export interface AmberEvidence {
  /** Drains of this creator seen before this graduation, newest first (at most 5). */
  readonly priorRugs: readonly { readonly mint: string; readonly at: number; readonly mechanism: RugMechanism }[];
  readonly priorRugCount: number;
}

/**
 * How the tradable liquidity went away, from the event that crossed the line:
 * - creator-pull:       the creator removes liquidity it had added itself (red case).
 * - migration-pull:     the creator removes liquidity it never added (the pool it got at migration).
 * - dev-dump:           the creator sells into the pool.
 * - third-party-remove: someone else removes liquidity.
 * - sell-off:           someone else's sell.
 */
export type RugMechanism = 'creator-pull' | 'migration-pull' | 'dev-dump' | 'third-party-remove' | 'sell-off';

export interface RugRecord {
  readonly kind: 'rug';
  readonly mint: string;
  readonly creator: string | null;
  readonly at: number;
  readonly detectedAt: number;
  readonly origin: string;
  readonly mechanism: RugMechanism;
  readonly trigger: { readonly type: 'liquidity' | 'swap'; readonly actor: string; readonly pool: string; readonly dex: string } & ChainRef;
  readonly peakUsd: string;
  readonly lastUsd: string;
  /** Alerts this rug confirms, with the lead: rug time − alert time (seconds, block time). */
  readonly alerts: readonly { readonly id: string; readonly level: AlertLevel; readonly at: number; readonly leadSeconds: number }[];
  readonly url: string;
}

export type DetectorRecord = Alert | RugRecord;

/** Live precision of one level: alerts confirmed by a rug vs. alerts that expired unconfirmed. */
export interface LevelStats {
  fired: number;
  confirmed: number;
  /** No rug within `liveResolveMinutes` (a later rug still flips it to confirmed). */
  unconfirmed: number;
  /** Younger than `liveResolveMinutes`, no rug yet. */
  open: number;
  /** confirmed / (confirmed + unconfirmed); null until something resolved. */
  precision: number | null;
  /** Median lead of the confirmed ones (seconds). */
  medianLeadSeconds: number | null;
}

export interface DetectorStats {
  readonly alerts: Readonly<Record<AlertLevel, LevelStats>>;
  readonly rugs: { readonly total: number; readonly byMechanism: Readonly<Partial<Record<RugMechanism, number>>> };
  readonly rememberedRuggers: number;
  readonly fingerprintHits: number;
}

export const tokenUrl = (mint: string) => `https://solscan.io/token/${mint}`;
export const accountUrl = (wallet: string) => `https://solscan.io/account/${wallet}`;
