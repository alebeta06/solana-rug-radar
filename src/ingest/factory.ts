/** Builds either origin from the validated config. */
import type { AppConfig } from '../config.js';
import { systemClock, type Clock } from '../core/time.js';
import type { Priority } from './event-queue.js';
import { LiveSource, type WebSocketFactory } from './live-source.js';
import { RawPersister } from './raw-persister.js';
import { ReplaySource } from './replay-source.js';

const MB = 1024 * 1024;
const CONTROL_TYPES = new Set(['connected', 'backfill_end']);

export function priorityOf(config: AppConfig): (type: string) => Priority {
  const critical = new Set([...config.stream.queue.critical, ...CONTROL_TYPES]);
  const normal = new Set(config.stream.queue.normal);
  return (type) => (critical.has(type) ? 'critical' : normal.has(type) ? 'normal' : 'bulk');
}

export function createPersister(config: AppConfig, clock: Clock = systemClock): RawPersister | null {
  const p = config.persistence;
  if (!p.enabled) return null;
  const firehose = new Set(p.firehoseTypes);
  return new RawPersister({
    dir: p.dir,
    maxFileBytes: p.maxFileMB * MB,
    maxBufferBytes: p.maxBufferMB * MB,
    tiers: {
      lifecycle: { maxTotalBytes: p.lifecycleMaxTotalMB * MB },
      firehose: { maxTotalBytes: p.firehoseMaxTotalMB * MB },
    },
    tierOf: (type) => (type !== null && firehose.has(type) ? 'firehose' : 'lifecycle'),
    apiKey: config.apiKey,
    clock,
  });
}

export function createLiveSource(
  config: AppConfig,
  deps: { createSocket?: WebSocketFactory; clock?: Clock; persister?: RawPersister | null } = {},
): LiveSource {
  if (config.apiKey === null) throw new Error('SOLAMI_API_KEY is required for the live source');
  const s = config.stream;
  const clock = deps.clock ?? systemClock;
  return new LiveSource({
    url: s.url,
    chain: s.chain,
    types: s.types,
    backfill: s.backfill,
    apiKey: config.apiKey,
    dedupWindowPerType: s.dedupWindowPerType,
    staleAfterMs: s.staleAfterMs,
    reconnect: s.reconnect,
    queueCapacity: s.queue.capacity,
    priorityOf: priorityOf(config),
    persister: deps.persister === undefined ? createPersister(config, clock) : deps.persister,
    createSocket: deps.createSocket,
    clock,
  });
}

export function createReplaySource(config: AppConfig, paths: readonly string[]): ReplaySource {
  return new ReplaySource({ paths, dedupWindowPerType: config.stream.dedupWindowPerType });
}
