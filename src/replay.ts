/**
 * Phase-1 entrypoint: replays captured Blur frames (JSONL) through the normalization border
 * and prints a report. Proves on real data that every frame normalizes, without needing an
 * API key. Usage: node dist/replay.js <file.jsonl | directory>...
 */
import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { loadConfig } from './config.js';
import { parseJsonLossless } from './core/json.js';
import { systemClock } from './core/time.js';
import { normalizeEvent } from './events/normalize.js';

const MAX_EXAMPLES_PER_ERROR = 3;

function expand(paths: readonly string[]): string[] {
  return paths.flatMap((path) =>
    !existsSync(path)
      ? []
      : statSync(path).isDirectory()
      ? readdirSync(path)
          .filter((name) => name.endsWith('.jsonl'))
          .sort()
          .map((name) => join(path, name))
      : [path],
  );
}

async function main(): Promise<number> {
  const config = loadConfig();
  console.log(
    `config OK — launch burst: >${config.detection.launchBurst.maxNormalLaunches} tokens / ` +
      `${config.detection.launchBurst.windowHours}h; REST ${config.rest.requestsPerSecond} req/s`,
  );

  const files = expand(process.argv.length > 2 ? process.argv.slice(2) : ['data']);
  if (files.length === 0) {
    console.error('no .jsonl files found');
    return 1;
  }

  const ok = new Map<string, number>();
  const errors = new Map<string, string[]>();
  let lines = 0;
  let failed = 0;

  for (const file of files) {
    const reader = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
    let lineNo = 0;
    for await (const line of reader) {
      lineNo += 1;
      if (line.trim() === '') continue;
      lines += 1;
      let key: string;
      let detail: string;
      try {
        const result = normalizeEvent(parseJsonLossless(line), systemClock());
        if (result.ok) {
          const k = `${result.event.type} (${result.event.origin})`;
          ok.set(k, (ok.get(k) ?? 0) + 1);
          continue;
        }
        key = `${result.error.reason} ${result.error.type ?? ''}`.trim();
        detail = result.error.issues.slice(0, 3).join('; ');
      } catch (error) {
        key = 'invalid_json';
        detail = String(error);
      }
      failed += 1;
      const examples = errors.get(key) ?? [];
      if (examples.length < MAX_EXAMPLES_PER_ERROR) examples.push(`${file}:${lineNo} ${detail}`);
      errors.set(key, examples);
    }
  }

  console.log(`\n${lines} frames from ${files.length} file(s): ${lines - failed} normalized, ${failed} rejected\n`);
  for (const [key, count] of [...ok].sort(([a], [b]) => a.localeCompare(b))) {
    console.log(`  ${key.padEnd(32)} ${count}`);
  }
  for (const [key, examples] of errors) {
    console.log(`\nREJECTED ${key}`);
    for (const example of examples) console.log(`  ${example}`);
  }
  return failed === 0 ? 0 : 1;
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
