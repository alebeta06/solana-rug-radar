/**
 * Phase-2 entrypoint: ingestion. Picks the origin, serves /health, logs a health line
 * periodically and consumes the event stream (phases 3–5 plug in where marked).
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

async function main(): Promise<void> {
  const config = loadConfig();
  const mode = process.env.INGEST_SOURCE ?? (config.apiKey === null ? 'replay' : 'live');
  let source: EventSource;
  if (mode === 'live') {
    source = createLiveSource(config);
    console.log(`[ingest] live: ${config.stream.types.join(',')} (backfill ${config.stream.backfill})`);
  } else if (mode === 'replay') {
    const paths = (process.env.REPLAY_PATHS ?? 'data,samples').split(',').map((p) => p.trim());
    source = createReplaySource(config, paths);
    console.log(`[ingest] replay (no SOLAMI_API_KEY or INGEST_SOURCE=replay): ${paths.join(', ')}`);
  } else {
    throw new Error(`INGEST_SOURCE must be "live" or "replay", got "${mode}"`);
  }

  const server = await startHealthServer(config.health.port, () => source.health(), systemClock, config.stream.staleAfterMs);
  console.log(`[ingest] health on http://localhost:${config.health.port}/health`);
  const logTimer = setInterval(() => console.log(summarizeHealth(source.health(), systemClock())), config.health.logEveryMs);

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
    // Phase 3 (state machine) consumes `event` here.
    void event;
  }

  await source.close(); // no-op if already closed; flushes the persister
  clearInterval(logTimer);
  await new Promise((resolve) => server.close(resolve));
  console.log(summarizeHealth(source.health(), systemClock()));
  console.log('[ingest] stopped');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
