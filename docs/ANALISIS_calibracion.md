# Análisis de calibración (antes del detector)

**Versión 2 — captura nocturna del 2026-09-26.** Sustituye a la versión de la captura del
2026-09-25, que solo tenía **40 minutos** de swaps. Las diferencias con esa versión están marcadas
con **[CAMBIA]**, **[SE CONFIRMA]** o **[RETIRO]** (algo que di por bueno y no lo es).

No se ha cambiado ninguna regla ni se ha escrito el detector. Los números que proponen algo llevan
su medida al lado.

## Datos y método

- Captura: `data/live/*-20260926*`, 10 ficheros de ciclo de vida (789 MB) y 315 de swaps
  (16 GB), de 06:39 a 17:00 UTC (**10,3 h**), más el backfill del arranque (desde 05:29).
  **19.447 lanzamientos, 2.109 graduaciones, 166.846 eventos `liquidity`, 16,6 M swaps**, de los
  que 8,7 M son de tokens que seguimos. 0 duplicados, 0 tramas rechazadas.
- **Cambio de método [CAMBIA]:** el replay anterior leía primero todos los ficheros de ciclo de
  vida y luego los de swaps. Con 40 min de swaps daba igual, pero con una noche entera no: los
  swaps llegaban horas después de que el token hubiera sido expulsado de la memoria. Ahora los
  dos niveles se intercalan por `block_time` (`src/calibration/capture.ts`). Los swaps de tokens
  que nunca aparecen en el ciclo de vida se filtran sin parsearlos (7,9 M líneas descartadas).
- Pipeline idéntico al de producción: `StateStore` y enricher simulado, sobre tiempo de evento.
- dev-history consultado el 2026-09-26 a las 20:45 UTC, **3,7 h después del fin de la captura**:
  muestra estratificada de 270 creadores.
- Reproducible (el resultado de la extracción se guarda en `data/calibration/`, fuera de git):
  ```bash
  npm run build
  node --max-old-space-size=8192 dist/calibration/extract.js 20260926      # ~35 min
  node dist/calibration/report.js 20260926 [--tradable]                    # segundos
  node --env-file=.env dist/calibration/solami.js 20260926                 # REST, ~5 min
  node --expose-gc dist/calibration/extract.js 20260926 --memory [--warm 20260925]
  node --expose-gc dist/calibration/rest-memory.js 20260926 [--serial-listed 100] [--warm]
  ```
  La versión de 40 min se reproduce con `src/calibration.ts` del commit `39ae21a`.

---

## 0. Lo primero: mi métrica de colapso estaba mal para los graduados [RETIRO]

La métrica de la fase 3 define un colapso como "liquidez del lado SOL ≥ 1.000 $ y después
≤ 5 $", **sumando todos los pools del token**. Pero al migrar, meteora_dbc deja en el **pool de
curva** ~11–14 SOL (1.300–1.700 $) con los que nadie puede operar. Un token cuyo pool real
(damm2) está vaciado sigue sumando esos ~1.300 $ y parece "vivo".

Lo descubrí al cruzar con Solami (§5): de 100 graduados que mi métrica daba por vivos, **31
tenían el pool damm2 con 0,003–0,04 SOL y el de curva con 11–14 SOL**. Solami los daba a 1–5 $
con **146–213 holders**, que es exactamente el patrón que originó el proyecto.

He añadido una segunda métrica, **liquidez negociable**: para un graduado, solo cuentan los pools
que no son de curva (pumpfun, meteora_dbc, raydium_launchpad). Comparadas sobre los 2.109
graduados:

| | Tokens |
|---|---|
| Colapsan con las dos | 710 |
| **Solo con la negociable** | **486** (485 meteora_dbc → damm2, vaciados por ventas) |
| Solo con la de la fase 3 | 3 |
| Ninguna | 910 |

**Salvo que se diga lo contrario, lo que sigue usa la métrica negociable para los graduados.**
Arreglarla en el store es tarea de la fase 4 (anotado en `CLAUDE.md`).

## 0b. Qué hay dentro de los colapsos

