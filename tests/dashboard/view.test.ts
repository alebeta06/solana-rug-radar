import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Script } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { unixMillis, unixSeconds } from '../../src/core/time.js';
import { Feed } from '../../src/dashboard/feed.js';
import { PAGE } from '../../src/dashboard/page.js';
import { buildView, MAX_OPEN, MEASURED_RECALL, RateMeter, SELECTION_CAVEAT, type ViewInput } from '../../src/dashboard/view.js';
import { CONFIDENCE } from '../../src/detector/detector.js';
import type { Alert, AlertLevel, DetectorStats, LevelStats, RugMechanism, RugRecord } from '../../src/detector/types.js';
import { startHealthServer } from '../../src/ingest/health.js';
import type { SourceHealth } from '../../src/ingest/source.js';
import type { StateHealth } from '../../src/state/factory.js';

const T = 1_790_430_000; // 2026-09-26 13:40 UTC
const HOUR = 3600;
const chain = { signature: 'sig', slot: 1, txIndex: 1, ixIndex: 0, innerIxIndex: -1 };

function alert(level: AlertLevel, mint: string, at: number, extra: Partial<Alert> = {}): Alert {
  return {
    kind: 'alert', id: `${level}:${mint}`, level, rule: level === 'red' ? 'creator-adds-liquidity' : 'repeat-rugger',
    mint, creator: `cre-${mint}`, at, detectedAt: (at + 2) * 1000, origin: 'realtime',
    trigger: { type: level === 'red' ? 'liquidity' : 'graduation', pool: 'pool', dex: 'pumpswap', ...chain },
    evidence: level === 'red'
      ? { quoteAmount: '84.99', quoteMint: 'So11111111111111111111111111111111111111112', fingerprint: true }
      : { priorRugs: [{ mint: 'OLD', at: at - 600, mechanism: 'dev-dump' }], priorRugCount: 1 },
    confidence: CONFIDENCE[level], url: `https://solscan.io/token/${mint}`, ...extra,
  };
}

function rug(mint: string, at: number, alerts: readonly Alert[], mechanism: RugMechanism = 'creator-pull'): RugRecord {
  return {
    kind: 'rug', mint, creator: `cre-${mint}`, at, detectedAt: at * 1000, origin: 'realtime', mechanism,
    trigger: { type: 'liquidity', actor: `cre-${mint}`, pool: 'pool', dex: 'pumpswap', ...chain },
    peakUsd: '11557.90', lastUsd: '0.00',
    alerts: alerts.map((a) => ({ id: a.id, level: a.level, at: a.at, leadSeconds: at - a.at })),
    url: `https://solscan.io/token/${mint}`,
  };
}

const level = (s: Partial<LevelStats> = {}): LevelStats => ({ fired: 0, confirmed: 0, unconfirmed: 0, open: 0, precision: null, medianLeadSeconds: null, ...s });
const detector: DetectorStats = { alerts: { red: level({ fired: 3, confirmed: 2, precision: 1 }), amber: level() }, rugs: { total: 0, byMechanism: {} }, rememberedRuggers: 0, fingerprintHits: 0 };
const source = (s: Partial<SourceHealth> = {}): SourceHealth => ({
  origin: 'replay', state: 'replaying', lastFrameAt: unixMillis(1_000_000), frames: 1234, byType: {},
  malformed: { invalidJson: 0, notAnObject: 0, unknownType: 0, invalidShape: 0, recent: [] }, queue: null, connection: null, persistence: null, ...s,
});
const state = (clock: number | null): StateHealth => ({
  watermark: clock === null ? null : unixSeconds(clock),
  tokens: { tracked: 17, created: 0, curve: 0, graduated: 17 }, creators: { known: 13, serial: 0, overThresholdNow: 0 },
  launchesSeen: 17, graduationsSeen: 17, readings: 0, lateEvents: 0, unpricedReadings: 0,
  pending: { mints: 0, held: 0, released: 0, expired: 0 }, evicted: { tokens: 0, creators: 0 },
  enrichment: null, memory: { heapUsedMB: 29, rssMB: 80 },
});

