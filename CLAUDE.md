# solana-rug-radar — contexto del proyecto

Detector en tiempo real de operadores que lanzan tokens en serie para hacer rug pull en Solana.
Sidetrack de **Solami** en el hackathon **Crypto World's Fair de Colosseum**. Entrega: **12 oct 2026**.

## La idea (defenderla siempre así)

Solami es infraestructura de Solana. Su producto **Blur** es un firehose de eventos de mercado
ya decodificados (WebSocket) + una REST API de consultas. Solami YA vende análisis estático por
token (`security`, `risk-intel`, `dev-history`). **No envolvemos eso.** Nuestro valor es la
**correlación temporal**: escuchar en vivo, recordar, y detectar patrones entre tokens del mismo
creador. Sus endpoints son fotos; nosotros hacemos la película.

## Plan por fases

1. ✅ Esqueleto, tipos, capa de normalización, cliente REST, Docker, CI (esta fase)
2. Ingesta del WebSocket (reconexión, backfill, backpressure)
3. Máquina de estados por token / creador (memoria acotada)
4. Detector (las 3 señales de abajo)
5. Dashboard

## Reglas de detección — validadas con datos reales. NO CAMBIARLAS.

Observado en mainnet: un creador con **48 tokens en 12 h**, otro con **96 en 8h50m**; creadores
legítimos de control: **1 token cada uno**. Los tokens de los operadores colapsan a
`liquidity_usd` de **$1–5** conservando **150–800 holders**, tras máximos de **$200k–350k** de
market cap. La liquidez final se repite casi al céntimo entre tokens del mismo creador
(1297.98, 1297.64, 1296.82, 1298.07): huella de automatización.

Señales, por peso:
1. **Principal** — nº de tokens lanzados por el creador en 24 h (>10 anómalo; 48/96 vs 1/1/1).
2. **Confirmatoria** — colapso de `liquidity_usd` con holders altos. Es un EVENTO en el tiempo:
   hace falta el histórico de lecturas (`LiquidityHistory`), no solo el último valor, para
   distinguir "nació con poca liquidez" de "tenía y la perdió".
3. **Automatización** — liquidez final repetida entre tokens del mismo creador, tolerancia estrecha.

**DESCARTADO con datos:** la velocidad de graduación NO sirve (dos tokens legítimos graduaron en 0 s).

Umbrales en `config/config.json`, NUNCA en la lógica. Solo "> 10 lanzamientos / 24 h" viene
dado; los demás son los rangos observados, a calibrar en la fase 4.

## Trampas de datos (todas verificadas en capturas reales, 2026-09-24)

1. **Decimales como STRING, enteros como número.** `"1.5"+"0.5"` = `"1.50.5"`; ordenar strings
   pone "9" > "10". Falla en silencio. → Todo pasa por la capa de normalización (`src/core/schema.ts`):
   decimales → `Decimal` (decimal.js), cantidades on-chain → `bigint`, conteos → `number` entero seguro.
   ESLint prohíbe `parseFloat`/`parseInt`.
2. **Enteros > 2^53.** Reservas y cantidades on-chain llegan como número JSON y a veces superan
   2^53 (500 `swap.base_reserve` en la muestra). `JSON.parse` las redondea ANTES de que las veamos.
   → Usar SIEMPRE `parseJsonLossless` (`src/core/json.ts`), nunca `JSON.parse`, para datos de Solami.
   Requiere **Node 24** (JSON.parse source text access; Node 22 no lo tiene, comprobado).
3. **Unidades de tiempo.** `block_time`, `created_time`, `trigger_time`, candle `time` → SEGUNDOS.
   `indexed_at`, `resolved_at` → MILISEGUNDOS. → Tipos opacos `UnixSeconds`/`UnixMillis`
   (`src/core/time.ts`): el compilador impide mezclarlos (aritmética y comparación entre unidades);
   el borde además rechaza un valor de ms en un campo de segundos (frontera 10^11).
4. **`created_time` en los eventos `graduation` y `meme` NO ES FIABLE:** va ~763.000 s (~8,8 días)
   por delante del `block_time` real del `token_create` del mismo mint, con desfase no constante.
   Se renombra a `reportedCreatedTime`. Para tiempos de creación usar `token_create.block_time`
   o `created_time` de dev-history (que sí cuadra).
5. **`resolved_at` = i64::MAX (9223372036854775807)** es un centinela de "sin timestamp" → `null`.
6. **`metadata.image_url` EMBEBE NUESTRA API KEY** (`...?api_key=sk_...`). El normalizador la
   elimina. Los `.jsonl` crudos de `data/` la contienen: están en `.gitignore`, no subirlos jamás.
   El dashboard (fase 5) debe servir imágenes vía proxy en servidor, nunca exponer la URL cruda.
7. `metadata` (el objeto anidado en `meme`) puede ser `null` hasta que el resolver lo resuelve.
   NO significa token inexistente.