| Grupo | Tokens | Qué es (verificado con los eventos) |
|---|---|---|
| **A. El creador aporta liquidez y la retira** | **422** | Lanza en meteora_dbc, abre él mismo un pool en pumpswap con 84,99 SOL y ~8 min después retira todo |
| **C1. El creador retira el pool de migración** | **268** | meteora_dbc → damm2. El creador no aporta nada, pero **recibe la liquidez de la migración** y la retira. El primer `remove` se lleva el 100 % del SOL y **es** el colapso (266 de 278, mismo evento) |
| **C2. Dev dump: el creador vende** | **462** | meteora_dbc → damm2. El creador vende sus tokens en el pool damm2 y lo vacía. **Una sola venta** (p50), en el mismo segundo que el colapso (420 de 462). Pools pequeños: pico p50 = 1.821 $ |
| C3. Vaciados por ventas de terceros | 44 | Muchos vendedores; sin patrón claro |
| B. Curva que vuelve a cero | 2.799 | Nunca gradúa: pump.fun (2.746), raydium_launchpad (38)… Con swaps completos ahora se ven todas (antes, 355). Es la muerte normal de un token en la curva, **no hay pool que vaciar**. Fuera del alcance |

**Rugs de pool (graduados que colapsan): 1.196 = A + C1 + C2 + C3 + 0.** Es el denominador de
todo lo que sigue.

---

## 1. La señal principal: "el creador aporta liquidez a su propio token" [SE CONFIRMA]

| | 40 min de swaps | Noche completa |
|---|---|---|
| Tokens que la cumplen | 356 | **431** (431 wallets distintas) |
| Colapsan | 348 (97,8 %) | **422 (97,9 %)** |
| Sin resolver | 6 de 8 (aportaron al final) | 5 de 9 (aportaron ≤ 310 s antes del fin) |

**Precisión:** 422 de 431 = 97,9 %. De los 9 que no colapsan, 5 aportaron entre 18 y 310 s antes
de que acabara la captura (no se puede saber qué pasó). Los otros 4 son **aportes simbólicos**
(0,01–0,12 SOL) y siguen vivos 2,6–6,7 h después. Sin los 5 sin resolver: **422 de 426 = 99,1 %**.

**Recall:**

| Denominador | Cubre |
|---|---|
| Todos los rugs de pool (1.196) | **422 = 35,3 %** |
| Rugs por `liquidity remove` (690) | 422 = 61,2 % |
| Rugs por ventas (506) | 0 |

**[CAMBIA]** En la versión anterior no di un recall limpio (42,8 % de 814 mezclaba curvas). Con
el denominador bien definido, **la señal principal ve un tercio de los rugs de pool**, no casi
todos. Ve el grupo A entero y nada de C1, C2 ni C3.

**Margen de aviso** (del aporte del creador al colapso, n = 422):

| mín | p5 | **p10** | p25 | p50 | p75 | p90 | máx |
|---|---|---|---|---|---|---|---|
| 59 s | 189 s | **322 s** | 368 s | 485 s | 541 s | 597 s | 3 h |

- **Menos de 60 s:** 1 caso. **Menos de 2 min:** 11 (2,6 %). Ninguno en el mismo segundo.
- Hay que restar la latencia del stream: el evento llega ~0,4–1,9 s después del bloque (medido
  en vivo sobre 105 eventos).
- **[CAMBIA]** Antes: p10 = 218 s, p50 = 378 s (n = 341). Con más datos, el aviso es **mejor**
  en la cola baja.
- **Lo que se puede prometer:** aviso de **≥ 3 min en el 95 % de los casos y ≥ 5 min en el
  90 %**, para el tipo de rug que ve esta señal.

**Otros datos:**
- **Ritmo:** 40–47 casos por hora, constante toda la noche. Es una operación industrial con una
  wallet nueva por token.
- **Extracción neta** (SOL retirado − SOL aportado por el creador): **5.810 SOL** en 10,3 h.
  Por token: p10 = 2,85, p50 = 10,6, p90 = 14,6 SOL. Ningún creador perdió SOL.
