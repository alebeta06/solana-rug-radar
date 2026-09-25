import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // replay.ts is the phase-1 CLI entrypoint (file I/O + printing); it is exercised by docker compose.
      exclude: ['src/replay.ts'],
      reporter: ['text', 'lcov', 'json-summary'],
      thresholds: { lines: 90, branches: 85, functions: 90, statements: 90 },
    },
  },
});
