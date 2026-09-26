# Resumen de la Fase 3: la memoria

Este documento explica en lenguaje sencillo qué hace cada pieza de la fase 3 y **por qué** se
decidió así, para poder defenderlo ante el jurado o contarlo en un post.

---

## Qué hace la fase 3, en una frase

El sistema ya no ve eventos sueltos: **recuerda**. Sigue a cada token desde que nace hasta que
muere (o lo vacían), apunta todo lo que lanza cada creador y qué fue de cada lanzamiento, y le
pregunta a la API REST lo que el stream no sabe (holders, historial anterior), sin pasarse del
presupuesto de 1 petición por segundo.

---

## 0. Antes de programar: medir (y dos bugs)

Pasé las 10,5 horas reales de `data/live/` por scripts de medición antes de diseñar nada.

**Bug 1 (el que encontraste en producción):** `token_create` sin `uri`. Busqué en los 18.055
lanzamientos: solo `uri` falta (2 veces). Ningún otro campo de `token_create`, `graduation`,
`pool_create`, `liquidity` o `meme` está en esa situación (los opcionales ya lo eran).
Ahora `uri` es opcional (`null`) y hay un test con la trama real.

**Bug 2 (nuevo, lo encontré midiendo):** el replay rechazaba 9 tramas válidas. Causa:
`node:readline` corta las líneas también en los caracteres `U+2028`/`U+2029`, y hay nombres de
token que los llevan (es JSON válido). Cada uno partía una línea en dos "JSON inválidos". En
directo no pasaba (un mensaje WebSocket = un evento); solo en replay. Ahora los ficheros se
parten **solo por salto de línea**. Tras el arreglo: **0 rechazos en 411.383 eventos**.

Lo que cambió el diseño:

| Qué se midió | Resultado | Consecuencia |
|---|---|---|
| Lanzamientos | 18.055 en 10,5 h (≈40.000/día, no 86.000) | Menos volumen del que creíamos |
| Creadores distintos | 7.812 | dev-history es **por creador**: el presupuesto real es ~15.000/día, no 40.000 |
| Creadores con >10 lanzamientos | **230** (41 % de todos los tokens) | Señal 1 dispara mucho: material para la fase 4 |
| Tokens sin graduar: actividad tras nacer | p90 = 5 min, p99 = 5,2 h | Olvidar un token de curva a los 60 min de inactividad pierde <1 % |
| Graduación → último evento de liquidez | p90 = 14 min, p99 = 9,9 h | Los graduados se guardan 24 h |
| Monedas de cotización | SOL, USDC y **decenas de tokens** | No se puede usar una lista fija para saber "qué lado es el token" |
| `meme.graduated` | nunca `true` (0 de 193.565) | La graduación solo se sabe por `graduation` |
| Pools por token | hasta **2.396** | Tope de pools por token |

**Cómo defenderlo:** "Cada número de la configuración sale de medir 10 horas reales."

---

## 1. Qué recuerda de cada token

`TokenState` (en `src/state/types.ts`):
- **Creador, cuándo nació** (`block_time` de su `token_create`), launchpad, nombre.
- **Etapa:** `created` → `curve` (hay `meme` con su `progress_pct`) → `graduated`.
  Solo avanza, nunca retrocede. "Tiene pool" no es una etapa: en launchpads como
  meteora_dbc el pool de la curva se crea al nacer.
- **Sus pools** (de `pool_create`, `graduation`, `liquidity`), con la última lectura de cada uno.
- **Histórico de lecturas de liquidez con su hora y su origen:**
  - `curve`: lo que hay depositado en la curva de bonding (de `meme`).
  - `pool`: la reserva del pool tras un `liquidity` **o un `swap`**.
  - `rest`: la `liquidity_usd` de Solami, con holders.
- **El pico** de liquidez (y cuándo), aunque la lectura ya no esté en el histórico.