- **[RETIRO] el total anterior (18.498 SOL).** Por token, la distribución es casi la misma que
  antes (2,2 / 8,1 / 14,9). El total depende de unos pocos valores extremos (máximo actual:
  1.155 SOL) y no lo he re-verificado. **No usar ese total como cifra representativa.**

## 2. La proporción de ventas [RETIRO como señal independiente]

Con la métrica de la fase 3 parecía confirmarse con n suficiente:

| Graduados (≥ 10 swaps) | Colapsan | No colapsan | AUC |
|---|---|---|---|
| Toda la captura | 0,27 (n = 712) | 0,50 (n = 1.237) | 0,09 |
| 5 primeros min tras graduar, antes del colapso | 0,21 | 0,48 | 0,12 |

**Pero no es independiente:**
- **Es un reflejo de la señal principal.** Los tokens de la señal principal venden poco desde
  el principio (p50 = 0,19 frente a 0,45 del resto, AUC 0,13).
- **Dentro de la señal principal no aporta nada:** AUC 0,40, con n = 8 negativos.
- **Con la métrica corregida, la separación desaparece.** Los rugs que la señal principal no ve
  (dev dumps, sobre todo) **venden más** que los tokens vivos:

  | Métrica negociable | Colapsan | No colapsan | AUC |
  |---|---|---|---|
  | Todos los graduados, 5 min | 0,31 (n = 1.178) | 0,42 (n = 706) | 0,48 |
  | **Sin la señal principal**, 5 min | 0,51 (n = 756) | 0,42 (n = 698) | 0,67 (invertido) |

- **Como regla aparte sirve poco.** "Proporción ≤ 0,1 a los 5 min", sobre tokens sin la señal
  principal, marca 104 tokens de los que colapsan 71 (6 % de los 1.196). Con la métrica de la
  fase 3, 15 de esos colapsos llegaban antes de cumplirse los 5 min (la alerta llegaría tarde).

**Conclusión:** el 0,11 frente a 0,47 de la versión anterior era la señal principal vista desde
otro ángulo. **No la usaría.**

## 3. El patrón de los 85 SOL [SE CONFIRMA, más estrecho]

- **Es todavía más estrecho que antes:** 420 de 422 colapsos del grupo A aportan
  **exactamente 84,99 SOL** (p5 = p90 = 84,99; los otros 2, < 80 SOL). Antes: 339 de 348 en 84,9–85,1.
- **Como regla sola** ("cualquier `add` de 84,9–85,1 SOL"): 425 tokens y 420 colapsan (98,8 %).
  Los 5 restantes son los sin resolver del final de la captura, así que es el **100 % de los
  resueltos**.
- **[RETIRO]** Dije que 85 SOL era "lo mismo que deposita una graduación real de pump.fun". En el
  stream, **las migraciones de pump.fun no aparecen como `liquidity add`**: solo 1 de 478 graduados
  de pump.fun lo tiene. Nadie más que estos creadores añade 85 SOL.
- **¿Sirve sola? No añade nada.** Marca el mismo conjunto que la señal principal, quitando los 4
  aportes simbólicos: 0 casos nuevos. Además, el operador la evade cambiando una cifra. **Sirve
  como huella de confirmación** (misma banda → mismo operador probable), no como regla. Filtrar
  los aportes simbólicos se consigue igual con un mínimo de SOL en la señal principal.

## 4. Los colapsos "sin aclarar" [CAMBIA: ya están clasificados]

**Los 111 concretos de la pasada anterior no se pueden reexaminar.** Sus swaps no están: la
captura del 25-09 solo guardó swaps de 15:08 a 15:48 UTC. He clasificado el grupo equivalente de
esta noche (graduados que colapsan sin aporte del creador).

- **Con la métrica de la fase 3 son 291:**
  - 268 son el mecanismo C1.
  - 21 son vaciados por ventas.
  - 2 no tienen un mecanismo claro.
- **Con la métrica negociable son 774** (C1 + C2 + C3 de la tabla 0b). Sobre todo aparecen los
  **462 dev dumps**, que antes el pool de curva ocultaba.

**Ninguno de estos mecanismos avisa con antelación desde su propio evento.** El `remove` de C1
y la venta de C2 **son** el vaciado. Sirven para etiquetar el rug al instante, no para
anticiparlo.

