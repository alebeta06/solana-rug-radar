import { describe, expect, it } from 'vitest';
import { unixMillis } from '../../src/core/time.js';
import type { CreatorHistory } from '../../src/rest/types.js';
import { applyEvent, createEnricher } from '../../src/state/factory.js';
import { graduation, newStore, realCreatorHistory, T0, testConfig, tokenCreate } from './helpers.js';

const settle = () => new Promise((resolve) => setImmediate(resolve));

describe('Enricher (simulated budget, event time)', () => {
  it('asks once about a new creator, not again for its next launch, and always for graduations', () => {
    const store = newStore();
    const enricher = createEnricher(testConfig(), store, null);
    const feed = (e: Parameters<typeof applyEvent>[2]) => {
      applyEvent(store, enricher, e);
      enricher.tick();
    };
    feed(tokenCreate('A1', 'CA', T0));
    feed(tokenCreate('A2', 'CA', T0 + 30)); // known, asked 30 s ago: no
    feed(graduation('A1', 'CA', T0 + 90)); // > 60 s since the last ask: yes
    const stats = enricher.stats();
    expect(stats).toMatchObject({ mode: 'simulated', sent: 2, succeeded: 0 });
    expect(stats.dispatched).toMatchObject({ 'new-creator': 1, graduation: 1, 'known-creator': 0 });
    expect(store.creator('CA')?.restRequestedAt).not.toBeNull();
  });

  it('re-polls creators over the burst threshold even when they stop launching', () => {
    const store = newStore();
    const enricher = createEnricher(testConfig(), store, null);
    for (let i = 0; i < 12; i += 1) {
      applyEvent(store, enricher, tokenCreate(`S${i}`, 'SERIAL', T0 + i));
      enricher.tick();
    }
    const first = enricher.stats().dispatched.suspect;
    expect(store.creator('SERIAL')?.serial).toBe(true);
    // Only unrelated traffic for the next 25 minutes: the suspect is asked again every 10 min.
    for (let t = T0 + 60; t < T0 + 25 * 60; t += 30) {
      applyEvent(store, enricher, tokenCreate(`X${t}`, `other${t}`, t));
      enricher.tick();
    }
    expect(enricher.stats().dispatched.suspect - first).toBe(2);
  });

  it('a known creator is asked again only after knownRefreshMinutes', () => {
    const config = testConfig();
    const store = newStore();
    const enricher = createEnricher(config, store, null);
    applyEvent(store, enricher, tokenCreate('K1', 'CK', T0));
    enricher.tick();
    applyEvent(store, enricher, tokenCreate('K2', 'CK', T0 + config.enrichment.knownRefreshMinutes * 60 + 1));
    enricher.tick();
    expect(enricher.stats().dispatched).toMatchObject({ 'new-creator': 1, 'known-creator': 1 });
  });
});

describe('Enricher (live)', () => {
  it('merges the answer into the store; failures are counted, not thrown', async () => {
    const store = newStore();
    const history = realCreatorHistory(T0);
    const calls: string[] = [];
    let fail = false;
    const fetcher = {
      getCreatorHistory: (mint: string): Promise<CreatorHistory> => {
        calls.push(mint);
        return fail ? Promise.reject(new Error('HTTP 429')) : Promise.resolve(history);
      },
    };
    let now = T0 * 1000;
    const enricher = createEnricher(testConfig(), store, fetcher, () => unixMillis(now));
    const mint = history.tokens[0]!.mint;
    applyEvent(store, enricher, tokenCreate(mint, history.creator, T0));
    enricher.tick();
    await settle();
    expect(calls).toEqual([mint]);
    expect(store.creator(history.creator)?.rest?.tokensLaunched).toBe(63);
    expect(enricher.stats()).toMatchObject({ mode: 'live', sent: 1, succeeded: 1, failed: 0 });

    fail = true;
    now += 3600_000;
    applyEvent(store, enricher, graduation(mint, history.creator, T0 + 3600));
    enricher.tick();
    await settle();
    expect(enricher.stats()).toMatchObject({ sent: 2, failed: 1, lastError: 'HTTP 429' });
  });

  it('never has more than maxInflight requests open', () => {
    const store = newStore();
    const pending: string[] = [];
    const fetcher = { getCreatorHistory: (mint: string) => (pending.push(mint), new Promise<CreatorHistory>(() => {})) };
    let now = T0 * 1000;
    const config = testConfig();
    const enricher = createEnricher(config, store, fetcher, () => unixMillis(now));
    for (let i = 0; i < 5; i += 1) applyEvent(store, enricher, tokenCreate(`M${i}`, `C${i}`, T0));
    for (let i = 0; i < 5; i += 1) {
      now += 1000;
      enricher.tick();
    }
    expect(pending).toHaveLength(config.enrichment.maxInflight);
  });
});