**Por qué los swaps (esto no lo pedías, y es importante):** un pool se puede vaciar **vendiendo**
sin que haya nunca un evento `liquidity remove`. Si solo miráramos `liquidity`, un token drenado
a base de ventas parecería intacto. El `swap` trae la reserva tras cada operación. El 99 % de los
swaps (440/s) son de tokens que no seguimos y cuestan dos búsquedas en un Map; los de los
nuestros se guardan como **una lectura por pool y por minuto** (la última del minuto, como el
cierre de una vela).

**Unidades, con cuidado:** las lecturas del stream son **el lado de la cotización** (los SOL del
pool) en dólares; la de REST es la cifra de Solami. No son lo mismo y cada lectura dice de dónde
viene. El precio de SOL (y de las demás monedas) lo aprendemos del propio stream:
`quote_usd / quote_amount` de cada evento de liquidez (SOL osciló entre 116 y 122 $ en 10 h).

---

## 2. Qué recuerda de cada creador (la pieza central)

`CreatorState`: todos sus lanzamientos **indexados por mint** (así un evento repetido nunca
cuenta dos veces), con la hora de cada uno y **qué fue de cada uno** (etapa final, pico,
liquidez final, holders). Y una marca `serial` que se enciende la primera vez que supera el
umbral de lanzamientos en 24 h y **ya no se apaga**.

La señal principal ("cuántos tokens lanzó este creador en 24 h") es `store.launchesInWindow()`.

Los lanzamientos pueden venir del stream o de dev-history (lanzamientos **anteriores** a que
empezáramos a escuchar). Cuentan igual.

---

## 3. El presupuesto REST: a quién se pregunta y en qué orden

**Primero, un matiz a tu planteamiento.** "18.000 lanzamientos al día no caben en 1 req/s" no
se cumple con los datos: 1 req/s son **86.400 peticiones al día**, y dev-history responde por
**creador**, no por token. En la captura hubo 7.812 creadores. Simulé la política completa sobre
las 10,5 h reales (en tiempo de evento, a 1 req/s):

| Prioridad | Peticiones | Descartadas | Espera media |
|---|---|---|---|
| suspect (re-consulta de seriales) | 6.370 | 0 | 3 s |
| graduation | 1.050 | 0 | 4 s |
| new-creator | 7.517 | 0 | 2 s |
| known-creator | 94 | 0 | 4 s |

Total ≈ 15.000 peticiones, **~0,4 req/s de media**. Cabe. La prioridad sigue siendo necesaria
para los picos (al conectar, tormentas de lanzamientos) y si el plan o el volumen cambian.

**El orden (tu criterio, con un cambio):**
1. **suspect:** creadores por encima del umbral, **re-consultados cada 10 min aunque dejen de
   lanzar**. Este es mi cambio: tú ponías las alertas arriba (de acuerdo), pero además hay que
   *repetir* la pregunta. El colapso de liquidez es un evento en el tiempo y los **holders solo
   existen en REST**: el stream no tiene recuento de holders. Sin re-consultas, la señal 2 no
   tiene material.
2. **graduation:** donde hay dinero de verdad (de acuerdo).
3. **new-creator:** primera vez que vemos a un creador. dev-history nos cuenta lo que lanzó
   **antes** de que empezáramos a escuchar (resuelve el "arranque en frío").
4. **known-creator:** ya lo conocemos; solo se vuelve a preguntar si la respuesta tiene >6 h.
   Nuestro propio stream ya cuenta ese lanzamiento.

Reglas: una sola petición en cola por creador (si llega otra de más prioridad, sube de clase);
si la cola se llena, se descarta la más vieja de la clase más baja; si una espera más de 30 min
se descarta (la respuesta ya estaría caducada). Todo contado en `/health`.

Sin API key, el mismo código funciona en modo **simulado** (no envía nada, solo cuenta). Así se
midió la tabla de arriba.

---

## 4. Acotar la memoria: tokens sí, creadores no

**Tokens:** se olvidan por inactividad, medida en tiempo de evento:
- En curva: **60 min** sin actividad. El 90 % no tiene ningún evento pasados 5 minutos.
- Graduado: **24 h**. Es donde ocurre el drenaje.
- Si aun así se supera el máximo (100.000), se van primero los de curva y luego los más inactivos.

