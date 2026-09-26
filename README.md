# solana-rug-radar

Real-time detection of **serial rug-pull operators** on Solana, built on
[Solami](https://solami.dev)'s Blur data stream.
Solami sidetrack, Colosseum Crypto World's Fair hackathon.

> **Status: phase 2 of 5.** Live ingestion of the Blur stream is running (backfill,
> reconnection, deduplication, backpressure, raw persistence, health endpoint) on top of
> phase 1's normalization layer and rate-limited REST client. State machine, detector and
> dashboard come next.

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

### Thresholds: what is validated and what is not yet

Only **one** threshold comes from research on real data. The rest are the ranges we
**observed** on the operators we studied. They are starting values, **not proven cut-offs**,
and will be calibrated in phase 4 against creators that are and are not known operators.

| Signal | Threshold | Status | Evidence |
|---|---|---|---|
| 1. Launch burst | **> 10** tokens by one creator in 24 h | ✅ **Validated** on real data | Operators: 48 and 96 launches; legitimate controls: 1 each |
| 2. Liquidity collapse | liquidity **≤ $5** | ⚠️ Observed range, to calibrate in phase 4 | Collapsed tokens sat at $1–5 |
| 2. Liquidity collapse | **≥ 150** holders | ⚠️ Observed range, to calibrate in phase 4 | 150–800 holders remained |
| 2. Liquidity collapse | ATH market cap **≥ $200k** | ⚠️ Observed range, to calibrate in phase 4 | Peaks of $200k–350k |
| 3. Automation | final liquidity within **$1.50** across **≥ 3** tokens | ⚠️ Observed, to calibrate in phase 4 | 4 tokens within $1.25 (1296.82–1298.07) |

All thresholds live in [`config/config.json`](config/config.json), never in the code.

## Architecture

```
                 Solami Blur (WebSocket firehose)            Solami Data REST (1 req/s)
                              │                                        │
                              ▼                                        ▼
  phase 2 ✅ ┌─────────────────────────────┐        ┌──────────────────────────────────┐
            │ EventSource: live WS │ replay│        │ SolamiRestClient        phase 1 ✅│
            │  backfill, reconnect+backoff│        │  TokenBucket 1 req/s, bounded    │
            │  dedup · priority backpress.│        │  3-tier cache: identity ∞ ·      │
            │  raw JSONL · /health        │        │                                  │
            └─────────────┬───────────────┘        │                                  │
                          ▼                        │  security 10 min · history 60 s  │
  phase 1 ✅ ┌─────────────────────────────┐        │  (history cached BY CREATOR)     │
            │ normalization border        │        │  LiquidityHistory time series    │
            │  lossless JSON (bigint)     │        └────────────────┬─────────────────┘
            │  decimal strings → Decimal  │                         │
            │  seconds/millis → branded   │                         │
            │  api_key redaction          │                         │
            └─────────────┬───────────────┘                         │
                          ▼                                         │
  phase 3 ✅ ┌─────────────────────────────┐  dev-history, by        │
            │ StateStore (event time)     │  priority (Enricher) ◄──┘
            │  token: stage, pools,       │  suspect > graduation >
            │   liquidity readings, peak  │  new creator > known
            │  creator: launches + outcome│
            │  order-independent, bounded │
            │  warm start from raw log    │
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
- **Bounded memory.** ~40,000 tokens are launched per day (measured over a 10.5 h live
  capture), and the full stream carries ~970 events/s (swaps and transfers are chain-wide).
  Every cache, queue and state map has a size limit.
- **One interface, two origins.** Live WebSocket and on-disk replay deliver events through the
  same `EventSource` interface and the same pipeline, so later phases cannot tell them apart:
  development and tests run without network, and replay is the fallback if stream access shrinks.
- **Deduplication key chosen from data.** `signature + ix_index + inner_ix_index` is *not*
  unique: one swap instruction emits two events, one per side of the pair (5,868 collisions in
  our captures). Adding the mint makes it unique across 181k real events.
- **Backpressure drops by priority, it never "stops reading".** A firehose cannot be paused:
  the server would disconnect us and the reconnect backfill only recovers ~0.5 s of swaps. The
  bounded queue drops swaps/transfers first and token launches last, and counts every drop.
- **Memory on event time, independent of arrival order.** The state's clock is the newest
  event time seen (the watermark), so a 10-hour replay behaves like 10 hours live. Stages only
  move forward, "time of" facts keep the earliest value, superseding readings compare on-chain
  positions (slot, tx, instruction), launches are keyed by mint. Tests replay the same events
  in shuffled orders and twice, and require an identical state.
- **Tokens are forgotten, creators are not.** A token idle for 60 min on the curve (24 h once
  graduated) is folded into a compact record on its creator and dropped. Creators are kept for
  the whole 24 h window, and for 7 days once they crossed the launch-burst threshold.
- **Liquidity includes swaps.** A pool drained by selling never emits a liquidity `remove`, so
  reserves are also read from swaps of followed tokens (one reading per pool per minute).
- **REST budget by priority.** dev-history is one request per creator: suspects (re-polled
  every 10 min) > graduations > first launch of an unknown creator > known creators. Replayed
  on the capture it needed ~0.4 req/s on average, with nothing discarded.
- **Restart without amnesia.** On a live start the last 24 h of the persisted raw lifecycle log
  are replayed into the state (the raw log *is* the persistence: no second format).
- **Least privilege.** The API key only needs the *Data API* role.

## Run it

Requirements: Docker. For local development, Node.js 24+.

```bash
docker compose up --build
```

- **With an API key** (`SOLAMI_API_KEY` in `.env`): rebuilds its memory from the last 24 h
  saved in `./data/live/` (if any), connects to the live Blur stream, starts from the backfill
  and switches to realtime, enriching creators through the REST API at 1 req/s. The raw stream
  is saved to `./data/live/`.
- **Without a key:** replays `./data/` plus the redacted real samples bundled in the image,
  through the same pipeline and state (REST budget simulated), then exits. A jury needs nothing else.

Health: <http://localhost:8080/health> (JSON; 200 healthy, 503 not) and two summary lines in
the logs every 30 s. Its `state` section shows what the memory knows: tokens followed (by
stage), creators known and serial, graduations, REST requests sent / discarded by budget, heap. Stop with Ctrl+C: it closes the socket, flushes pending disk writes and exits.

### Disk usage

The full raw stream is ~58 GB/day, so persistence is capped. **Defaults are conservative on
purpose:** 1 GB for lifecycle events (launches, graduations, liquidity, meme…) and 500 MB for
swap/transfer; the oldest files are deleted first. To keep more, add to `.env`:

```bash
PERSIST_LIFECYCLE_MAX_MB=10240   # 10 GB ≈ 4 days of lifecycle events
PERSIST_FIREHOSE_MAX_MB=5120     # 5 GB ≈ 2 hours of swaps + transfers
```

Other options: `INGEST_SOURCE=live|replay` forces the origin; `REPLAY_PATHS=a.jsonl,dir/` picks
what to replay. Everything else (types, backfill, reconnect backoff, queue size) is in
`config/config.json`.

Local development:

```bash
npm ci
npm run lint            # eslint + typecheck (includes compile-time type tests)
npm test                # vitest
npm run test:coverage
npm run build && npm start   # ingestion (live with a key, replay without)
npm run replay               # check ./data captures against the normalization border
npm run analyze              # replay ./data/live through the state: serial creators, collapses, REST budget
```

Copy `.env.example` to `.env` and set `SOLAMI_API_KEY` (a key with only the Data API role).
**Never commit raw captures:** Solami embeds the API key in metadata `image_url`s.

## Layout

```
config/config.json      thresholds, rate limit, cache TTLs (validated at startup)
src/core/               time.ts (branded time) · json.ts (lossless parse) · schema.ts (field validators)
src/events/             types.ts (normalized events) · schemas.ts (raw→normalized) · normalize.ts
src/rest/               client.ts · token-bucket.ts · ttl-lru-cache.ts · liquidity-history.ts
src/ingest/             source.ts (EventSource + FrameProcessor) · live-source.ts · replay-source.ts
                        dedup.ts · event-queue.ts · backoff.ts · raw-persister.ts · health.ts
src/state/              store.ts (StateStore) · token-state.ts · creator-state.ts · pending.ts · order.ts
                        quote-prices.ts · scheduler.ts + enricher.ts (REST policy) · warm-start.ts · factory.ts
src/config.ts           config loader
src/main.ts             entrypoint: ingestion + state
src/replay.ts           offline check of captures
src/analyze.ts          offline replay through the state (calibration material for phase 4)
tests/                  vitest suites + tests/fixtures (redacted real frames)
docs/RESUMEN_Fase_*.md  design rationale per phase, decision by decision (Spanish)
```
