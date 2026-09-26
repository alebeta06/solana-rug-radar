/**
 * Entrypoint: ingestion (phase 2) feeding the memory (phase 3). Picks the origin, serves
 * /health (source + state), logs health lines periodically.
 *
 * Live: warm start from the persisted lifecycle log (last `state.warmStart.hours`), then the
 * stream; dev-history enrichment runs for real when SOLAMI_API_KEY is set. Replay: the REST
 * budget is only simulated, on event time.
 *
 * Origin: INGEST_SOURCE=live|replay; default live when SOLAMI_API_KEY is set, replay otherwise
 * (REPLAY_PATHS, comma-separated, default "data,samples"). Ctrl+C / SIGTERM: close the socket,
 * flush pending disk writes, exit.
 */
import { loadConfig } from './config.js';
import { systemClock } from './core/time.js';
import { createLiveSource, createReplaySource } from './ingest/factory.js';
import { startHealthServer, summarizeHealth } from './ingest/health.js';
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
    const paths = (process.env.REPLAY_PATHS ?? 'data,samples').split(',').map((p) => p.trim());
    source = createReplaySource(config, paths);
    console.log(`[ingest] replay (no SOLAMI_API_KEY or INGEST_SOURCE=replay): ${paths.join(', ')}`);
  }

  const getState = () => stateHealth(store, enricher);
  const server = await startHealthServer(config.health.port, () => source.health(), systemClock, config.stream.staleAfterMs, getState);
  console.log(`[ingest] health on http://localhost:${config.health.port}/health`);
  const logTimer = setInterval(() => {
    console.log(summarizeHealth(source.health(), systemClock()));
    console.log(summarizeState(getState()));
  }, config.health.logEveryMs);
  const restTimer = live ? setInterval(() => enricher.tick(), 1000 / config.rest.requestsPerSecond) : undefined;

  // Before connecting (health answers meanwhile, 503 until the stream is live). Must run before
  // source.events(): the persister starts writing to the same directory once frames arrive.
  if (mode === 'live' && config.state.warmStart.enabled) {
    const files = warmStartFiles(config.persistence.dir, config.state.warmStart.hours, Date.now());
    const started = Date.now();
    const events = await warmStart(config, store, files);
    console.log(`[state] warm start: ${events} events from ${files.length} file(s) in ${Date.now() - started} ms`);
  }

  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) {
      console.log('[ingest] forced exit');
      process.exit(1);
    }
    stopping = true;
    console.log(`[ingest] ${signal}: closing socket and flushing disk…`);
    void source.close();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  for await (const event of source.events()) {
    applyEvent(store, enricher, event);
    if (!live) enricher.tick(); // simulated budget advances on event time
  }

  await source.close(); // no-op if already closed; flushes the persister
  clearInterval(logTimer);
  clearInterval(restTimer);
  await new Promise((resolve) => server.close(resolve));
  console.log(summarizeHealth(source.health(), systemClock()));
  console.log(summarizeState(getState()));
  console.log('[ingest] stopped');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
