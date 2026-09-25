/**
 * Live origin: the Solami Blur WebSocket.
 *
 * Lifecycle: connecting → backfilling (replay of the last N events per type) → live
 * (after `backfill_end`) → on drop: reconnecting (backoff) → connecting …
 *
 * - Reconnects only when the connection is lost: a close/error, or SILENCE. The stream carries
 *   ~1000 frames/s, so `staleAfterMs` without a single frame means a dead connection that the
 *   OS has not noticed yet (half-open TCP); it is treated as a drop.
 * - Backoff grows with consecutive failures and resets only after a connection stayed up for
 *   `resetAfterMs`: a server that accepts and immediately closes does not cause a tight loop.
 * - Frames go through the shared FrameProcessor (malformed ones are counted and skipped), are
 *   persisted raw, and queued in the bounded EventQueue (see event-queue.ts for backpressure).
 * - Uses Node 24's built-in WebSocket; injectable for tests (no network in the test suite).
 */
import { redactSecrets } from '../core/schema.js';
import { elapsedMillis, millisValue, systemClock, unixMillis, type Clock, type UnixMillis } from '../core/time.js';
import type { SolamiEvent } from '../events/types.js';
import { backoffDelay, type BackoffOptions } from './backoff.js';
import { EventQueue, type Priority } from './event-queue.js';
import type { RawPersister } from './raw-persister.js';
import { FrameProcessor, type EventSource, type SourceHealth, type SourceState } from './source.js';

/** The subset of the WHATWG WebSocket API we use. */
export interface WebSocketLike {
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  close(code?: number, reason?: string): void;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

export interface LiveSourceOptions {
  readonly url: string;
  readonly chain: string;
  readonly types: readonly string[];
  readonly backfill: number;
  readonly apiKey: string;
  readonly dedupWindowPerType: number;
  readonly staleAfterMs: number;
  readonly reconnect: BackoffOptions & { readonly resetAfterMs: number };
  readonly queueCapacity: number;
  readonly priorityOf: (type: string) => Priority;
  readonly persister?: RawPersister | null;
  readonly createSocket?: WebSocketFactory;
  readonly clock?: Clock;
  readonly random?: () => number;
  readonly warn?: (message: string) => void;
}

const TYPE_FIELD = /"type":"([a-z_]+)"/;

export class LiveSource implements EventSource {
  private readonly processor: FrameProcessor;
  private readonly queue: EventQueue<SolamiEvent>;
  private readonly clock: Clock;
  private readonly createSocket: WebSocketFactory;
  private state: SourceState = 'idle';
  private socket: WebSocketLike | null = null;
  private connectedSince: UnixMillis | null = null;
  private lastActivityAt: UnixMillis | null = null;
  private reconnects = 0;
  private consecutiveFailures = 0;
  private nextRetryAt: UnixMillis | null = null;
  private lastError: string | null = null;
  private retryTimer: NodeJS.Timeout | undefined;
  private watchdog: NodeJS.Timeout | undefined;
  private started = false;
  private closed = false;

  constructor(private readonly options: LiveSourceOptions) {
    this.clock = options.clock ?? systemClock;
    this.createSocket = options.createSocket ?? ((url) => new WebSocket(url) as unknown as WebSocketLike);
    this.processor = new FrameProcessor(options.dedupWindowPerType, this.clock, options.warn);
    this.queue = new EventQueue(options.queueCapacity, (event) => options.priorityOf(event.type));
  }

  events(): AsyncIterableIterator<SolamiEvent> {
    this.start();
    const iterator: AsyncIterableIterator<SolamiEvent> = {
      next: async () => {
        const result = await this.queue.next();
        if (!result.done) this.processor.counters(result.value.type).delivered += 1;
        return result;
      },
      [Symbol.asyncIterator]: () => iterator,
    };
    return iterator;
  }

