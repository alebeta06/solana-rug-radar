# Resumen de la Fase 4: el detector

Este documento explica en lenguaje sencillo qué hace cada pieza de la fase 4 y **por qué** se
decidió así, para poder defenderlo ante el jurado o contarlo en un post.

---

## Qué hace la fase 4, en una frase

El sistema ya no solo recuerda: **avisa**. Cuando ve algo que, medido sobre una noche real,
acaba en un rug casi siempre, lanza una alerta con su nivel, su evidencia y **cuánto fiarse de
ella**. Después comprueba si el rug ocurrió de verdad, y así mide su propia precisión en vivo.

---

## 1. Las reglas salen de los datos, no de la idea inicial

Empezamos el proyecto con tres señales: muchos lanzamientos en 24 h, colapso de liquidez con
muchos holders y liquidez final repetida. La calibración con una noche entera del stream
(`docs/ANALISIS_calibracion.md`) demostró que **ninguna de las tres sirve tal cual**. Las reglas
de esta fase son las que sí aguantaron los datos.

### Alerta ROJA: "el creador mete liquidez en su propio token"

- **Qué es:** un evento `liquidity` de tipo `add` cuyo proveedor es el creador del token.
- **Sin umbral.** Es un hecho del evento, no hay que decidir "a partir de cuánto".
- **Por qué funciona:** un creador legítimo casi nunca abre un pool propio con su dinero. Los
  que lo hacen esa noche lo hicieron para atraer compradores y llevárselo todo unos 8 minutos
  después.
- **Precisión: 97,9 %** (422 de 431 alertas acabaron en rug, de 431 wallets distintas).
- **Aviso:** en el 95 % de los casos llega al menos 3 minutos antes del vaciado (p5 = 189 s,
  mediana 485 s).
- **Huella de 84,99 SOL:** 420 de los 422 aportaron exactamente 84,99 SOL. Va en la alerta como
  **confirmación**, no como regla. No añade ningún caso nuevo (marca los mismos tokens) y el
  operador la esquivaría cambiando un número.

### Alerta ÁMBAR: "este creador ya vació otro token"

- **Qué es:** un token se gradúa, y su creador ya tiene un rug confirmado de otro token, con hora
  anterior.
- **Precisión: 82,5 %** (359 de 435). Es un "ojo con este", no un "huye".
- **Aviso:** mediana de 129 s desde la graduación.

### Las precisiones nunca se promedian

Juntas, las dos reglas dan 90,2 % de precisión y cubren el 65,3 % de los rugs de pool. Ese
número describe **el detector**, pero nunca aparece en una alerta. Quien recibe una alerta roja ve
97,9 %, y quien recibe una ámbar ve 82,5 %. Si mezcláramos, la roja parecería menos fiable y la
ámbar más de lo que es.

---

## 2. El "rug confirmado": la pieza que lo cierra todo

Una alerta es una predicción. El **rug confirmado** es el hecho:
- un token graduado,
- cuya liquidez **negociable** llegó a $1.000,
- y después bajó a $5 o menos.

Esos umbrales están en `config/config.json` (`liquidityCollapse`), a la vista y configurables.

Hace tres cosas:
1. **Cierra las alertas** de ese token con el tiempo de aviso. Ejemplo real de la noche: "alerta
   roja a las 06:43:59 → vaciado confirmado a las 06:49:48, 349 s después, `creator-pull`".
2. **Mide la precisión en vivo.**
   - Una alerta sin rug a los 60 minutos cuenta como "no confirmada".
   - Si el rug llega después, pasa a confirmada.
   - `/health` enseña, por nivel: disparadas, confirmadas, no confirmadas, abiertas, precisión y
     mediana de aviso.
3. **Alimenta la regla ámbar**: el detector apunta quién vació qué.

Además apunta **cómo** se vació, que es lo que la fase 5 dibujará:

| Mecanismo | Qué pasó |
|---|---|
| `creator-pull` | El creador retira la liquidez que él mismo puso (el caso rojo) |
| `migration-pull` | El creador retira la liquidez que recibió al migrar, sin haber puesto nada |
| `dev-dump` | El creador vende sus tokens en el pool |
| `sell-off` / `third-party-remove` | Lo vacían otros |

---

## 3. "Liquidez negociable": la corrección que destapó el patrón original

Al migrar, meteora_dbc deja entre 11 y 14 SOL en su pool de curva, con los que ya nadie puede
operar. La memoria de la fase 3 sumaba todos los pools, así que un token con el pool real vacío
seguía pareciendo vivo con unos $1.300. Eso escondía **486 rugs**, entre ellos el patrón que
originó el proyecto (150–213 holders, Solami a $1–5).

