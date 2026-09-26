import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // CLI entrypoints (process wiring, signals, printing): exercised by running them
      // (docker compose up, live smoke test), not unit-tested. Their logic lives in tested modules.
      exclude: ['src/replay.ts', 'src/main.ts', 'src/analyze.ts'],
      reporter: ['text', 'lcov', 'json-summary'],
      thresholds: { lines: 90, branches: 85, functions: 90, statements: 90 },
    },
  },
});
