/**
 * Offline check: replays JSONL captures through the normalization border (via ReplaySource,
 * the same pipeline as live ingestion) and prints a report. Exit code 1 if any frame was
 * rejected. Usage: node dist/replay.js <file.jsonl | directory>...
 */
import { loadConfig } from './config.js';
import { systemClock } from './core/time.js';
import { summarizeHealth } from './ingest/health.js';
import { createReplaySource } from './ingest/factory.js';

async function main(): Promise<number> {
  const config = loadConfig();
  const source = createReplaySource(config, process.argv.length > 2 ? process.argv.slice(2) : ['data']);
  if (source.files.length === 0) {
    console.error('no .jsonl files found');
    return 1;
  }
  let delivered = 0;
  for await (const event of source.events()) {
    void event;
    delivered += 1;
  }
  const health = source.health();
  const m = health.malformed;
  const rejected = m.invalidJson + m.notAnObject + m.unknownType + m.invalidShape;
  const duplicates = Object.values(health.byType).reduce((sum, c) => sum + c.duplicates, 0);
  console.log(
    `${health.frames} frames from ${source.files.length} file(s): ${delivered} delivered, ` +
      `${duplicates} duplicates skipped, ${rejected} rejected`,
  );
  console.log(summarizeHealth(health, systemClock()));
  for (const entry of m.recent) console.log(`  REJECTED ${entry}`);
  return rejected === 0 ? 0 : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  },
);