Ahora, una vez graduado un token, **solo cuentan los pools que no son de curva**.

**Un fallo que encontré al validar.** pump.fun anuncia su pool AMM con un `pool_create` que dice
dex `pumpfun`, y ese mismo pool luego opera como `pumpswap`. La memoria guardaba el **primer**
dex que veía, así que trataba el pool principal como "de curva" y lo excluía. Cuando se vaciaba
un pool secundario pequeño, el detector creía que el token entero había muerto: **30 rugs
falsos** en la noche.

Ahora el dex de un pool es el del evento que dio su última lectura, que es donde de verdad se
opera. Hay un test con ese caso exacto.

---

## 4. Lo que el detector NO ve (y lo decimos)

Un 35 % de los rugs de pool no tiene aviso previo:
- **Dev dumps** (462 esa noche): el creador vende de golpe.
- **Retiradas de la liquidez de migración** (268): el creador retira lo que recibió al migrar.

Pasa cuando el creador no tiene un rug anterior. En ambos casos **el evento es el vaciado**: una
sola transacción, en el mismo segundo. No hay nada antes que mirar.

El detector los confirma al instante y recuerda al creador, así que su siguiente token sí
dispara la ámbar. Pero el primero no se puede anticipar. Está en el README como limitación.

---

## 5. Las señales descartadas, y por qué

Están escritas en el README y en la cabecera de `src/detector/detector.ts`:

| Señal | Por qué se cayó |
|---|---|
| > 10 lanzamientos en 24 h (sola) | 1,0 % de precisión: la mayoría de seriales lanzan spam que nunca gradúa. Se queda solo para priorizar consultas REST |
| Proporción de ventas | Era la señal roja vista desde otro ángulo. Con la métrica corregida se invierte |
| Liquidez final repetida | Los pools vaciados acaban en ~0. Los "valores repetidos" eran el SOL varado en el pool de curva |
| Reutilización de nombres | 52 % frente a 50 %: no separa |
| `bundlers_count` | 0–2 en los dos grupos |
| Velocidad de graduación | Tokens legítimos también gradúan en 0 s |

---

## 6. Cómo está construido

- **El store avisa, el detector decide.** El store ya tenía 453 líneas y no podía cargar también
  con las alertas. Ahora avisa al detector (un "listener") después de aplicar cada evento, y
  también cuando suelta eventos que esperaban a su token. Así, un aporte de liquidez que llega
  antes que el `token_create` sigue disparando la roja (hay test).
- **Sin REST.** Las dos alertas y la confirmación usan solo el stream. El detector funciona sin
  API key REST.
- **Alertas como registros**, no como líneas de log. Cada alerta lleva:
  - nivel, regla, mint, creador;
  - hora del bloque y hora de recepción (su resta es nuestra latencia);
  - origen: tiempo real o backfill tras reconexión;
  - posición on-chain del evento (firma, slot, índices);
  - evidencia: importe, pool, huella y rugs previos;
  - la precisión medida de su regla;
  - un enlace al mint en Solscan.
- **Sin duplicados.** Una alerta por nivel y token, siempre, también tras reiniciar.
- **El registro** (`data/alerts/detector-AAAAMMDD.jsonl`, solo en vivo): cada alerta y cada rug
  en una línea JSON. Al arrancar se releen los últimos 7 días. Sirve para tres cosas:
  - que un reinicio no repita alertas;
  - que la ámbar no olvide a los creadores que vaciaron algo (el arranque en caliente solo relee
    el ciclo de vida, y ahí los dev dumps no se ven);
  - medir la precisión en vivo a lo largo de días.

  Un replay nunca escribe ahí, para no mezclar pruebas con evidencia real.
- **El arranque en caliente no dispara alertas.** El detector se engancha después: la historia
  de ayer no es una alerta de hoy.

---

## 7. Los dos arreglos de ingeniería

**Memoria.** `LiquidityHistory` del cliente REST guardaba una lectura por token en cada respuesta
y **nadie la leía**. Era la causa de los 668 MB. La he **borrado** (lo decidiste tú entre borrar
o acotar). Con la misma carga de la noche:

| | Antes | Después |
|---|---|---|
| Cachés REST | 662 MB, sin techo hasta ~2 GB | **88 MB**, acotadas por nº de entradas (techo estimado ~200 MB) |
| Store + detector (replay de la noche entera) | 84–88 MB | **82 MB** |

