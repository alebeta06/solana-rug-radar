/**
 * Writes the raw stream to disk as JSONL, so it can be reprocessed without capturing again
 * (the replay source reads these files back).
 *
 * - Raw = the frame exactly as received, but with the API key redacted (Solami embeds it in
 *   metadata `image_url`).
 * - Two tiers with separate disk caps: "lifecycle" (token_create, graduation, liquidity, meme…,
 *   ~2.4 GB/day) keeps days of history; "firehose" (swap, transfer, ~56 GB/day) keeps hours.
 * - A file rotates when it reaches `maxFileBytes` or the UTC day changes.
 * - Retention: after each rotation the oldest files of the tier are deleted until
 *   closed files + one full current file fit in the tier cap.
 * - Disk slower than the stream: writes are buffered up to `maxBufferBytes`; beyond that lines
 *   are dropped and counted, never accumulated in RAM. A disk error disables persistence and
 *   is reported in health; it never stops ingestion.
 */
import { createWriteStream, mkdirSync, readdirSync, statSync, unlinkSync, type WriteStream } from 'node:fs';
import { join } from 'node:path';
import { redactSecrets } from '../core/schema.js';
import { millisValue, type Clock } from '../core/time.js';
import type { PersistenceHealth } from './source.js';

export interface RawPersisterOptions {
  readonly dir: string;
  readonly maxFileBytes: number;
  readonly maxBufferBytes: number;
  readonly tiers: Readonly<Record<string, { readonly maxTotalBytes: number }>>;
  /** Which tier a frame of this type goes to (type null = unparseable frame). */
  readonly tierOf: (type: string | null) => string;
  readonly apiKey: string | null;
  readonly clock: Clock;
}

interface TierState {
  stream: WriteStream | null;
  file: string | null;
  bytes: number;
  day: string;
  /**
   * Closed files of this tier, oldest first, with the bytes WE wrote to them. Tracked in memory
   * because a just-rotated file may not be flushed yet, so stat() would under-report its size.
   * Files from previous runs (fully flushed) are measured with stat() once, at startup.
   */
  closed: { path: string; size: number }[] | null;
}

function utcStamp(ms: number): { day: string; stamp: string } {
  const iso = new Date(ms).toISOString(); // 2026-09-24T18:31:02.123Z
  return { day: iso.slice(0, 10), stamp: iso.slice(0, 19).replace(/[-:]/g, '') };
}

export class RawPersister {
  private readonly tiers = new Map<string, TierState>();
  private readonly closing = new Set<Promise<void>>();
  private fileSeq = 0;
  private disabled = false;
  private bytesWritten = 0;
  private linesWritten = 0;
  private droppedLines = 0;
  private deletedFiles = 0;
  private lastError: string | null = null;

  constructor(private readonly options: RawPersisterOptions) {
    try {
      mkdirSync(options.dir, { recursive: true });
    } catch (error) {
      this.fail(error);
    }
  }

  write(type: string | null, text: string): void {
    if (this.disabled) return;
    if (this.bufferedBytes() > this.options.maxBufferBytes) {
      this.droppedLines += 1;
      return;
    }
    const tierName = this.options.tierOf(type);
    const tier = this.tier(tierName);
    const line = `${redactSecrets(text, this.options.apiKey)}\n`;
    const size = Buffer.byteLength(line);
    const { day } = utcStamp(millisValue(this.options.clock()));
    if (tier.stream === null || tier.bytes + size > this.options.maxFileBytes || tier.day !== day) {
      this.rotate(tierName, tier);
      if (this.disabled || tier.stream === null) return;
    }
    tier.stream.write(line);
    tier.bytes += size;
    this.bytesWritten += size;
    this.linesWritten += 1;
  }

  /** Flushes and closes every open file. */
  async close(): Promise<void> {
    for (const tier of this.tiers.values()) this.closeStream(tier);
    await Promise.all([...this.closing]);
  }

  health(): PersistenceHealth {
    const currentFiles: Record<string, string | null> = {};
    for (const [name, tier] of this.tiers) currentFiles[name] = tier.file;
    return {
      bytesWritten: this.bytesWritten,
      linesWritten: this.linesWritten,
      droppedLines: this.droppedLines,
      deletedFiles: this.deletedFiles,
      currentFiles,
      lastError: this.lastError,
    };
  }

  private tier(name: string): TierState {
    let tier = this.tiers.get(name);
    if (tier === undefined) {
      if (this.options.tiers[name] === undefined) throw new Error(`unknown persistence tier: ${name}`);
      tier = { stream: null, file: null, bytes: 0, day: '', closed: null };
      this.tiers.set(name, tier);
    }
    return tier;
  }

  private bufferedBytes(): number {
    let total = 0;
    for (const tier of this.tiers.values()) total += tier.stream?.writableLength ?? 0;
    return total;
  }

  private rotate(name: string, tier: TierState): void {
    if (tier.file !== null) tier.closed?.push({ path: tier.file, size: tier.bytes });
    this.closeStream(tier);
    const { day, stamp } = utcStamp(millisValue(this.options.clock()));
    this.fileSeq += 1;
    const file = join(this.options.dir, `${name}-${stamp}Z-${String(this.fileSeq).padStart(4, '0')}.jsonl`);
    try {
      this.enforceRetention(name, tier);
      const stream = createWriteStream(file, { flags: 'a' });
      stream.on('error', (error) => this.fail(error));
      Object.assign(tier, { stream, file, bytes: 0, day });
    } catch (error) {
      this.fail(error);
    }
  }

  /** Deletes the tier's oldest files until closed files + one full new file fit in the cap. */
  private enforceRetention(name: string, tier: TierState): void {
    tier.closed ??= readdirSync(this.options.dir)
      .filter((f) => f.startsWith(`${name}-`) && f.endsWith('.jsonl'))
      .sort() // names start with a UTC timestamp: lexical order = chronological order
      .map((f) => ({ path: join(this.options.dir, f), size: statSync(join(this.options.dir, f)).size }));
    const cap = this.options.tiers[name]!.maxTotalBytes;
    let total = tier.closed.reduce((sum, f) => sum + f.size, 0);
    while (tier.closed.length > 0 && total + this.options.maxFileBytes > cap) {
      const oldest = tier.closed.shift()!;
      unlinkSync(oldest.path);
      total -= oldest.size;
      this.deletedFiles += 1;
    }
  }

  private closeStream(tier: TierState): void {
    const stream = tier.stream;
    if (stream === null) return;
    tier.stream = null;
    const closed: Promise<void> = new Promise((resolve) => {
      stream.end(() => resolve());
      stream.once('error', () => resolve());
    });
    this.closing.add(closed);
    void closed.then(() => this.closing.delete(closed));
  }

  private fail(error: unknown): void {
    this.lastError = redactSecrets(String(error), this.options.apiKey);
    this.disabled = true;
    for (const tier of this.tiers.values()) this.closeStream(tier);
  }
}