**Al olvidar un token no se pierde lo importante:** su resumen (etapa, pico, liquidez final,
holders) se **pliega** en el registro de ese lanzamiento dentro de su creador.

**Creadores:** una regla distinta, como pediste.
- Uno normal se guarda **24 h desde la última vez que se le vio** (la configuración obliga a
  que sea ≥ la ventana de la señal 1: olvidarlo antes reiniciaría su cuenta).
- Uno **serial** (alguna vez superó el umbral) se guarda **7 días**. El creador de 48 tokens es
  justo lo que no queremos olvidar.
- Si se supera el máximo (200.000), se van primero los no seriales.

**Medido con las 10,5 h:** pico de **4.856 tokens** a la vez, ~143 MB de heap, 65 MB al final.

---

## 5. ¿Sobrevive el estado a un reinicio? Sí, releyendo el log crudo

**Decisión:** al arrancar en directo, el sistema **relee las últimas 24 h** de
`data/live/lifecycle-*.jsonl` (lo que la fase 2 ya guarda) con la misma máquina de estados, y
después se conecta.

**Por qué no bastaba con dev-history:** reconstruye a un creador en una llamada, **pero solo si
sabes a quién preguntar**. Tras reiniciar no lo sabes: te enteras de que un creador es serial
cuando vuelve a lanzar. Y nuestras propias lecturas de liquidez (el colapso como evento en el
tiempo) no están en dev-history.

**Por qué no un fichero de "snapshot":** el log crudo **ya es** la persistencia. Sin segundo
formato, sin versión de esquema que mantener, sin dependencias (`docker compose up` sigue
funcionando igual). Los topes de disco por defecto (1 GB de lifecycle) cubren ~30 h, más que
las 24 h de la ventana.

**Coste:** releer 10,5 h tarda ~1 minuto. Mientras tanto `/health` responde (503 hasta que el
stream esté en vivo). El solapamiento entre lo releído y el backfill del reconectar es inocuo
porque aplicar dos veces el mismo evento no cambia nada (siguiente punto).

---

## 6. Eventos desordenados y repetidos

**El problema:** el backfill trae eventos viejos después de otros nuevos; el replay de los dos
niveles de disco tampoco va en orden; y todo puede llegar dos veces.

**La regla general:** el estado **nunca se fía del orden de llegada**.
- **El reloj es la "marca de agua":** el `block_time` más reciente visto (con un tope de 60 s por
  encima de la hora local, para que un timestamp absurdo del futuro no expulse todo).
- **Las etapas solo avanzan.** Una graduación que llega antes que su `token_create` crea el
  token ya graduado; cuando llega el `token_create`, rellena la fecha de nacimiento sin tocar
  la etapa.
- **"Hora de X" = la más temprana.** Si stream y dev-history discrepan, gana la más antigua,
  en cualquier orden.
- **Las lecturas se ordenan por posición on-chain** (slot, transacción, instrucción). Una
  lectura vieja se guarda en su sitio del histórico, pero **nunca pisa** la última.
- **Los lanzamientos van por mint**: un duplicado no suma.
- **Liquidez que llega antes que su token** espera en un búfer acotado (5.000 mints, 10 min) y
  se aplica cuando aparece el token.
- **Un evento demasiado viejo no resucita un token ya olvidado** (este lo encontró un test:
  releer los mismos ficheros devolvía a la vida tokens expulsados). Su lanzamiento sí cuenta.

**Cómo se demuestra:** tests que aplican los mismos eventos en **8 órdenes barajados** y
exigen un estado **idéntico**, y otro que lo aplica todo **dos veces**.

**Límites conocidos (dichos, no escondidos):**
- Un `swap` que llega antes que su token se descarta (no se guarda en el búfer: el 99 % son de
  tokens ajenos y lo vaciarían). El siguiente swap vuelve a dar el valor actual.
- En el primer segundo tras arrancar aún no sabemos el precio de SOL; esas lecturas de curva se
  omiten y se cuentan (`unpricedReadings`: 92 en 10,5 h).
- dev-history sobre un token que aún no seguimos solo se guarda en el creador.

---

## 7. Lo que sale al pasar las 10,5 horas (material para la fase 4)

