/**
 * Everything the dashboard page shows, prepared here (tested) so the page only draws it.
 *
 * Order of importance, as on screen:
 * 1. sequences: alert → drain, with the lead. What the project demonstrates: the alert came FIRST.
 * 2. open alerts (no drain yet, younger than `liveResolveMinutes`) and unconfirmed ones.
 * 3. precision per rule, measured offline AND live, never averaged.
 * 4. what the detector does not see, with this session's count of drains nobody warned about.
 * 5. system state; 6. signals dropped with data.
 *
 * Times are EVENT time (block time; the "now" is the store watermark), live and in replay alike:
 * a replay at 40× shows the recording's clock, not the wall clock.
 */
import { CONFIDENCE } from '../detector/detector.js';
import type { StateHealth } from '../state/factory.js';
import type { SourceHealth } from '../ingest/source.js';
import { accountUrl, type Alert, type AlertLevel, type DetectorStats, type LevelStats, type RugMechanism, type RugRecord } from '../detector/types.js';
import type { Feed } from './feed.js';

export type Mode = 'live' | 'replay' | 'replay-finished';

export interface ViewInput {
  readonly source: SourceHealth;
  readonly state: StateHealth;
  readonly detector: DetectorStats;
  readonly feed: Feed;
  /** Replay compression factor (0 = as fast as possible); ignored live. */
  readonly speed: number;
  readonly liveResolveSeconds: number;
  /** Frames per wall second, live only (see RateMeter). */
  readonly eventsPerSecond: number | null;
  /** Live start: the memory is being rebuilt from the saved stream (the clock is the saved events'). */
  readonly warmingUp: boolean;
  /** Live: days of alerts and drains reloaded from the registry at startup (they count as "so far"). */
  readonly historyDays: number;
  readonly nowMs: number;
}

export interface AlertView {
  readonly id: string;
  readonly level: AlertLevel;
  readonly mint: string;
  readonly creator: string;
  readonly at: number;
  /** Plain words: what happened. */
  readonly what: string;
  /** Precision of THIS alert's rule, as measured (0–1), and its counts. */
  readonly precision: number;
  readonly confirmed: number;
  readonly fired: number;
  readonly fingerprint: boolean;
  /**
   * Seconds from the block to our alert (live only; a replay's receive time means nothing). A lead
   * is measured from the block, so an alert raised late (from the backfill sent on connecting)
   * warned this much less.
   */
  readonly latencySeconds: number | null;
  readonly origin: string;
  readonly tokenUrl: string;
  readonly creatorUrl: string;
}

export interface SequenceView {
  readonly mint: string;
  readonly alerts: readonly AlertView[];
  readonly drain: {
    readonly at: number;
    readonly mechanism: RugMechanism;
    readonly what: string;
    readonly peakUsd: string;
    readonly lastUsd: string;
    readonly actorUrl: string;
  };
  /** From the earliest alert to the drain. */
  readonly leadSeconds: number;
  readonly tokenUrl: string;
}

export interface OpenAlertView extends AlertView {
  /** Null while warming up: the clock is still the saved events', an age on it would be false. */
  readonly ageSeconds: number | null;
  /** Median lead measured for this rule: when the drain usually comes. */
  readonly typicalLeadSeconds: number;
}

export interface RuleView {
  readonly level: AlertLevel;
  readonly name: string;
  readonly rule: string;
  readonly meaning: string;
  readonly measured: { readonly precision: number; readonly confirmed: number; readonly fired: number; readonly medianLeadSeconds: number; readonly on: string };
  readonly live: LevelStats;
}

export interface DashboardView {
  readonly mode: Mode;
  /** Live only: rebuilding memory before connecting. */
  readonly warmingUp: boolean;
  /** Live only: the socket is up (live or backfilling). A replay is never "connected". */
  readonly connected: boolean;
  readonly speed: number | null;
  /** What "so far" counts: this replay, or live including the registry's reloaded days. */
  readonly scope: string;
  /**
   * Replay only (null live): the demo recording was chosen around tokens that raised alerts, so its
   * own ratios (drains warned, precision so far) run high and measure nothing. Live has no such bias.
   */
  readonly selectionCaveat: string | null;
  /** UTC date of the recording (replay) or of the stream. */
  readonly day: string | null;
  /** Event time, seconds. */
  readonly clock: number | null;
  readonly sequences: readonly SequenceView[];
  readonly open: readonly OpenAlertView[];
  /** All open alerts, of which `open` shows the newest. */
  readonly openTotal: number;
  readonly unconfirmed: readonly AlertView[];
  readonly rules: readonly RuleView[];
  readonly blind: {
    readonly measuredRecall: number;
    readonly text: string;
    readonly session: { readonly rugs: number; readonly warned: number; readonly unwarnedByMechanism: Partial<Record<RugMechanism, number>> };
  };
  readonly system: {
    readonly state: string;
    readonly eventsPerSecond: number | null;
    readonly frames: number;
    readonly lastFrameAgoSeconds: number | null;
    readonly reconnects: number | null;
    readonly tokens: number;
    readonly graduated: number;
    readonly creators: number;
    readonly rest: { readonly mode: string; readonly sent: number; readonly pending: number; readonly discarded: number } | null;
    readonly heapMB: number;
  };
  readonly dropped: readonly { readonly signal: string; readonly why: string }[];
}

