/**
 * One interface, two origins. Phases 3–5 consume an `EventSource` and cannot tell whether the
 * events come from the live Blur WebSocket or from JSONL files on disk. That is what allows
 * developing and testing without network, and it is the plan B if stream access is reduced.
 *
 * Both origins run every frame through the same `FrameProcessor`, so parsing, normalization,
 * deduplication and error accounting behave identically.
 */
import { parseJsonLossless } from '../core/json.js';
import { redactSecrets } from '../core/schema.js';
import type { Clock, UnixMillis } from '../core/time.js';
import { normalizeEvent } from '../events/normalize.js';
import type { SolamiEvent } from '../events/types.js';
import { DedupWindow } from './dedup.js';

export type SourceState =
  | 'idle'
  | 'connecting'
  | 'backfilling'
  | 'live'
  | 'reconnecting'
  | 'replaying'
  | 'closed';

export interface TypeCounters {
  /** Frames that normalized OK. */
  received: number;
  /** Already seen (backfill replay after reconnect). */
  duplicates: number;
  /** Lost to backpressure. */
  dropped: number;
  /** Handed to the consumer. */
  delivered: number;
}

export interface MalformedCounters {
  invalidJson: number;
  notAnObject: number;
  unknownType: number;
  invalidShape: number;
  /** Last few rejections (bounded), for diagnosis. */
  recent: string[];
}

export interface ConnectionHealth {
  readonly connectedSince: UnixMillis | null;
  readonly reconnects: number;
  readonly consecutiveFailures: number;
  readonly nextRetryAt: UnixMillis | null;
  readonly lastError: string | null;
}

export interface PersistenceHealth {
  readonly bytesWritten: number;
  readonly linesWritten: number;
  readonly droppedLines: number;
  readonly deletedFiles: number;
  readonly currentFiles: Readonly<Record<string, string | null>>;
  readonly lastError: string | null;
}

export interface SourceHealth {
  readonly origin: 'live' | 'replay';
  readonly state: SourceState;
  /** Last frame received (any type), local clock. The "is it alive?" answer. */
  readonly lastFrameAt: UnixMillis | null;
  readonly frames: number;
  readonly byType: Readonly<Record<string, TypeCounters>>;
  readonly malformed: MalformedCounters;
  readonly queue: { readonly length: number; readonly capacity: number } | null;
  readonly connection: ConnectionHealth | null;
  readonly persistence: PersistenceHealth | null;
}

export interface EventSource {
  /** Single consumer. Ends when the source is closed (live) or the files are exhausted (replay). */
  events(): AsyncIterableIterator<SolamiEvent>;
  health(): SourceHealth;
  /** Stops input, flushes pending writes. Idempotent. */
  close(): Promise<void>;
}

const MAX_RECENT_ERRORS = 10;

/** Parse → normalize → dedup, with counters. Never throws on bad data. */
export class FrameProcessor {
  frames = 0;
  lastFrameAt: UnixMillis | null = null;
  readonly byType: Record<string, TypeCounters> = {};
  readonly malformed: MalformedCounters = {
    invalidJson: 0,
    notAnObject: 0,
    unknownType: 0,
    invalidShape: 0,
    recent: [],
  };
  private readonly dedup: DedupWindow;
  private readonly warned = new Set<string>();

  constructor(
    dedupWindowPerType: number,
    private readonly clock: Clock,
    private readonly warn: (message: string) => void = (m) => console.warn(m),
  ) {
    this.dedup = new DedupWindow(dedupWindowPerType);
  }

  counters(type: string): TypeCounters {
    return (this.byType[type] ??= { received: 0, duplicates: 0, dropped: 0, delivered: 0 });
  }

  /** Returns the event to deliver, or null if it was malformed or a duplicate. */
  process(text: string): SolamiEvent | null {
    const receivedAt = this.clock();
    this.frames += 1;
    this.lastFrameAt = receivedAt;

    let value: unknown;
    try {
      value = parseJsonLossless(text);
    } catch (error) {
      this.reject('invalidJson', 'invalid_json', String(error), text);
      return null;
    }
    const result = normalizeEvent(value, receivedAt);
    if (!result.ok) {
      const { reason, type, issues } = result.error;
      const counter = reason === 'not_an_object' ? 'notAnObject' : reason === 'unknown_type' ? 'unknownType' : 'invalidShape';
      this.reject(counter, `${reason}${type === null ? '' : ` ${type}`}`, issues.slice(0, 3).join('; '), text);
      return null;
    }

    const counters = this.counters(result.event.type);
    counters.received += 1;
    if (this.dedup.isDuplicate(result.event)) {
      counters.duplicates += 1;
      return null;
    }
    return result.event;
  }

  private reject(counter: Exclude<keyof MalformedCounters, 'recent'>, kind: string, detail: string, text: string): void {
    this.malformed[counter] += 1;
    const entry = redactSecrets(`${kind}: ${detail} | ${text.slice(0, 200)}`);
    this.malformed.recent.push(entry);
    if (this.malformed.recent.length > MAX_RECENT_ERRORS) this.malformed.recent.shift();
    // Log each kind of rejection once; afterwards it only shows in the counters, so a
    // systematic schema change at ~1000 frames/s cannot flood the logs.
    if (!this.warned.has(kind)) {
      this.warned.add(kind);
      this.warn(`[ingest] dropped malformed frame (${entry}) — further "${kind}" only counted in health`);
    }
  }
}
