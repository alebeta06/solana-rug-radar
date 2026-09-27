/**
 * Entrypoint: ingestion (phase 2) feeding the memory (phase 3) and the detector (phase 4). Picks
 * the origin, serves /health (source + state + alerts), logs health lines periodically.
 *
 * Live: warm start from the persisted lifecycle log (last `state.warmStart.hours`), then the
 * stream; dev-history enrichment runs for real when SOLAMI_API_KEY is set. Replay: the REST
 * budget is only simulated, on event time.
 *
 * Detector: attached AFTER the warm start (history must not raise alerts). Live, its alerts and
 * confirmed rugs go to the registry (data/alerts/, re-read at startup); replay only prints them.
 *
 * Dashboard (phase 5): `GET /` (the page) and `GET /api/dashboard` (its data) on the health server.
 *
 * Origin: INGEST_SOURCE=live|replay; default live when SOLAMI_API_KEY is set, replay otherwise
 * (REPLAY_PATHS, comma-separated, default "samples": the bundled demo capture). A replay is paced
 * on event time (REPLAY_SPEED, default 40×; 0 = as fast as possible) and, when it ends, the
 * process keeps serving the final state until Ctrl+C. Ctrl+C / SIGTERM: close the socket, flush
 * pending disk writes, exit.
 */
import { loadConfig } from './config.js';
import { PAGE } from './dashboard/page.js';
import { Feed } from './dashboard/feed.js';
import { buildView, RateMeter } from './dashboard/view.js';
import { summarizeDetector } from './detector/detector.js';
import { createDetector, describeRecord } from './detector/factory.js';
import { Registry } from './detector/registry.js';
import type { DetectorRecord } from './detector/types.js';
import { systemClock } from './core/time.js';
import { createLiveSource, createReplaySource } from './ingest/factory.js';
import { startHealthServer, summarizeHealth } from './ingest/health.js';
import { ReplaySource } from './ingest/replay-source.js';
import type { EventSource } from './ingest/source.js';
import {
  applyEvent,
  createEnricher,
  createRestClient,
  createStateStore,
  stateHealth,
  summarizeState,
  warmStart,
} from './state/factory.js';
import { warmStartFiles } from './state/warm-start.js';

/** Default 40×: the demo capture (≈ 100 min of event time) plays in ≈ 2.5 min. */
function replaySpeed(): number {
  const speed = Number(process.env.REPLAY_SPEED ?? '40');
  if (!Number.isFinite(speed) || speed < 0) throw new Error(`REPLAY_SPEED must be a number ≥ 0, got "${process.env.REPLAY_SPEED}"`);
  return speed;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const mode = process.env.INGEST_SOURCE ?? (config.apiKey === null ? 'replay' : 'live');
  if (mode !== 'live' && mode !== 'replay') throw new Error(`INGEST_SOURCE must be "live" or "replay", got "${mode}"`);

  const store = createStateStore(config);
  const live = mode === 'live' && config.apiKey !== null;
  const enricher = createEnricher(config, store, live ? createRestClient(config) : null);

  let source: EventSource;
  if (mode === 'live') {
    source = createLiveSource(config);
    console.log(`[ingest] live: ${config.stream.types.join(',')} (backfill ${config.stream.backfill})`);
  } else {
    const paths = (process.env.REPLAY_PATHS ?? 'samples').split(',').map((p) => p.trim());
    source = createReplaySource(config, paths, replaySpeed());
    console.log(`[ingest] replay (no SOLAMI_API_KEY or INGEST_SOURCE=replay) at ${replaySpeed() || 'max'}×: ${paths.join(', ')}`);
  }

  // Live only: a replay must not write into (or read from) the live evidence log.
  const registry = mode === 'live' ? new Registry(config.detection.registry.dir) : null;
  const feed = new Feed();
  const detector = createDetector(config, store, (record: DetectorRecord) => {
    registry?.append(record);
    feed.add(record);
    console.log(describeRecord(record));
  });
  if (registry !== null) {
    const records = registry.load(config.detection.registry.reloadDays);
    detector.load(records);
    feed.load(records);
    console.log(`[detector] registry ${config.detection.registry.dir}: ${registry.health().loaded} record(s) reloaded`);
  }

  const getState = () => ({ ...stateHealth(store, enricher), detector: detector.stats(), registry: registry?.health() ?? null });
  const meter = new RateMeter();
  const meterTimer = setInterval(() => meter.sample(source.health().frames, Date.now()), 1000);
  let warmingUp = false;
  const dashboard = () => {
    const health = source.health();
    const now = Date.now();
    return buildView({
      source: health,
      state: stateHealth(store, enricher),
      detector: detector.stats(),
      feed,
      speed: source instanceof ReplaySource ? source.speed : 0,
      liveResolveSeconds: config.detection.liveResolveMinutes * 60,
      eventsPerSecond: meter.current,
      warmingUp,
      historyDays: config.detection.registry.reloadDays,
      nowMs: now,
    });
  };
  const server = await startHealthServer(config.health.port, () => source.health(), systemClock, config.stream.staleAfterMs, getState, {
    '/': () => ({ type: 'text/html; charset=utf-8', body: PAGE }),
    '/api/dashboard': () => ({ type: 'application/json', body: JSON.stringify(dashboard()) }),
  });
  console.log(`[ingest] dashboard on http://localhost:${config.health.port}/ · health on /health`);
  const logTimer = setInterval(() => {
    console.log(summarizeHealth(source.health(), systemClock()));
    console.log(summarizeState(getState()));
    console.log(summarizeDetector(detector.stats()));
  }, config.health.logEveryMs);
  const restTimer = live ? setInterval(() => enricher.tick(), 1000 / config.rest.requestsPerSecond) : undefined;

  // Before connecting (health answers meanwhile, 503 until the stream is live). Must run before
  // source.events(): the persister starts writing to the same directory once frames arrive.
  if (mode === 'live' && config.state.warmStart.enabled) {
    warmingUp = true;
    const files = warmStartFiles(config.persistence.dir, config.state.warmStart.hours, Date.now());
    const started = Date.now();
    const events = await warmStart(config, store, files);
    console.log(`[state] warm start: ${events} events from ${files.length} file(s) in ${Date.now() - started} ms`);
    warmingUp = false;
  }
  store.listen(detector);

  let stopping = false;
  let stopped: () => void = () => {};
  const stop = new Promise<void>((resolve) => (stopped = resolve));
  const shutdown = (signal: string) => {
    if (stopping) {
      console.log('[ingest] forced exit');
      process.exit(1);
    }
    stopping = true;
    console.log(`[ingest] ${signal}: closing socket and flushing disk…`);
    void source.close();
    stopped();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  for await (const event of source.events()) {
    applyEvent(store, enricher, event);
    if (!live) enricher.tick(); // simulated budget advances on event time
  }

  if (mode === 'replay' && !stopping) {
    // The dashboard keeps showing the final state (labelled "replay finished") until Ctrl+C.
    console.log(summarizeDetector(detector.stats()));
    console.log(`[ingest] replay finished; the dashboard keeps the final state at http://localhost:${config.health.port}/ (Ctrl+C to exit)`);
    clearInterval(logTimer);
    clearInterval(meterTimer);
    await stop;
  }
  await source.close(); // no-op if already closed; flushes the persister
  clearInterval(logTimer);
  clearInterval(meterTimer);
  clearInterval(restTimer);
  await new Promise((resolve) => server.close(resolve));
  console.log(summarizeHealth(source.health(), systemClock()));
  console.log(summarizeState(getState()));
  console.log(summarizeDetector(detector.stats()));
  console.log('[ingest] stopped');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