export const MAX_SEQUENCES = 12;
export const MAX_OPEN = 3;
export const MAX_UNCONFIRMED = 3;

/** Median leads measured on the 2026-09-26 night (docs/ANALISIS_calibracion.md, RESUMEN_Fase_4). */
const MEDIAN_LEAD: Record<AlertLevel, number> = { red: 485, amber: 129 };
/** Share of the night's 1,196 pool rugs that got a red or amber alert first. */
export const MEASURED_RECALL = 0.653;

const RULES: Record<AlertLevel, { name: string; meaning: string }> = {
  red: { name: 'RED — get out', meaning: 'The creator adds liquidity to its own token' },
  amber: { name: 'AMBER — watch this one', meaning: 'A token graduates and its creator already drained another token' },
};

const MECHANISM: Record<RugMechanism, string> = {
  'creator-pull': 'creator pulled the liquidity it added',
  'migration-pull': 'creator pulled the migration liquidity',
  'dev-dump': 'creator dumped its tokens into the pool',
  'sell-off': 'sold off by other wallets',
  'third-party-remove': 'liquidity removed by another wallet',
};

export const SELECTION_CAVEAT =
  'This recording was chosen around tokens that raised alerts: its ratios measure neither precision nor recall. The measured figures are the ones above.';

export const DROPPED_SIGNALS: readonly { signal: string; why: string }[] = [
  { signal: '> 10 launches in 24 h (alone)', why: '1.0 % precision: serial launchers mostly spam tokens that never graduate' },
  { signal: 'Sell share before the drain', why: 'The red signal seen from another angle; with tradable liquidity it inverts' },
  { signal: 'Repeated final liquidity', why: 'Drained pools end at ~$0; the repeats were SOL stranded in curve pools' },
  { signal: 'Name reuse across creators', why: '52 % of drained tokens vs 50 % of the rest' },
  { signal: 'bundlers_count (REST)', why: '0–2 in both groups' },
  { signal: 'Graduation speed', why: 'Legitimate tokens also graduate in 0 s' },
  { signal: "Solami's liquidity_usd", why: 'Keeps showing ~2× the pool for hours after a liquidity remove' },
];

function modeOf(source: SourceHealth): Mode {
  if (source.origin === 'live') return 'live';
  return source.state === 'closed' ? 'replay-finished' : 'replay';
}

function alertView(a: Alert, mode: Mode): AlertView {
  let what: string;
  let fingerprint = false;
  if ('fingerprint' in a.evidence) {
    const sol = a.evidence.quoteMint.startsWith('So111');
    what = `creator added ${a.evidence.quoteAmount} ${sol ? 'SOL' : 'of another token'} to its own token`;
    fingerprint = a.evidence.fingerprint;
  } else {
    const n = a.evidence.priorRugCount;
    what = `graduated; its creator already drained ${n} other token${n === 1 ? '' : 's'}`;
  }
  return {
    id: a.id,
    level: a.level,
    mint: a.mint,
    creator: a.creator,
    at: a.at,
    what,
    precision: a.confidence.precision,
    confirmed: a.confidence.confirmed,
    fired: a.confidence.fired,
    fingerprint,
    latencySeconds: mode === 'live' ? Math.max(0, Math.round(a.detectedAt / 1000 - a.at)) : null,
    origin: a.origin,
    tokenUrl: a.url,
    creatorUrl: accountUrl(a.creator),
  };
}