`npm run analyze` (0 rechazos, 411.383 eventos, 58 s):

- **230 creadores superan 10 lanzamientos**; lanzaron 7.442 de los 18.055 tokens.
  Distribución: 6.436 creadores con 1 token, 842 con 2–3, 430 con 4–10, 175 con 11–30,
  49 con 31–100, 12 con más de 100 (el mayor: 320 en 5 h).
- **1.728 graduaciones**, 326 de creadores seriales.
- **640 tokens "colapsados"** según el stream (liquidez del lado de la cotización ≥ 1.000 $ y
  luego ≤ 5 $). **Solo 32 son de creadores seriales.**

**Esto es importante y hay que mirarlo en la fase 4, sin cambiar todavía las reglas:**
- La mayoría de los creadores con muchos lanzamientos **casi nunca gradúan** (los 12 más
  prolíficos: 0–7 graduados de 100–320). Parecen *spammers* de lanzamientos, no el patrón
  "48 tokens que gradúan y se vacían" observado antes. Con el umbral >10, la señal 1 sola
  marcaría a 230 creadores; las señales 2 y 3 serán las que separen.
- La mayoría de los colapsos son de creadores con 1 token. Dos lecturas posibles, sin
  verificar: operadores que **usan una cartera nueva por token** (la señal 1 no los ve), o
  retiradas de liquidez que no son rug. Hay que mirarlo con dev-history.
- Con los 40 minutos de swaps que quedan en disco, los colapsos detectados suben de 640 a
  **814** (74 de seriales) en esa pasada de 3,37 millones de eventos: sin swaps nos
  perdemos drenajes por venta. (Esa pasada: heap pico ~207 MB.)

---

## 8. Observabilidad

`/health` añade una sección `state`: tokens seguidos (por etapa), creadores conocidos,
seriales y los que están ahora por encima del umbral, lanzamientos y graduaciones vistos,
lecturas guardadas, eventos tardíos, peticiones REST (enviadas, correctas, fallidas, pendientes,
**descartadas por presupuesto** por clase, espera media) y **memoria** (heap y RSS). Y una línea
extra en el log cada 30 s.

---

## 9. Tests

- **201 tests**, cobertura de `src/state` ~97 % de líneas.
- Escribiendo los tests aparecieron **3 errores reales**, ya corregidos: releer eventos
  resucitaba tokens olvidados (lo detectó el test de arranque en caliente); la fecha de
  nacimiento de dev-history se perdía si llegaba antes que el `token_create` (lo detectó un
  test nuevo, ver abajo); y el presupuesto REST podía regalar peticiones si el reloj
  retrocedía (lo vi al escribir su test). Además, el test de permutaciones reveló que un swap
  anterior a su token cambiaba el resultado: ahora es un límite explícito y probado.
- **Prueba de mutaciones:** rompí a propósito 21 piezas críticas (etapa que retrocede,
  lectura vieja que pisa a la nueva, duplicados que cuentan dos veces, ventana de 24 h
  ignorada, seriales olvidados como normales, graduados olvidados como tokens de curva,
  prioridades invertidas, presupuesto ilimitado, pendientes que nunca se aplican, tope de
  futuro quitado, swaps ignorados, `uri` obligatoria, readline, etc.).
  Al principio **una no se detectaba** ("la fecha más temprana gana": ningún test tenía dos
  fuentes con fechas distintas). Añadí ese test, que además destapó el segundo error de arriba.
  **Ahora los tests detectan las 21.**

---

## 10. Qué NO hace todavía (a propósito)

- No decide nada: no hay detector ni alertas (fase 4). Solo usa el umbral de la señal 1 para
  decidir a quién recordar más tiempo y a quién preguntar primero.
- No hay dashboard (fase 5).
- Sigue suscrita al firehose completo de swaps; la mejora (segunda conexión filtrada por los
  mints que seguimos) ya tiene la lista que necesitaba, pero no está hecha.
- El cliente REST de la fase 1 mantiene su propio `LiquidityHistory`, que ahora duplica lo que
  guarda la memoria. Se puede quitar en una limpieza posterior.