function view(feed: Feed, clock: number | null, overrides: Partial<ViewInput> = {}) {
  return buildView({ source: source(), state: state(clock), detector, feed, speed: 40, liveResolveSeconds: HOUR, eventsPerSecond: 970, warmingUp: false, historyDays: 7, nowMs: 1_003_000, ...overrides });
}

describe('dashboard view: the sequence alert → drain', () => {
  it('pairs each drain with the alert that came before it, with the lead, newest drain first', () => {
    const feed = new Feed();
    const a1 = alert('red', 'A', T);
    const a2 = alert('red', 'B', T + 100);
    feed.load([a1, a2, rug('A', T + 349, [a1]), rug('B', T + 700, [a2])]);
    const v = view(feed, T + 800);
    expect(v.sequences.map((s) => [s.mint, s.leadSeconds])).toEqual([['B', 600], ['A', 349]]);
    expect(v.sequences[1]).toMatchObject({
      tokenUrl: 'https://solscan.io/token/A',
      drain: { at: T + 349, mechanism: 'creator-pull', peakUsd: '11557.90', lastUsd: '0.00', actorUrl: 'https://solscan.io/account/cre-A' },
      alerts: [{ level: 'red', what: 'creator added 84.99 SOL to its own token', fingerprint: true, creatorUrl: 'https://solscan.io/account/cre-A' }],
    });
  });

  it('each alert carries ITS rule precision, never an average of both', () => {
    const feed = new Feed();
    const red = alert('red', 'A', T);
    const amber = alert('amber', 'A', T + 30);
    feed.load([red, amber, rug('A', T + 200, [red, amber])]);
    const [s] = view(feed, T + 300).sequences;
    expect(s!.alerts.map((a) => [a.level, a.precision, a.confirmed, a.fired])).toEqual([
      ['red', 422 / 431, 422, 431],
      ['amber', 359 / 435, 359, 435],
    ]);
    expect(s!.leadSeconds).toBe(200); // from the earliest alert
    expect(view(feed, T).rules.map((r) => [r.level, r.measured.precision])).toEqual([['red', 422 / 431], ['amber', 359 / 435]]);
  });

  it('a drain nobody warned about is not a sequence: it is counted as what the detector does not see', () => {
    const feed = new Feed();
    const a = alert('red', 'A', T);
    feed.load([a, rug('A', T + 300, [a]), rug('D1', T + 10, [], 'dev-dump'), rug('D2', T + 20, [], 'dev-dump'), rug('M', T + 30, [], 'migration-pull')]);
    const v = view(feed, T + 400);
    expect(v.sequences.map((s) => s.mint)).toEqual(['A']);
    expect(v.blind.measuredRecall).toBe(MEASURED_RECALL);
    expect(v.blind.session).toEqual({ rugs: 4, warned: 1, unwarnedByMechanism: { 'dev-dump': 2, 'migration-pull': 1 } });
  });
});

describe('dashboard view: open and unconfirmed alerts, on EVENT time', () => {
  it('open while younger than liveResolve (by the watermark, not the wall clock), unconfirmed after', () => {
    const feed = new Feed();
    feed.load([alert('red', 'OLD', T), alert('amber', 'NEW', T + 3000)]);
    const at = (clock: number) => view(feed, clock);
    expect(at(T + HOUR).open.map((a) => a.mint)).toEqual(['NEW', 'OLD']); // exactly 60 min: still open
    const later = at(T + HOUR + 1);
    expect(later.open.map((a) => [a.mint, a.ageSeconds, a.typicalLeadSeconds])).toEqual([['NEW', 601, 129]]);
    expect(later.unconfirmed.map((a) => a.mint)).toEqual(['OLD']);
  });

  it('a confirmed alert is neither open nor unconfirmed', () => {
    const feed = new Feed();
    const a = alert('red', 'A', T);
    feed.load([a, rug('A', T + 485, [a])]);
    const v = view(feed, T + 2 * HOUR);
    expect(v.open).toEqual([]);
    expect(v.unconfirmed).toEqual([]);
  });

  it('shows the newest few open alerts and says how many there are', () => {
    const feed = new Feed();
    feed.load(Array.from({ length: MAX_OPEN + 2 }, (_, i) => alert('red', `M${i}`, T + i)));
    const v = view(feed, T + 60);
    expect(v.open).toHaveLength(MAX_OPEN);
    expect(v.open[0]!.mint).toBe(`M${MAX_OPEN + 1}`);
    expect(v.openTotal).toBe(MAX_OPEN + 2);
  });
});

