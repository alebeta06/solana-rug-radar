# solana-rug-radar

Real-time detection of **serial rug-pull operators** on Solana, built on
[Solami](https://solami.dev)'s Blur data stream.
Solami sidetrack, Colosseum Crypto World's Fair hackathon.

> **Status: phase 1 of 5.** Types, the normalization layer, the rate-limited REST client,
> Docker and CI are in place. Live ingestion, state machine, detector and dashboard come next.

## The problem

Some operators don't rug one token: they rug **dozens a day, automatically**. On mainnet we
found one creator launching **48 tokens in 12 hours** and another **96 in under 9 hours**
(legitimate control creators: 1 each). Their tokens pump to $200k–350k market cap, then
liquidity collapses to $1–5 while 150–800 holders are left holding the bag. The final
liquidity repeats almost to the cent across tokens of the same creator (1297.98, 1297.64,
1296.82, 1298.07): a bot's fingerprint.

Per-token risk endpoints (including Solami's own `security`, `risk-intel`, `dev-history`) are
**snapshots**. Each launch looks unremarkable on its own. The pattern only appears
**across tokens and over time**.

**Our angle: temporal correlation.** Listen live, remember, and link tokens by creator.
Their endpoints are the photos; we make the movie.

### Detection signals (validated on real data)

| # | Signal | Role |
|---|---|---|
| 1 | Tokens launched by the creator in 24 h (> 10) | Primary |
| 2 | `liquidity_usd` collapse while holders stay high | Confirmation |
| 3 | Same final liquidity across the creator's tokens | Automation fingerprint |

Graduation speed was **rejected** as a signal: legitimate tokens also graduate in 0 s.
All thresholds live in [`config/config.json`](config/config.json), never in the code.

## Architecture

```
                 Solami Blur (WebSocket firehose)            Solami Data REST (1 req/s)
                              │                                        │
                              ▼                                        ▼
  phase 2   ┌─────────────────────────────┐        ┌──────────────────────────────────┐
            │ ingestion (reconnect,       │        │ SolamiRestClient        phase 1 ✅│
            │ backfill=200)               │        │  TokenBucket 1 req/s, bounded    │
            └─────────────┬───────────────┘        │  3-tier cache: identity ∞ ·      │
                          ▼                        │  security 10 min · history 60 s  │
  phase 1 ✅ ┌─────────────────────────────┐        │  (history cached BY CREATOR)     │
            │ normalization border        │        │  LiquidityHistory time series    │
            │  lossless JSON (bigint)     │        └────────────────┬─────────────────┘
            │  decimal strings → Decimal  │                         │
            │  seconds/millis → branded   │                         │
            │  api_key redaction          │                         │
            └─────────────┬───────────────┘                         │
                          ▼                                         │
  phase 3   ┌─────────────────────────────┐                         │
            │ bounded state per token /   │◄────────────────────────┘
            │ per creator                 │
            └─────────────┬───────────────┘
  phase 4                 ▼  detector (3 signals, config thresholds)
  phase 5                 ▼  dashboard
```

### Design decisions

- **One normalization border.** Solami sends decimals as JSON strings and raw amounts as JSON
  numbers that can exceed 2^53. Both fail silently in JavaScript (`"1.5"+"0.5"` is
  `"1.50.5"`; `11196105564446459` parses as `…460`). Every frame goes through
  [zod](https://zod.dev) schemas that turn decimals into `Decimal`, amounts into `bigint`, and
  reject anything unexpected. Nothing numeric leaves the border as a string.
- **Timestamps carry their unit in the type.** `UnixSeconds` and `UnixMillis` are opaque types:
  the compiler rejects adding, subtracting or comparing one with the other.
- **Typed against real captures, not docs.** All 12 stream event types were checked against
  254k real frames; list snapshots have no sample yet and are quarantined as `unverified`.
- **Designed for the free plan.** One request per second, no burst, a bounded queue, and caches
  shaped by how the data changes: `dev-history` is keyed by creator, so one operator's 48 tokens
  cost one request.
- **Bounded memory.** ~86,000 tokens are created per day, so every cache and queue has a size limit.
- **Least privilege.** The API key only needs the *Data API* role.

## Run it

Requirements: Docker. For local development, Node.js 24+.

```bash
docker compose up --build
```

Phase 1 replays captured Blur frames through the normalization layer and prints a per-type
report. It needs no API key: redacted real samples ship in the image. To also replay your own
captures, drop `.jsonl` files into `./data/`.

Local development:

```bash
npm ci
npm run lint            # eslint + typecheck (includes compile-time type tests)
npm test                # vitest
npm run test:coverage
npm run build && npm start
```

Copy `.env.example` to `.env` and set `SOLAMI_API_KEY` (a key with only the Data API role).
**Never commit raw captures:** Solami embeds the API key in metadata `image_url`s.

## Layout

```
config/config.json      thresholds, rate limit, cache TTLs (validated at startup)
src/core/               time.ts (branded time) · json.ts (lossless parse) · schema.ts (field validators)
src/events/             types.ts (normalized events) · schemas.ts (raw→normalized) · normalize.ts
src/rest/               client.ts · token-bucket.ts · ttl-lru-cache.ts · liquidity-history.ts
src/config.ts           config loader
src/replay.ts           phase-1 entrypoint
tests/                  vitest suites + tests/fixtures (redacted real frames)
```
