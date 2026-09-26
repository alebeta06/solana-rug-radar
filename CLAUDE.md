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

1. ✅ Esqueleto, tipos, capa de normalización, cliente REST, Docker, CI
2. ✅ Ingesta del WebSocket (reconexión, backfill, dedup, contrapresión, persistencia, salud)
3. ✅ Máquina de estados por token / creador (memoria acotada, `src/state/`)
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
11. Volumen: ~0,47 `token_create`/s, **~40.000/día** (medido en 10,5 h en vivo, 2026-09-25;
    la cifra anterior de ~86.000/día venía de una ventana corta), PERO el stream completo con los 7 tipos es
    **~970 frames/s** (medido): `swap` ~440/s y `transfer` ~450/s son el firehose de TODA Solana.
    Toda estructura por token/creador DEBE estar acotada (`TtlLruCache` con `maxEntries`,
    colas con capacidad). En crudo: ~58 GB/día (swap 38, transfer 18, resto 2,4).
12. `transfer`: `mint` nunca trae `src_owner`; `burn` nunca trae `dst_owner`; ~3% de
    `transfer` sin `dst_owner` (causa desconocida). `swap.mcap_usd` falta en ~1%.
13. `total_tax_pct`: no confirmado si es fracción o porcentaje. Solo compararlo consigo mismo.
14. `token_create.uri` puede faltar (2 de 18.055 en la captura de 10,5 h) → `uri: null`.
15. Los nombres de token pueden llevar `U+2028`/`U+2029` sin escapar (válido en JSON).
    `node:readline` corta la línea ahí: los JSONL se leen partiendo SOLO por `\n`
    (`readJsonlLines` en `replay-source.ts`).
16. `meme.graduated` nunca es `true` (0 de 193.565): `meme` solo describe tokens en curva.
    La graduación se sabe por el evento `graduation` (o por dev-history).
17. `liquidity.base_usd`/`quote_usd` son el valor de la CANTIDAD movida, no de la reserva.
    El precio USD de la moneda de cotización sale de `quote_usd / quote_amount`
    (SOL p1–p99 = 115,96–121,62 $ en 10,5 h). Hay decenas de monedas de cotización, no solo SOL/USDC.
18. Un swap drena un pool sin emitir `liquidity remove`: la liquidez real hay que leerla
    también de las reservas de los `swap` (`quote_reserve` tras la operación).

## Endpoints

- WS: `wss://ws.solami.dev/data/subscribe?chain=solana&api_key=KEY&type=a,b,c&backfill=200`
  VERIFICADO en vivo el 2026-09-24:
  - Varios tipos: lista separada por comas en un solo `type=`. Un evento por mensaje WS.
  - Al conectar: `connected` (eco del filtro), hasta 200 eventos de backfill por tipo
    (`backfill: true`), `backfill_end` (~1 s), y luego tiempo real.
  - **`transfer` NO tiene backfill**: lo perdido durante una desconexión no se recupera.
  - **`metadata` llega aunque no se pida** (~30/s, `catchup: true`).
  - **El backfill reenvía bytes idénticos** al evento original (salvo el flag `backfill`):
    verificado con dos conexiones solapadas, 200/200 en token_create, pool_create, graduation,
    liquidity, swap y meme (muestra de 30 s).
  - Filtros de servidor: `dex=a,b` funciona (`dexes=` se ignora); el filtro aplica a TODA la
    conexión y **elimina los `transfer`** (no tienen dex). También existen `mints`, `pools`,
    `traders`, `min_volume_usd` (vistos en el eco de `connected`, no probados).
  - Al cerrar nosotros, el servidor no completa el handshake de cierre (código 1006).
    No depender del código de cierre.
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

## Ingesta (fase 2, `src/ingest/`)

- **Una interfaz, dos orígenes**: `EventSource` (`events()`, `health()`, `close()`), con
  `LiveSource` (WebSocket) y `ReplaySource` (JSONL). Ambos pasan cada trama por el mismo
  `FrameProcessor` (parse sin pérdida → normalizar → dedup). Las fases 3–5 no saben el origen.
  `src/main.ts` usa directo si hay `SOLAMI_API_KEY`, replay si no (`INGEST_SOURCE` lo fuerza).
- **Dedup** (`dedup.ts`), clave elegida con 181k eventos reales:
  tx (swap, transfer, token_create, pool_create) = `signature|ix_index|inner_ix_index|mint`
  (liquidity usa `base_mint`). **Sin el mint falla**: una instrucción de swap emite DOS eventos,
  uno por lado del par (5.868 colisiones con `signature+ix+inner`). graduation = `mint|slot`.
  meme/metadata/etc. = hash del contenido (sin identidad natural). Ventana **por tipo**,
  ≥ backfill (validado en config): una global la vaciarían los swaps en segundos.