function sequenceOf(rug: RugRecord, feed: Feed, mode: Mode): SequenceView | null {
  const alerts = rug.alerts.flatMap((ref) => {
    const a = feed.alerts.get(ref.id);
    return a === undefined ? [] : [alertView(a, mode)];
  });
  if (alerts.length === 0) return null;
  const first = Math.min(...alerts.map((a) => a.at));
  return {
    mint: rug.mint,
    alerts: alerts.sort((a, b) => a.at - b.at),
    drain: {
      at: rug.at,
      mechanism: rug.mechanism,
      what: MECHANISM[rug.mechanism],
      peakUsd: rug.peakUsd,
      lastUsd: rug.lastUsd,
      actorUrl: accountUrl(rug.trigger.actor),
    },
    leadSeconds: rug.at - first,
    tokenUrl: rug.url,
  };
}

export function buildView(input: ViewInput): DashboardView {
  const { source, state, detector, feed } = input;
  const mode = modeOf(source);
  const warmingUp = mode === 'live' && input.warmingUp;
  const clock = state.watermark === null ? null : Number(state.watermark);

  const sequences = [...feed.rugs.values()]
    .sort((a, b) => b.at - a.at)
    .flatMap((r) => sequenceOf(r, feed, mode) ?? [])
    .slice(0, MAX_SEQUENCES);

  const pending = [...feed.alerts.values()].filter((a) => !feed.isConfirmed(a.id)).sort((a, b) => b.at - a.at);
  const isOpen = (a: Alert) => clock === null || clock - a.at <= input.liveResolveSeconds;
  const allOpen = pending.filter(isOpen);
  const open = allOpen
    .slice(0, MAX_OPEN)
    .map((a) => ({ ...alertView(a, mode), ageSeconds: clock === null || warmingUp ? null : Math.max(0, clock - a.at), typicalLeadSeconds: MEDIAN_LEAD[a.level] }));
  const unconfirmed = pending
    .filter((a) => !isOpen(a))
    .slice(0, MAX_UNCONFIRMED)
    .map((a) => alertView(a, mode));

  const rules = (['red', 'amber'] as const).map((level): RuleView => {
    const measured = CONFIDENCE[level];
    return {
      level,
      name: RULES[level].name,
      rule: level === 'red' ? 'creator-adds-liquidity' : 'repeat-rugger',
      meaning: RULES[level].meaning,
      measured: { precision: measured.precision, confirmed: measured.confirmed, fired: measured.fired, medianLeadSeconds: MEDIAN_LEAD[level], on: measured.measuredOn },
      live: detector.alerts[level],
    };
  });

  const rest = state.enrichment;
  const sum = (r: Record<string, number>) => Object.values(r).reduce((a, b) => a + b, 0);
  return {
    mode,
    warmingUp,
    connected: mode === 'live' && (source.state === 'live' || source.state === 'backfilling'),
    speed: mode === 'live' ? null : input.speed,
    scope: mode === 'live' ? `Live, incl. the saved last ${input.historyDays} days` : 'This replay',
    selectionCaveat: mode === 'live' ? null : SELECTION_CAVEAT,
    day: clock === null ? null : new Date(clock * 1000).toISOString().slice(0, 10),
    clock,
    sequences,
    open,
    openTotal: allOpen.length,
    unconfirmed,
    rules,
    blind: {
      measuredRecall: MEASURED_RECALL,
      text: 'dev dumps and migration pulls by a creator with no earlier drain. The event IS the drain, one transaction: nothing comes before it. The creator is remembered, so its next token raises amber.',
      session: feed.counts(),
    },
    system: {
      state: source.state,
      eventsPerSecond: mode === 'live' ? input.eventsPerSecond : null,
      frames: source.frames,
      lastFrameAgoSeconds: source.lastFrameAt === null ? null : Math.max(0, Math.round((input.nowMs - Number(source.lastFrameAt)) / 1000)),
      reconnects: source.connection?.reconnects ?? null,
      tokens: state.tokens.tracked,
      graduated: state.tokens.graduated,
      creators: state.creators.known,
      rest: rest === null ? null : { mode: rest.mode, sent: rest.sent, pending: rest.pending, discarded: sum(rest.discardedFull) + sum(rest.discardedStale) },
      heapMB: state.memory.heapUsedMB,
    },
    dropped: DROPPED_SIGNALS,
  };
}

/** Frames per second over the last ≥ 1 s between samples (sampled by a timer, read by the page). */
export class RateMeter {
  private last: { frames: number; ms: number } | null = null;
  private rate: number | null = null;

  get current(): number | null {
    return this.rate;
  }

  sample(frames: number, nowMs: number): number | null {
    if (this.last === null) this.last = { frames, ms: nowMs };
    else if (nowMs - this.last.ms >= 1000) {
      this.rate = Math.max(0, ((frames - this.last.frames) * 1000) / (nowMs - this.last.ms));
      this.last = { frames, ms: nowMs };
    }
    return this.rate;
  }
}