**404.** Solami responde `no creation record` si le preguntas por un token que aún no ha
indexado. Ahora el enricher **no consulta un mint con menos de 10 s de vida**, contados desde su
creación en el bloque.
- **Para las graduaciones** se cuenta desde el nacimiento del token: meteora_dbc gradúa en el
  mismo segundo en que nace.
- **La cola no se bloquea:** una petición demasiado joven espera su turno sin frenar a las que
  van detrás.

**Lo que NO toqué:** el reparto del presupuesto REST (el 67 % se va en re-consultar seriales).
Cambiarlo invalidaría la calibración. Queda documentado en `CLAUDE.md`.

---

## 8. Validación: la noche entera por el detector

`src/calibration/validate.ts` pasa la captura completa (325 ficheros) por el detector real,
con el mismo cableado que `main.ts`, y compara con el análisis:

| | Detector | Análisis |
|---|---|---|
| Roja: disparos / confirmadas | **431 / 422** | 431 / 422 |
| Roja: aviso p5 / p10 / p50 / p90 | **189 / 322 / 485 / 597 s** | 189 / 322 / 485 / 597 s |
| Ámbar: disparos / confirmadas | 436 / 360 (82,6 %) | 435 / 359 (82,5 %) |
| Ámbar: aviso p10 / p50 / p90 | 36 / 129 / 1.132 s | 36 / 129 / 1.132 s |
| Roja o ámbar: precisión | 90,2 % | 90,2 % |
| Alertas duplicadas | 0 | – |
| Rojas con la huella de 85 SOL | 425 | 425 |
| Rugs confirmados | 1.214 | 1.196 |

**La roja cuadra exacta, hasta el segundo.** La diferencia en rugs (+18) la he revisado token a
token:
- **8** colapsaron y luego se recuperaron algo. El detector confirma en el momento del colapso;
  el análisis contaba los que seguían colapsados al final.
- **9** tienen pools cotizados en otra moneda (no SOL). El análisis los ignoraba y el detector
  los cuenta, que es lo correcto.
- **1** tiene más de 8 pools. La memoria guarda 8 y descartó el principal: es un falso positivo
  real, documentado en `CLAUDE.md`.
- **1** es un pool donde el token va como moneda de cotización. El análisis no leía esos swaps
  y el detector sí.
- **1** rug del análisis no aparece en el detector.

La primera validación **no cuadraba** (1.253 rugs). Así encontré el fallo del dex de pump.fun del
apartado 3. Tal como pediste: si no cuadra, el fallo está en el detector.

---

## 9. Tests

219 tests (antes 202). Los nuevos cubren:
- **Roja:** solo el creador dispara, sin duplicados, huella, y el aporte que llega antes que su
  token.
- **Rugs:** la liquidez de curva no cuenta, el pool anunciado como `pumpfun` que opera como
  `pumpswap` sí cuenta, los cinco mecanismos, un pico real mínimo y una sola confirmación por
  token.
- **Ámbar:** dispara con un rug previo; no dispara si la graduación es anterior al rug, aunque
  llegue tarde.
- **Registro:** reinicio sin repetir alertas y recordando al creador; líneas corruptas;
  precisión en vivo abierta → sin confirmar.
- **Enricher:** no consulta antes de 10 s y la cola no se bloquea.
- **Estado:** las pruebas de "cualquier orden de llegada da el mismo estado" cazaron que mi
  primera versión del pico negociable dependía del orden. Lo cambié por el máximo de las lecturas
  de pools negociables, que no depende del orden.

**Prueba de mutación** (los tests pasaron a la primera, así que rompí el código a propósito). 11
roturas, todas detectadas:
- la roja dispara con cualquier proveedor;
- la roja sin dedup;
- se cuentan los pools de curva;
- la ámbar ignora la hora del rug;
- sin `migration-pull`;
- el scheduler ignora los 10 s;
- no se recargan las alertas;
- el store no avisa de la liquidez;
- el rug no exige pico;
- la precisión en vivo nunca resuelve.

Una de ellas (la ámbar ignorando la hora) **sobrevivió** al principio: el test no mandaba los
eventos desordenados. Lo reforcé y ahora la caza.

---

## 10. Qué NO hace todavía (a propósito)

- Dashboard y webhook: fase 5. Las alertas ya salen como registros listos para ambos.
- Reparto del presupuesto REST: sin tocar, documentado.
- El replay de `npm start` y `npm run analyze` leen los ficheros por orden de nombre. Con horas
  de swaps hay que usar el replay intercalado de `src/calibration/`.
