import { afterEach, describe, expect, it, vi } from 'vitest';
import { Decimal } from '../../src/core/schema.js';
import { millisValue, secondsValue, unixMillis } from '../../src/core/time.js';
import { RestError, SolamiRestClient } from '../../src/rest/client.js';
import { TokenBucket } from '../../src/rest/token-bucket.js';

// Shapes copied from real responses captured during research (identifiers shortened).
const SECURITY = JSON.stringify({
  mint: 'MINT_A',
  mint_authority: null,
  freeze_authority: null,
  token2022: true,
  metadata_mutable: null,
  extensions: ['metadataPointer', 'tokenMetadata'],
  transfer_fee_pct: null,
  non_transferable: false,
  total_tax_pct: '0.001063844779770338',
  tax_breakdown: { transfer_fee_pct: '0', swap_fee_pct: '0.0000001277937269484', tip_pct: '0.0010637169860433894' },
  creator: 'OPERATOR',
  creator_pct: '2.747473635938257',
  top10_pct: '100',
});

function token(mint: string, liquidity: string, extra: Record<string, unknown> = {}) {
  return {
    mint,
    name: `Name ${mint}`,
    symbol: mint,
    dex: 'meteora_dbc',
    created_time: 1790284785,
    graduated: true,
    graduated_time: 1790284920,
    ath_usd: '0.0002071',
    ath_mcap_usd: '207100.07',
    price_usd: '0.0000000012',
    liquidity_usd: liquidity,
    holders: 748,
    total_fees_usd: '0.000034',
    volume_1h_usd: '0.047',
    bundlers_count: 1,
    is_current: false,
    ...extra,
  };
}

function devHistory(liquidityA = '2.963216863765038') {
  return JSON.stringify({
    mint: 'MINT_A',
    creator: 'OPERATOR',
    launchpad: 'meteora_dbc',
    created_time: 1790284785,
    tokens_launched: 48,
    migrated: 47,
    first_launch: 1790247767,
    last_launch: 1790290400,
    scanned: 3,
    truncated: false,
    tokens: [
      token('MINT_A', liquidityA, { is_current: true }),
      token('MINT_B', '1297.98'),
      token('MINT_C', '1297.64', { graduated: false, graduated_time: 0 }),
    ],
  });
}

const START = 1_790_300_000_000;

function setup(responses: (() => Response | Promise<Response>)[], bucket?: TokenBucket) {
  let now = START;
  const clock = () => unixMillis(now);
  const fetchMock = vi.fn<typeof fetch>(() => {
    const next = responses.shift();
    if (next === undefined) throw new Error('unexpected request');
    return Promise.resolve(next());
  });
  const client = new SolamiRestClient({
    baseUrl: 'https://api.solami.dev',
    apiKey: 'sk_test',
    timeoutMs: 1000,
    cache: {
      identityMaxEntries: 100,
      securityTtlSeconds: 600,
      securityMaxEntries: 100,
      devHistoryTtlSeconds: 60,
      devHistoryMaxEntries: 100,
    },
    liquidityHistory: { maxMints: 100, maxReadingsPerMint: 10 },
    bucket: bucket ?? new TokenBucket({ capacity: 100, refillPerSecond: 100, maxQueue: 100 }, clock),
    fetch: fetchMock,
    clock,
  });
  return { client, fetchMock, advance: (ms: number) => (now += ms) };
}

const ok = (body: string) => () => new Response(body, { status: 200 });

