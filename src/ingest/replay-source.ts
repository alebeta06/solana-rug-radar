/**
 * Replay origin: JSONL files on disk (the phase-1 captures, or what RawPersister wrote).
 *
 * Same interface and same FrameProcessor as the live source, so consumers cannot tell them
 * apart. Backpressure is natural here: a line is read only when the consumer asks for the next
 * event, so nothing is ever dropped.
 *
 * `.jsonl.gz` files are read transparently (the bundled demo capture is one).
 *
 * Pacing (`speed`): 0 delivers as fast as the consumer reads. N > 0 delivers on event time
 * compressed N times: a frame whose `block_time` is 60 s after the first one's is delivered 60/N s
 * after it. Only delivery is delayed; the events are the same, so detection (which runs on event
 * time) is the same at any speed. Frames older than the latest delivered are not delayed.
 *
 * Order: files are read one after another in name order. The persister's two tiers are
 * separate files, so a replay of both is not globally time-ordered; consumers must tolerate
 * out-of-order events anyway (a reconnect backfill is out of order too).
 */
import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleepMs } from 'node:timers/promises';
import { createGunzip } from 'node:zlib';
import { millisValue, systemClock, type Clock } from '../core/time.js';
import type { SolamiEvent } from '../events/types.js';
import { FrameProcessor, type EventSource, type SourceHealth, type SourceState } from './source.js';

const isJsonl = (name: string) => name.endsWith('.jsonl') || name.endsWith('.jsonl.gz');
const BLOCK_TIME = /"block_time":(\d+)/;

/** Files and directories (recursive) → sorted .jsonl / .jsonl.gz paths. Missing paths are skipped. */
export function expandJsonlPaths(paths: readonly string[]): string[] {
  return paths.flatMap((path) => {
    if (!existsSync(path)) return [];
    if (!statSync(path).isDirectory()) return [path];
    return readdirSync(path)
      .sort()
      .flatMap((name) => {
        const child = join(path, name);
        return statSync(child).isDirectory() ? expandJsonlPaths([child]) : isJsonl(name) ? [child] : [];
      });
  });
}

/**
 * JSONL lines split on "\n" ONLY. node:readline also breaks lines on U+2028/U+2029, which are
 * legal unescaped inside a JSON string: 9 real token names in the 10.5 h capture contain one,
 * and readline turned each into two "invalid JSON" rejections.
 */
export async function* readJsonlLines(file: string): AsyncGenerator<string> {
  let pending = '';
  const input = file.endsWith('.gz') ? createReadStream(file).pipe(createGunzip()).setEncoding('utf8') : createReadStream(file, { encoding: 'utf8' });
  for await (const chunk of input) {
    const parts = (pending + (chunk as string)).split('\n');
    pending = parts.pop() ?? '';
    yield* parts;
  }
  if (pending !== '') yield pending;
}

export interface ReplaySourceOptions {
  readonly paths: readonly string[];
  readonly dedupWindowPerType: number;
  readonly clock?: Clock;
  readonly warn?: (message: string) => void;
  /** Event-time compression factor; 0 or absent = no pacing. */
  readonly speed?: number;
  readonly sleep?: (ms: number) => Promise<unknown>;
}

export class ReplaySource implements EventSource {
  readonly files: readonly string[];
  readonly speed: number;
  private readonly processor: FrameProcessor;
  private readonly clock: Clock;
  private readonly sleep: (ms: number) => Promise<unknown>;
  private state: SourceState = 'idle';
  private closed = false;
  /** Wall time and event time (both ms) of the first paced frame. */
  private anchor: { readonly wall: number; readonly event: number } | null = null;

  constructor(options: ReplaySourceOptions) {
    this.files = expandJsonlPaths(options.paths);
    this.clock = options.clock ?? systemClock;
    this.processor = new FrameProcessor(options.dedupWindowPerType, this.clock, options.warn);
    this.speed = options.speed ?? 0;
    this.sleep = options.sleep ?? sleepMs;
  }

  /** Waits until the frame is due at `speed`. Before processing, so `receivedAt` is the paced time. */
  private async pace(line: string): Promise<void> {
    const t = BLOCK_TIME.exec(line)?.[1];
    if (this.speed <= 0 || t === undefined) return;
    const event = Number(t) * 1000;
    const now = millisValue(this.clock());
    if (this.anchor === null) {
      this.anchor = { wall: now, event };
      return;
    }
    const wait = this.anchor.wall + (event - this.anchor.event) / this.speed - now;
    if (wait >= 1) await this.sleep(wait);
  }

  async *events(): AsyncIterableIterator<SolamiEvent> {
    this.state = 'replaying';
    try {
      for (const file of this.files) {
        for await (const line of readJsonlLines(file)) {
          if (this.closed) return;
          if (line.trim() === '') continue;
          await this.pace(line);
          if (this.closed) return;
          const event = this.processor.process(line);
          if (event === null) continue;
          this.processor.counters(event.type).delivered += 1;
          yield event;
        }
      }
    } finally {
      this.state = 'closed';
    }
  }

  health(): SourceHealth {
    return {
      origin: 'replay',
      state: this.state,
      lastFrameAt: this.processor.lastFrameAt,
      frames: this.processor.frames,
      byType: this.processor.byType,
      malformed: this.processor.malformed,
      queue: null,
      connection: null,
      persistence: null,
    };
  }

  close(): Promise<void> {
    this.closed = true;
    this.state = 'closed';
    return Promise.resolve();
  }
}
