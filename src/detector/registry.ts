/**
 * The detector's own log: every alert and every confirmed rug, one JSON object per line, one file
 * per UTC day (`detector-YYYYMMDD.jsonl`). Live only.
 *
 * It is the demo's evidence ("red alert at 03:14:22 → drain confirmed at 03:22:47, 505 s later",
 * with mechanism and mint link) and the detector's memory across restarts: the last `reloadDays`
 * are re-read at startup, so a restart neither re-raises an alert nor forgets who drained a
 * token (the warm start replays only the lifecycle tier, where dev dumps are invisible).
 *
 * Small (~100 records/hour), so writes are synchronous appends: nothing is buffered to lose.
 * A disk error disables writing and is counted; it never stops detection.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DetectorRecord } from './types.js';

const FILE = /^detector-(\d{8})\.jsonl$/;
const DAY_MS = 86_400_000;
const dayStamp = (ms: number) => new Date(ms).toISOString().slice(0, 10).replaceAll('-', '');

export interface RegistryHealth {
  readonly dir: string;
  readonly written: number;
  readonly loaded: number;
  readonly skippedLines: number;
  readonly lastError: string | null;
}

export class Registry {
  private written = 0;
  private loaded = 0;
  private skippedLines = 0;
  private lastError: string | null = null;
  private disabled = false;

  constructor(
    private readonly dir: string,
    private readonly nowMs: () => number = Date.now,
  ) {}

  append(record: DetectorRecord): void {
    if (this.disabled) return;
    try {
      mkdirSync(this.dir, { recursive: true });
      appendFileSync(join(this.dir, `detector-${dayStamp(this.nowMs())}.jsonl`), `${JSON.stringify(record)}\n`);
      this.written += 1;
    } catch (error) {
      this.disabled = true;
      this.lastError = error instanceof Error ? error.message : String(error);
    }
  }

  /** Records of the last `days` days (by file date), oldest file first. Bad lines are skipped and counted. */
  load(days: number): DetectorRecord[] {
    if (!existsSync(this.dir)) return [];
    const oldest = dayStamp(this.nowMs() - days * DAY_MS);
    const out: DetectorRecord[] = [];
    for (const name of readdirSync(this.dir).sort()) {
      const m = FILE.exec(name);
      if (m?.[1] === undefined || m[1] < oldest) continue;
      for (const line of readFileSync(join(this.dir, name), 'utf8').split('\n')) {
        if (line.trim() === '') continue;
        try {
          const record = JSON.parse(line) as DetectorRecord;
          if (record.kind !== 'alert' && record.kind !== 'rug') throw new Error('unknown kind');
          out.push(record);
        } catch {
          this.skippedLines += 1;
        }
      }
    }
    this.loaded += out.length;
    return out;
  }

  health(): RegistryHealth {
    return { dir: this.dir, written: this.written, loaded: this.loaded, skippedLines: this.skippedLines, lastError: this.lastError };
  }
}