**Lo que sí anticipa parte de ellos es la reincidencia.** C1 y C2 no son wallets de un solo uso:
- 774 tokens de 415 creadores.
- 289 tokens de creadores con > 10 lanzamientos.
- 222 dev dumps son de los 22 seriales que gradúan > 50 %.

Regla medida (no propuesta como definitiva): **"al graduar, el creador ya vació otro token
antes en la captura"**.

| Regla | Marca | Colapsan | Recall de 1.196 | Aviso desde la graduación (p10 / p50 / p90) |
|---|---|---|---|---|
| Reincidente | 435 | 359 (82,5 %; 11 sin resolver) | 30,0 % | 36 s / 129 s / 1.132 s |
| **Señal principal O reincidente** | **866** | **781 (90,2 %)** | **65,3 %** | – |

Un detalle sin verificar: una sola wallet que **no** es el creador (`8TPACXaK…`) retira liquidez
en 12 tokens de creadores distintos. Puede ser una wallet de comisiones del launchpad o un
operador. No lo he investigado.

## 4b. La señal 1 y el patrón original [CAMBIA]

- **Los seriales que gradúan > 50 %** (22 creadores) tienen 442 graduados, de los que
  **289 colapsan (65,4 %)**. Con la métrica de la fase 3 eran 59.
- **[RETIRO] mi hipótesis anterior.** Pensaba que el patrón original no se veía porque faltaban
  swaps. **Con los swaps completos, la métrica de la fase 3 seguía viendo solo 60.** La causa era
  la métrica (el pool de curva), no los swaps.
- **"> 10 lanzamientos" a secas** marca 8.218 tokens, de los que colapsan 1.452 (17,7 %). No es
  comparable con el 1,0 % anterior porque ahora el denominador incluye las curvas que vuelven a
  cero. Sigue sin servir sola.
- **La bimodalidad se mantiene:** 173 seriales no gradúan nada, 46 gradúan ≤ 10 %, 14 están entre
  medias y 22 gradúan > 50 %.

## 5. Discrepancia con Solami (`liquidity_usd` de dev-history)

Muestra con semilla fija: 170 colapsados (70 A, 70 C, 30 B) y 100 graduados vivos al final según
la fase 3 (pico ≥ 1.000 $, final > 5 $). Consultado 3,7 h después del fin de la captura. "Colapso
según Solami" = `liquidity_usd` ≤ 5 $.

| Métrica nuestra | Coinciden | Solami da MÁS | Solami da MENOS |
|---|---|---|---|
| Fase 3 (todos los pools) | 214 de 270 (79 %) | 22 | 34 |
| **Negociable** | **240 de 270 (89 %)** | 23 | 7 |

**Por qué falla cada dirección** (cada caso trazado con las reservas por posición on-chain):

- **Solami da MÁS, 16 de 22: Solami se queda con el valor anterior al vaciado.**
  - Casos: 12 del grupo A y 4 de C.
  - Los eventos muestran un `liquidity remove` que deja el pool con 0,000 SOL. Aun así, Solami
    devuelve 21–45 k$, que es ≈ 2 × nuestro pico (los dos lados del pool justo antes del tirón).
  - 3,7 h después sigue sin actualizarse. **Afecta al 17 % de los rugs del grupo A.**
  - **[RETIRO]** Dije que Solami "valora el lado del token a un precio que ya no existe". Tracé mal
    ese caso: mi foto de pools iba por orden de llegada, y un swap del mismo segundo, anterior al
    vaciado, llegaba después. Rehecho por posición on-chain, el pool está vacío.
- **Solami da MÁS, 5 de 22: curvas vaciadas.** Solami las valora en 15–947 $, con 1–3 holders.
  Nuestra curva está a 0.
- **Solami da MÁS, 1 de 22:** 5,06 $ frente a 4,34 $. Está en el borde del umbral.
- **Solami da MENOS, 31 de 34: el error era nuestro** (§0). Pool damm2 vacío y SOL varado en el
  pool de curva. Con la métrica negociable, 27 pasan a coincidir.