describe('SolamiRestClient', () => {
  afterEach(() => vi.useRealTimers());

  it('sends the api key header and the mint as query param', async () => {
    const { client, fetchMock } = setup([ok(SECURITY)]);
    await client.getSecurity('MINT_A');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect((url as URL).href).toBe('https://api.solami.dev/data/token/security?mint=MINT_A');
    expect(init?.headers).toMatchObject({ 'x-api-key': 'sk_test' });
  });

  it('normalizes security and caches it for its TTL', async () => {
    const { client, fetchMock, advance } = setup([ok(SECURITY), ok(SECURITY)]);
    const security = await client.getSecurity('MINT_A');
    expect(security.top10Pct).toEqual(new Decimal('100'));
    expect(security.taxBreakdown.swapFeePct.toString()).toBe('1.277937269484e-7');
    expect(security.transferFeePct).toBeNull();
    expect(millisValue(security.fetchedAt)).toBe(START);

    advance(599_999);
    await client.getSecurity('MINT_A');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    advance(1);
    await client.getSecurity('MINT_A');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('caches dev-history BY CREATOR: other mints of the same operator cost no request', async () => {
    const { client, fetchMock } = setup([ok(devHistory())]);
    const history = await client.getCreatorHistory('MINT_A');
    expect(history.creator).toBe('OPERATOR');
    expect(history.tokensLaunched).toBe(48);

    expect(await client.getCreatorHistory('MINT_B')).toBe(history);
    expect(await client.getCreatorHistory('MINT_C')).toBe(history);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('fills the permanent identity cache from one dev-history response', async () => {
    const { client } = setup([ok(devHistory())]);
    expect(client.getIdentity('MINT_A')).toBeUndefined();
    await client.getCreatorHistory('MINT_A');
    expect(client.getIdentity('MINT_A')).toMatchObject({ creator: 'OPERATOR', launchpad: 'meteora_dbc', name: 'Name MINT_A' });
    expect(client.getIdentity('MINT_B')).toMatchObject({ creator: 'OPERATOR', launchpad: null });
    expect(secondsValue(client.getIdentity('MINT_B')!.createdTime)).toBe(1790284785);
  });

  it('normalizes graduated_time 0 to null', async () => {
    const { client } = setup([ok(devHistory())]);
    const history = await client.getCreatorHistory('MINT_A');
    expect(history.tokens.find((t) => t.mint === 'MINT_C')?.graduatedTime).toBeNull();
  });

  it('refetches after the short TTL and records a liquidity time series', async () => {
    const { client, fetchMock, advance } = setup([ok(devHistory('250000.5')), ok(devHistory('2.96'))]);
    await client.getCreatorHistory('MINT_A');
    advance(60_000);
    await client.getCreatorHistory('MINT_A');
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const series = client.liquidity.readings('MINT_A');
    expect(series.map((r) => [millisValue(r.observedAt) - START, r.liquidityUsd.toString()])).toEqual([
      [0, '250000.5'],
      [60_000, '2.96'],
    ]);
  });

  it('shares one request between concurrent calls for the same mint', async () => {
    const { client, fetchMock } = setup([ok(SECURITY)]);
    const [a, b] = await Promise.all([client.getSecurity('MINT_A'), client.getSecurity('MINT_A')]);
    expect(a).toBe(b);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('re-checks the cache after queueing and refunds the unused slot', async () => {
    vi.useFakeTimers();
    const bucket = new TokenBucket({ capacity: 1, refillPerSecond: 1, maxQueue: 10 });
    const { client, fetchMock } = setup([ok(devHistory()), ok(SECURITY)], bucket);

    const first = client.getCreatorHistory('MINT_A');
    const sameOperator = client.getCreatorHistory('MINT_B'); // queued behind MINT_A
    await vi.advanceTimersByTimeAsync(1000);
    expect(await sameOperator).toBe(await first);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // The refunded slot is available right away for an unrelated request.
    const grantedAt = Date.now();
    await client.getSecurity('MINT_Z');
    expect(Date.now()).toBe(grantedAt);
  });

  it('raises RestError with the HTTP status', async () => {
    const { client } = setup([() => new Response('slow down', { status: 429 })]);
    await expect(client.getSecurity('MINT_A')).rejects.toMatchObject({
      name: 'RestError',
      status: 429,
      endpoint: '/data/token/security',
    });
  });

  it('raises RestError on network failure, invalid JSON and unexpected shape', async () => {
    const { client } = setup([
      () => Promise.reject(new TypeError('fetch failed')),
      ok('<html>'),
      ok(JSON.stringify({ ...JSON.parse(SECURITY), top10_pct: 100 })),
    ]);
    await expect(client.getSecurity('M1')).rejects.toBeInstanceOf(RestError);
    await expect(client.getSecurity('M2')).rejects.toThrow('not valid JSON');
    await expect(client.getSecurity('M3')).rejects.toThrow('top10_pct');
  });
});
