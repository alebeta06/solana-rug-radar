/**
 * Replay origin: JSONL files on disk (the phase-1 captures, or what RawPersister wrote).
 *
 * Same interface and same FrameProcessor as the live source, so consumers cannot tell them
 * apart. Backpressure is natural here: a line is read only when the consumer asks for the next
 * event, so nothing is ever dropped.
 *
 * Order: files are read one after another in name order. The persister's two tiers are
 * separate files, so a replay of both is not globally time-ordered; consumers must tolerate
 * out-of-order events anyway (a reconnect backfill is out of order too).
 */
import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { systemClock, type Clock } from '../core/time.js';
import type { SolamiEvent } from '../events/types.js';
import { FrameProcessor, type EventSource, type SourceHealth, type SourceState } from './source.js';

/** Files and directories (recursive) → sorted .jsonl paths. Missing paths are skipped. */
export function expandJsonlPaths(paths: readonly string[]): string[] {
  return paths.flatMap((path) => {
    if (!existsSync(path)) return [];
    if (!statSync(path).isDirectory()) return [path];
    return readdirSync(path)
      .sort()
      .flatMap((name) => {
        const child = join(path, name);
        return statSync(child).isDirectory() ? expandJsonlPaths([child]) : name.endsWith('.jsonl') ? [child] : [];
      });
  });
}

export interface ReplaySourceOptions {
  readonly paths: readonly string[];
  readonly dedupWindowPerType: number;
  readonly clock?: Clock;
  readonly warn?: (message: string) => void;
}

export class ReplaySource implements EventSource {
  readonly files: readonly string[];
  private readonly processor: FrameProcessor;
  private state: SourceState = 'idle';
  private closed = false;

  constructor(options: ReplaySourceOptions) {
    this.files = expandJsonlPaths(options.paths);
    this.processor = new FrameProcessor(options.dedupWindowPerType, options.clock ?? systemClock, options.warn);
  }

  async *events(): AsyncIterableIterator<SolamiEvent> {
    this.state = 'replaying';
    try {
      for (const file of this.files) {
        const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
        try {
          for await (const line of lines) {
            if (this.closed) return;
            if (line.trim() === '') continue;
            const event = this.processor.process(line);
            if (event === null) continue;
            this.processor.counters(event.type).delivered += 1;
            yield event;
          }
        } finally {
          lines.close();
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