describe('dashboard view: live, replay and finished replay never look alike', () => {
  const feed = new Feed();
  feed.add(alert('red', 'A', T));

  it('live: real time, events per second, our latency from block to alert', () => {
    const v = view(feed, T + 5, { source: source({ origin: 'live', state: 'live', connection: { connectedSince: null, reconnects: 2, consecutiveFailures: 0, nextRetryAt: null, lastError: null } }) });
    expect(v).toMatchObject({ mode: 'live', connected: true, warmingUp: false, speed: null, clock: T + 5, day: '2026-09-26', scope: 'Live, incl. the saved last 7 days' });
    expect(v.system).toMatchObject({ eventsPerSecond: 970, reconnects: 2, lastFrameAgoSeconds: 3 });
    expect(v.open[0]!.latencySeconds).toBe(2);
    // Raised late from a reconnect backfill: its real warning was shorter, and the screen says so.
    const late = new Feed();
    late.add(alert('amber', 'B', T, { origin: 'backfill', detectedAt: (T + 61) * 1000 }));
    expect(view(late, T + 70, { source: source({ origin: 'live', state: 'live' }) }).open[0]).toMatchObject({ origin: 'backfill', latencySeconds: 61 });
  });

  it('live but not connected (warm start, reconnecting) is never shown as live', () => {
    const live = (state: SourceHealth['state'], warmingUp = false) => view(feed, T, { source: source({ origin: 'live', state }), warmingUp });
    expect(live('idle', true)).toMatchObject({ mode: 'live', warmingUp: true, connected: false });
    expect(live('idle', true).open[0]!.ageSeconds).toBeNull(); // the clock is yesterday's: no age on it
    expect(live('live').open[0]!.ageSeconds).toBe(0);
    expect(live('reconnecting')).toMatchObject({ warmingUp: false, connected: false });
    expect(live('connecting').connected).toBe(false);
    expect(live('backfilling').connected).toBe(true);
  });

  it('replay: the recording date, the speed and the event clock; no events/s, no latency', () => {
    const v = view(feed, T + 5, { warmingUp: true });
    expect(v).toMatchObject({ mode: 'replay', connected: false, warmingUp: false, speed: 40, clock: T + 5, day: '2026-09-26', scope: 'This replay' });
    expect(v.system.eventsPerSecond).toBeNull();
    expect(v.system.frames).toBe(1234);
    expect(v.open[0]!.latencySeconds).toBeNull();
  });

  it('finished replay: labelled as such, events/s gone (not frozen at the last value)', () => {
    const v = view(feed, T + 5, { source: source({ state: 'closed' }) });
    expect(v.mode).toBe('replay-finished');
    expect(v.system.eventsPerSecond).toBeNull();
    expect(v.system.state).toBe('closed');
  });

  it('says the replay was chosen around alerted tokens (its ratios run high); never live, where it would be false', () => {
    const live = view(feed, T, { source: source({ origin: 'live', state: 'live' }) });
    expect(live.selectionCaveat).toBeNull();
    expect(view(feed, T, { source: source({ origin: 'live', state: 'reconnecting' }), warmingUp: true }).selectionCaveat).toBeNull();
    for (const state of ['replaying', 'closed'] as const) {
      expect(view(feed, T, { source: source({ state }) }).selectionCaveat).toBe(SELECTION_CAVEAT);
    }
    expect(SELECTION_CAVEAT).toMatch(/chosen around tokens that raised alerts/);
    expect(SELECTION_CAVEAT).toMatch(/neither precision nor recall/);
  });

    it('before any event: no clock, no day, nothing invented', () => {
    const v = view(new Feed(), null);
    expect(v).toMatchObject({ clock: null, day: null, sequences: [], open: [], unconfirmed: [] });
  });

  it('lists the signals dropped with data, each with its reason', () => {
    const v = view(new Feed(), null);
    expect(v.dropped.length).toBeGreaterThanOrEqual(6);
    expect(v.dropped.every((d) => d.why.length > 10)).toBe(true);
  });
});