- **Contrapresión** (`event-queue.ts`): NO se deja de leer (un firehose no se puede pausar:
  el servidor desconecta y el backfill solo recupera 200/tipo ≈ 0,5 s de swaps). Cola acotada
  que descarta por prioridad: bulk (swap, transfer) primero, normal (liquidity, meme, metadata),
  critical (token_create, pool_create, graduation, control) lo último. Orden de entrega =
  orden de llegada. Descartes contados en health.
- **Reconexión**: solo si se cae (close/error) o hay **silencio** > `staleAfterMs` (TCP
  medio abierto). Backoff exponencial con jitter "igual" (nunca ~0 ms); se resetea solo si la
  conexión duró ≥ `resetAfterMs` (un servidor que acepta y cierra no provoca bucle).
- **Persistencia** (`raw-persister.ts`): JSONL crudo con la key redactada en `data/live/`.
  Dos niveles con tope propio: `lifecycle` (todo menos swap/transfer) y `firehose`
  (swap/transfer). Topes por defecto CONSERVADORES: 1 GB / 500 MB (un jurado lo ejecuta sin
  leer la config). Se suben con `PERSIST_LIFECYCLE_MAX_MB` / `PERSIST_FIREHOSE_MAX_MB`.
  Rota por tamaño o día UTC; el tamaño de los ficheros cerrados se lleva EN MEMORIA
  (stat() infravalora un fichero recién rotado aún sin volcar).
- **Salud**: `GET /health` (200/503) + línea de log periódica: estado, último frame,
  contadores por tipo (recibidos, duplicados, descartados, entregados), malformados,
  cola, reconexiones, disco. Nunca contiene la key (redactada).

### Trabajo futuro: NO persistir el firehose entero (depende de la fase 3)

Persistir ~38 GB/día de swaps trata el firehose como si todos los swaps importaran; solo
importan los de tokens que ya vigilamos. Lo correcto: **una segunda conexión WS suscrita a
`swap` filtrado por `mints=` de los tokens bajo seguimiento** (lista que da la máquina de
estados de la fase 3), en lugar de suscribirse al firehose completo. Verificar antes cómo
admite el servidor una lista larga de mints y si permite actualizarla sin reconectar.

## Memoria (fase 3, `src/state/`)

- **`StateStore`**: `TokenState` (etapa `created<curve<graduated`, pools, lecturas de liquidez
  con hora y origen `curve|pool|rest`, pico) y `CreatorState` (lanzamientos por mint con su
  resultado, `serial` pegajoso, números de dev-history). Solo guarda tipos que importan
  (token_create, meme, graduation, pool_create, liquidity, swap de tokens seguidos).
- **Reloj = marca de agua** (máximo `block_time` visto, con tope `receivedAt + 60 s`).
  Ventanas y expulsión van en tiempo de evento: el replay se comporta como el directo.
- **Independiente del orden e idempotente** (tests con permutaciones y con todo aplicado dos
  veces). Etapas solo avanzan; "hora de X" = la más temprana; lecturas por posición on-chain
  (slot, tx, ix, inner). `liquidity`/`pool_create` antes de su token esperan en un búfer
  acotado (`pending.ts`). LÍMITES conocidos: un `swap` anterior a su token se descarta (no se
  retiene: el 99 % son de tokens ajenos); una lectura de curva sin precio de SOL conocido aún
  (primer segundo) se cuenta en `unpricedReadings` y se omite.
- **Expulsión**: token inactivo 60 min en curva / 24 h graduado → se pliega en un
  `LaunchRecord` del creador. Creadores: 24 h (≥ ventana, config lo valida), 7 días si
  alguna vez superaron el umbral. Un evento demasiado viejo no resucita un token expulsado.
- **Persistencia**: arranque en caliente re-leyendo las últimas 24 h de `data/live/lifecycle-*`
  (el log crudo ES la persistencia). Sin formato propio.
- **REST** (`scheduler.ts` + `enricher.ts`): una petición por creador; prioridad
  suspect (re-consulta cada 10 min) > graduation > new-creator > known-creator (≥ 6 h).
  Simulado sobre la captura: ~0,4 req/s de media, 0 descartes. Sin API key se simula en tiempo
  de evento.
- `npm run analyze`: pasa `data/live` por la memoria e imprime material de calibración.

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
npm run build && npm start          # ingesta: directo con SOLAMI_API_KEY, replay sin ella
npm run replay                      # comprobar data/*.jsonl contra el borde (exit 1 si hay rechazos)
npm run analyze                     # replay de data/live por la memoria: seriales, colapsos, presupuesto REST
docker compose up --build           # ingesta en contenedor; health en localhost:8080/health
```