8. `backfill: true` marca eventos repetidos al conectar; los `metadata` traen `catchup: true`.
   Normalizado a `origin: 'realtime' | 'backfill' | 'catchup'`, presente en todo evento.
9. `top10_pct` puede ser `"100"` en tokens sanos (el pool cuenta como holder). No usarlo sin
   descontar el pool.
10. `graduated_time` = `0` → aún no graduó (→ `null`), no 1970.
11. Volumen: ~1 `token_create`/s, ~86.000/día. Toda estructura por token/creador DEBE estar
    acotada (`TtlLruCache` con `maxEntries`, colas con `maxQueue`).
12. `transfer`: `mint` nunca trae `src_owner`; `burn` nunca trae `dst_owner`; ~3% de
    `transfer` sin `dst_owner` (causa desconocida). `swap.mcap_usd` falta en ~1%.
13. `total_tax_pct`: no confirmado si es fracción o porcentaje. Solo compararlo consigo mismo.

## Endpoints

- WS: `wss://ws.solami.dev/data/subscribe?chain=solana&api_key=KEY&type=...&backfill=200`
  (`backfill` ≤ 200 eventos por tipo al conectar; luego llega `backfill_end`).
- REST: `https://api.solami.dev/data/...` con cabecera `x-api-key`. **1 req/s en plan gratuito.**
  VERIFICADO contra la API real el 2026-09-24 (la documentación y el prompt original estaban mal):
  - `GET /data/token/security?chain=solana&address=<MINT>`
  - `GET /data/token/dev?chain=solana&address=<MINT>&limit=<N>` — es el "dev-history";
    `/data/token/dev-history` da 404 `unknown data route`.
  - `chain` es obligatorio (sin él: 400 `missing field chain`). El mint va en `address`
    (`?mint=` da 400 `no token address provided`).
  - **Sin `limit`, dev solo lista 20 tokens** aunque diga `truncated: false` y `scanned: 63`.
    Por eso se envía `limit` (config `rest.devHistoryTokenLimit`, 200). Tope real del servidor: desconocido
    (aceptó 100000 sin error). Para la señal 1 usar `tokens_launched`, no `tokens.length`.
  - La respuesta real de dev trae campos extra (`ath_time`, `ath_mcap_time`, `indexed_from_creation`)
    que hoy se descartan. Respuestas reales en `tests/fixtures/rest-*.json`.
  - **dev recibe un MINT pero devuelve el historial del CREADOR** → se cachea por creador.
- SDK `solami` de npm (0.1.56): cubre RPC, gRPC, SWQOS y WS de RPC, **NO la Data API (Blur)**.
  Por eso usamos `fetch` nativo (REST) y usaremos `WebSocket` nativo de Node 24 (fase 2).

## Tipos de evento

Stream (12, TODOS verificados con muestras reales): `swap`, `liquidity`, `token_create`,
`pool_create`, `transfer`, `candle`, `stats`, `meme`, `graduation`, `surge`, `radar`, `metadata`.
Control: `connected`, `backfill_end`.
Snapshots (`launches`, `graduating`, `graduated`, `trending`): **PENDIENTES**. No llegan
suscribiéndose con `type=`; hay que averiguar cómo se piden. Hoy pasan como `UnverifiedSnapshot`
con el payload en `raw: unknown` (cuarentena).

## Caché REST (TTL en config)

| Nivel | Qué | Clave | TTL |
|---|---|---|---|
| Identidad | mint → creator, createdTime, launchpad, name, symbol | mint | permanente (acotada por tamaño) |
| Security | authorities, extensions, taxes | mint | ~10 min |
| Historial | dev-history (tokens_launched, liquidity_usd, holders) | **creator** | ~60 s |

Una respuesta de dev-history rellena la identidad de TODOS los tokens del creador y añade una
lectura de liquidez por token a `LiquidityHistory`. Peticiones concurrentes iguales se comparten;
tras esperar turno en la cola se re-consulta la caché y, si hay acierto, se devuelve el turno (`refund`).

## Convenciones de código

- TypeScript estricto, ESM, Node 24. `snake_case` solo en JSON crudo; `camelCase` tras el borde.
- Ningún string numérico ni número de timestamp desnudo sale de `src/events/schemas.ts` / `src/rest/schemas.ts`.
- El normalizador nunca lanza: devuelve `{ ok: false, error }`.
- Tipar contra capturas reales, no contra la documentación.
- Tests con Vitest; `tests/fixtures/events.jsonl` = tramas reales con la key sustituida.

## Comandos

```bash
npm run lint          # eslint + tsc (incluye comprobaciones de tipos en tests)
npm test              # vitest
npm run test:coverage
npm run build && npm start          # replay de data/*.jsonl
docker compose up --build           # lo mismo en contenedor (+ muestras incluidas)
```