describe('Feed', () => {
  it('ignores repeats and stays bounded, but counts every drain it saw', () => {
    const feed = new Feed(2);
    const a = alert('red', 'A', T);
    feed.load([a, a, alert('red', 'B', T), alert('red', 'C', T)]);
    expect([...feed.alerts.keys()]).toEqual(['red:B', 'red:C']);
    feed.load([rug('X', T, []), rug('X', T, []), rug('Y', T, []), rug('Z', T, [])]);
    expect([...feed.rugs.keys()]).toEqual(['Y', 'Z']);
    expect(feed.counts()).toEqual({ rugs: 3, warned: 0, unwarnedByMechanism: { 'creator-pull': 3 } });
  });

  it('knows which alerts a drain confirmed', () => {
    const feed = new Feed();
    const a = alert('amber', 'A', T);
    feed.load([a, alert('red', 'B', T), rug('A', T + 90, [a])]);
    expect(feed.isConfirmed('amber:A')).toBe(true);
    expect(feed.isConfirmed('red:B')).toBe(false);
  });
});

describe('RateMeter', () => {
  it('measures frames per second over ≥ 1 s, whatever the polling rate', () => {
    const m = new RateMeter();
    expect(m.sample(0, 0)).toBeNull();
    expect(m.sample(500, 400)).toBeNull(); // < 1 s: no rate yet
    expect(m.sample(1940, 2000)).toBe(970);
    expect(m.sample(2000, 2500)).toBe(970); // kept until the next full second
    expect(m.sample(1940, 3000)).toBe(0); // never negative
    expect(m.current).toBe(0);
  });
});

describe('dashboard page', () => {
  it('its inline script parses (it lives in a string: the type checker never sees it)', () => {
    const script = PAGE.split('<script>')[1]!.split('</script>')[0]!;
    expect(() => new Script(script)).not.toThrow(); // compiles, does not run
    expect(PAGE).toContain("fetch('/api/dashboard'");
  });
});

describe('dashboard routes on the health server', () => {
  const get = (port: number, path: string) =>
    new Promise<{ status: number; type: string; body: string }>((resolve, reject) => {
      request({ port, path }, (res) => {
        let body = '';
        res.on('data', (c: Buffer) => (body += c.toString()));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, type: String(res.headers['content-type']), body }));
      }).on('error', reject).end();
    });

  it('serves the page and its data next to /health; a failing view answers 500 without killing the process', async () => {
    let fail = false;
    const server = await startHealthServer(0, () => source(), () => unixMillis(1_000_000), 30_000, undefined, {
      '/': () => ({ type: 'text/html; charset=utf-8', body: '<!doctype html>' }),
      '/api/dashboard': () => {
        if (fail) throw new Error('boom');
        return { type: 'application/json', body: '{"mode":"replay"}' };
      },
    });
    const port = (server.address() as AddressInfo).port;
    try {
      expect(await get(port, '/')).toMatchObject({ status: 200, type: 'text/html; charset=utf-8', body: '<!doctype html>' });
      expect(await get(port, '/api/dashboard?t=1')).toMatchObject({ status: 200, body: '{"mode":"replay"}' });
      expect((await get(port, '/health')).status).toBe(200);
      expect((await get(port, '/constructor')).status).toBe(404);
      fail = true;
      expect(await get(port, '/api/dashboard')).toMatchObject({ status: 500, body: 'boom' });
      expect((await get(port, '/health')).status).toBe(200);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