  health(): SourceHealth {
    return {
      origin: 'live',
      state: this.state,
      lastFrameAt: this.processor.lastFrameAt,
      frames: this.processor.frames,
      byType: this.processor.byType,
      malformed: this.processor.malformed,
      queue: { length: this.queue.length, capacity: this.options.queueCapacity },
      connection: {
        connectedSince: this.connectedSince,
        reconnects: this.reconnects,
        consecutiveFailures: this.consecutiveFailures,
        nextRetryAt: this.nextRetryAt,
        lastError: this.lastError,
      },
      persistence: this.options.persister?.health() ?? null,
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.retryTimer);
    clearInterval(this.watchdog);
    this.dropSocket();
    this.state = 'closed';
    this.queue.end();
    await this.options.persister?.close();
  }

  /** Subscription URL. Contains the API key: never log it. */
  subscriptionUrl(): string {
    const { url, chain, types, backfill, apiKey } = this.options;
    const typeList = types.map(encodeURIComponent).join(',');
    return `${url}?chain=${encodeURIComponent(chain)}&api_key=${encodeURIComponent(apiKey)}&type=${typeList}&backfill=${backfill}`;
  }

  private start(): void {
    if (this.started || this.closed) return;
    this.started = true;
    const checkEvery = Math.max(250, Math.floor(this.options.staleAfterMs / 4));
    this.watchdog = setInterval(() => this.checkStale(), checkEvery);
    this.connect();
  }

  private connect(): void {
    if (this.closed) return;
    this.state = 'connecting';
    this.nextRetryAt = null;
    this.lastActivityAt = this.clock();
    let socket: WebSocketLike;
    try {
      socket = this.createSocket(this.subscriptionUrl());
    } catch (error) {
      this.lastError = this.redact(String(error));
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      this.connectedSince = this.clock();
      this.lastActivityAt = this.connectedSince;
      this.state = this.options.backfill > 0 ? 'backfilling' : 'live';
    };
    socket.onmessage = (message) => {
      this.lastActivityAt = this.clock();
      this.handleFrame(typeof message.data === 'string' ? message.data : Buffer.from(message.data as ArrayBuffer).toString('utf8'));
    };
    socket.onerror = (event) => {
      const detail = (event as { message?: unknown } | null)?.message;
      this.lastError = this.redact(`websocket error${typeof detail === 'string' && detail ? `: ${detail}` : ''}`);
    };
    socket.onclose = (event) => {
      this.lastError = this.redact(`connection closed (code ${event.code}${event.reason ? `: ${event.reason}` : ''})`);
      this.socket = null;
      this.scheduleReconnect();
    };
  }

  private handleFrame(text: string): void {
    this.options.persister?.write(TYPE_FIELD.exec(text)?.[1] ?? null, text);
    const event = this.processor.process(text);
    if (event === null) return;
    if (event.type === 'backfill_end') this.state = 'live';
    const dropped = this.queue.push(event);
    if (dropped !== undefined) this.processor.counters(dropped.type).dropped += 1;
  }

  private checkStale(): void {
    if (this.socket === null || this.lastActivityAt === null) return;
    const silentFor = elapsedMillis(this.lastActivityAt, this.clock());
    if (silentFor < this.options.staleAfterMs) return;
    this.lastError = `stale: no frames for ${silentFor} ms`;
    this.dropSocket();
    this.scheduleReconnect();
  }

  /** Detaches handlers first, so a late `close` from a dead socket cannot schedule a second retry. */
  private dropSocket(): void {
    const socket = this.socket;
    if (socket === null) return;
    this.socket = null;
    socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
    try {
      socket.close(1000, 'client closing');
    } catch {
      // already closed
    }
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    const now = this.clock();
    const lived = this.connectedSince === null ? 0 : elapsedMillis(this.connectedSince, now);
    if (lived >= this.options.reconnect.resetAfterMs) this.consecutiveFailures = 0;
    this.connectedSince = null;
    this.consecutiveFailures += 1;
    this.reconnects += 1;
    const delay = backoffDelay(this.consecutiveFailures, this.options.reconnect, this.options.random);
    this.nextRetryAt = unixMillis(millisValue(now) + delay);
    this.state = 'reconnecting';
    this.retryTimer = setTimeout(() => this.connect(), delay);
  }

  private redact(text: string): string {
    return redactSecrets(text, this.options.apiKey);
  }
}