- **Solami da MENOS, 2 casos: Solami no ve el pool de pumpswap que abrió el creador.** Esos pools
  tenían 1.295 y 1.521 SOL al final de la captura y Solami da 0,00–0,02 $. Son dos de los
  "aportes simbólicos" de §1.
- **Solami da MENOS, 1 caso:** sin explicar (11 SOL en damm2, Solami 2,23 $).

**Para el README:**
- El `liquidity_usd` de Solami **no sirve para detectar el tirón de liquidez**: en 1 de cada 6
  casos del grupo A sigue mostrando el pool lleno horas después.
- **Sí coincide** con los pools vaciados por ventas.
- Nuestra métrica, con los pools de curva excluidos, coincide con Solami en el 89 % de la
  muestra. Las discrepancias restantes van casi todas en la dirección "Solami no registra un
  `remove`".

---

## 6. Conclusión

**Se mantiene:**
1. **Señal principal** (el creador aporta liquidez a su propio token recién lanzado).
   - 97,9 % de precisión y 99,1 % en los casos resueltos, con 431 wallets distintas.
   - Aviso de ≥ 3 min en el 95 % de los casos.
   - **Pero solo cubre el 35 % de los rugs de pool.**
2. **El importe de 84,99 SOL**, como huella del operador, no como regla.

**Retiro:**
- La proporción de ventas como señal.
- El total de 18.498 SOL.
- La explicación anterior de la discrepancia con Solami.
- "85 SOL = graduación de pump.fun".

**Nuevo:**
- La métrica de liquidez debe excluir el pool de curva tras la graduación. Sin eso, el patrón
  original era invisible.
- C1 (el creador retira la liquidez de migración) y C2 (dev dump) son el 61 % de los rugs de
  pool. Ninguno avisa por su propio evento, pero "señal principal O reincidente" llega al
  **90,2 % de precisión y 65,3 % de recall**, con un aviso p50 de 129 s en la parte
  reincidente.

**Sigue sin responder:**
- Quién financia las wallets nuevas: el SOL nativo no está en los datos.
- Si la reincidencia se sostiene con creadores que la captura no ve lanzar. La ventana es de
  10 h; dev-history daría el histórico.

## 7. Ingeniería (del `/health` de la noche)

Detalle y acciones para la fase 4 en `CLAUDE.md`, sección "Pendiente para la fase 4".

- **Memoria.** El store no es el problema:
  - Retiene **84 MB** al final de la noche (**88 MB** con arranque en caliente), medido con GC
    forzado cada 30 min.
  - Crece ~7 MB/h solo por creadores, y debería estabilizarse a las 24 h.
  - Lo que crece es `LiquidityHistory` en el cliente REST: cada re-consulta de un serial guarda
    una lectura por cada token listado. Con la mezcla de peticiones de la noche son
    **1,83 M lecturas ≈ 662 MB**, que es casi el heap que dio `/health` (668 MB).
  - Esta medición es **sintética**: respuestas con la forma real de dev-history, pero con el
    número de tokens estimado.
  - **No se estabiliza** hasta el tope (~6 M lecturas, ~2 GB).
- **404 (1.170):**
  - Son `no creation record`: preguntamos antes de que Solami indexe el token.
  - En vivo, 51 de 105 consultas lanzadas a 0–2 s dieron 404, y **las 51 dieron 200 a los
    5–8 s**.
  - Sin congestión serán más: el 77 % de los `new-creator` se enviarían a menos de 10 s de la
    creación.
- **Descartes de `new-creator` (1.044):**
  - Con arranque en caliente (el proceso cargó el día anterior), el replay reproduce el volumen
    real (27.804 peticiones frente a ~29.000).
  - **El 67 % del presupuesto se va en re-consultar seriales**, 421 incluyendo los de ayer, cada
    10 min, lancen o no.
  - La espera de `new-creator` sube a p90 = 208 s.
  - No reproduzco los 1.044 descartes exactos: la simulación no tiene latencia real ni 404.
  - La señal principal **no necesita REST**. Si la fase 4 lo usa para creadores nuevos, primero
    hay que limitar esas re-consultas.
