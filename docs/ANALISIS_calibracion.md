# Análisis de calibración (antes del detector)

Datos: `data/live/`, 12,5 h de tiempo de evento (captura del 2026-09-25): 18.055 lanzamientos,
1.728 graduaciones, y swaps **solo de los últimos 40 minutos** (el resto se rotó por el tope de
disco). dev-history consultado el 2026-09-26 para 52 creadores (un día después de la captura).
Reproducible: `npm run build && node --env-file=.env dist/calibration.js --rest`
(`src/calibration.ts`; sin `--rest` no hace falta API key).

No se ha cambiado ninguna regla ni se proponen umbrales nuevos sin el número al lado.

---

## 0. Primero: los "814 colapsos" no son un solo fenómeno

La cifra venía de mi métrica de la fase 3: liquidez del lado de la cotización (SOL) ≥ 1.000 $ y
después ≤ 5 $. Al desglosarla aparecen tres cosas distintas:

| Grupo | Tokens | Qué es (verificado) |
|---|---|---|
| **A. Tirón de liquidez del creador** | **348** | El creador lanza en meteora_dbc (gradúa en el mismo segundo), abre él mismo un pool en pumpswap con **85 SOL**, espera ~6 min y lo retira todo, más lo que metieron los compradores |
| **B. Curva de pump.fun que vuelve a cero** | **355** (330 verificados con `meme`) | Nunca gradúa. Sube al 10–30 % de progreso (mediana 14,9 %) y vuelve al ~0 %: todo lo comprado se revende. Es un pump & dump en la curva, **no hay pool que vaciar** |
| C. Graduados en meteora_dbc sin aporte del creador | 97 | Mecanismo no aclarado |
| Otros | 14 | raydium_launchpad (9), sin `token_create` (2), pump.fun graduados (2), etc. |

Consecuencias:
- Las preguntas 1 y 2 se responden abajo sobre los 814, como pediste, pero **el grupo A es el
  único que es claramente un rug de pool**.
- **El "daño" que di en la fase 3 estaba inflado.** Pico − final cuenta los 85 SOL que el propio
  operador metió y recuperó. El dato correcto para el grupo A es la **extracción neta** (SOL
  retirado − SOL aportado por el creador): **18.498 SOL (~2,2 M$ a 119 $/SOL) en 348 tokens**,
  mediana de 8,1 SOL por token (p10 2,2, p90 14,9). **Ningún** creador del grupo A perdió dinero.
- **La métrica y la `liquidity_usd` de Solami no coinciden siempre.** En la muestra REST, 10 de
  30 tokens "colapsados" tienen hoy 20–45 k$ según Solami. Tracé uno (`2UNeWV…`): quedan
  3·10⁻⁹ SOL en el pool de pumpswap y el de damm2 tiene una cantidad enorme del token y ~0 SOL.
  Es decir, el SOL real se fue; la cifra de Solami parece valorar el lado del token a un precio
  que ya no existe. **Verificado solo en ese caso.**
- **Al revés también falla:** 8 de 20 tokens del grupo de control (graduados, "no colapsados"
  según el stream) están hoy a ≤ 5 $ según Solami. Pueden haberse vaciado vendiendo (sin swaps
  no lo vemos) o después de la captura. **No se puede distinguir con estos datos.**

---

## 1. Lanzamientos de los creadores de los 814 colapsos

Lanzamientos de cada creador **dentro de la captura**:

| Lanzamientos del creador | Creadores | Tokens colapsados | % de los 814 |
|---|---|---|---|
| 1 | 668 | 668 | 82,1 % |
| 2 | 24 | 32 | 3,9 % |
| 3–10 | 33 | 38 | 4,7 % |
| > 10 | 34 | 76 | 9,3 % |

759 creadores distintos para 814 tokens: 735 tienen un solo colapso, 14 tienen dos y 10 tres o
más (el máximo, 9).

En el grupo A (el rug de pool) es más extremo: **348 tokens de 345 creadores distintos**. Solo 3
wallets repiten.

**Conclusión:** para el tirón de liquidez, la hipótesis se confirma. Es una wallet por token, y
contar lanzamientos por wallet no los ve.

Una precaución: **tener una sola wallet con un solo token es lo normal para todo el mundo**, no
solo para los que roban. 6.436 de 7.944 creadores lanzaron 1 token, y en el control REST 10 de
20 creadores legítimos también eran wallets nuevas de un solo token. "Wallet nueva" por sí sola
no discrimina.

---

## 2. Cruce: 230 seriales frente a 759 creadores con colapso

| | Creadores |
|---|---|
| En los dos grupos | 32 |
| Solo seriales (> 10 lanzamientos) | 198 |
| Solo con colapso | 727 |

Tokens colapsados de creadores seriales: 76 de 814 (9,3 %). Si se usa como regla, "creador con
> 10 lanzamientos" marca 7.456 tokens, de los que colapsan 76: **precisión del 1,0 %**.

**Pero dentro de los seriales hay dos poblaciones muy separadas**, según qué parte de lo que
lanzan llega a graduar:

| Fracción graduada | Creadores seriales | Sus lanzamientos | Sus colapsos (stream) |
|---|---|---|---|
| 0 | 181 | 5.019 | 32 |
| (0, 10 %] | 35 | 2.144 | 11 |
| (10 %, 50 %] | 2 | 56 | 0 |
| **> 50 %** | **12** | **223** | **31** |

Los 12 del último grupo son el **patrón que originó el proyecto**. Lo confirma dev-history para
los tres que entraron en la muestra:

| Creador | Lanzados (histórico) | A ≤ 5 $ hoy | Holders del token consultado |
|---|---|---|---|
| `D4fvEy…` | 32 | 32/32 | 29 |
| `Ge4Drz…` | 227 | 95/100 listados | 203–213 |
| `5NUms5…` | 23 | 23/23 | 187 |

El stream solo les ve 31 colapsos de 223 tokens. Encaja con un vaciado por ventas, que sin swaps
no se ve (hipótesis, no verificada).

La separación no es un umbral elegido: la distribución es bimodal, con 216 seriales que
gradúan ≤ 10 %, 12 que gradúan > 50 % y solo 2 en medio.

---

## 3. ¿Qué distingue a un graduado que colapsa de uno que no?

Graduados: 1.728; colapsados según el stream: 448; no colapsados: 1.280. AUC = probabilidad de
que un colapsado tenga un valor mayor que un no colapsado (0,5 = no separa; lejos de 0,5 = separa).

| Variable | Mediana colapsados [p25–p75] | Mediana no colapsados [p25–p75] | AUC |
|---|---|---|---|
| Nº de "add" de liquidez | 1 [1–1] | 0 [0–0] | 0,86 |
| Pico de liquidez (lado SOL) | 10.057 $ [9.889–10.253] | 1.295 $ [0,01–9.951] | 0,77 |
| Nº de pools | 2 [2–2] | 1 [1–2] | 0,76 |
| Creación → graduación | 0 s [0–0] | 0 s [0–82] | 0,38 |
| Trades en la curva (ventana 1 h) | 1 | 1 [1–4] | 0,53 |
| Lanzamientos del creador | 1 [1–1] | 1 [1–9] | 0,41 |
| Nº de "remove" | 2 [2–2] | 0 [0–1] | 0,89 ⚠ |

⚠ Los "remove" **son** el colapso: no sirven para predecirlo, se muestran solo como control.

Variables categóricas (qué fracción colapsa):

| Variable | Valor | Colapsan |
|---|---|---|
| Launchpad | meteora_dbc | 444/1.050 (42,3 %) |
| | pump.fun | 2/440 (0,5 %) |
| | raydium_launchpad | 0/30 |
| Quien retira es el creador | sí | 381/790 (48,2 %) |
| | no | 21/69 (30,4 %) |
| | nadie retira | 46/869 (5,3 %) |

**La variable que mejor separa, y que se observa ANTES del vaciado:**

| Regla (sobre todos los tokens) | Tokens que la cumplen | Colapsan (precisión) | % de los 814 que cubre |
|---|---|---|---|
| **El creador aporta liquidez él mismo** | **356** | **348 (97,8 %)** | 42,8 % (≈ todo el grupo A) |
| Launchpad meteora_dbc | 1.583 | 446 (28,2 %) | 54,8 % |
| Creado y graduado en el mismo segundo | 1.026 | 376 (36,6 %) | 46,2 % |
| Creador con ≤ 2 lanzamientos | 8.393 | 700 (8,3 %) | 86,0 % |
| Creador con > 10 lanzamientos (señal 1) | 7.456 | 76 (1,0 %) | 9,3 % |

Más datos de esa regla:
- **Cantidad aportada:** en 339 de 348 casos, el primer aporte del creador es **84,9–85,1 SOL**,
  lo mismo que deposita una graduación real de pump.fun. Imitan un token recién graduado. Los 7
  aportes de creadores que no colapsaron no tienen un importe distinto (5 de ellos también ~85
  SOL), así que el importe no añade separación.
- **Margen de aviso:** del aporte a la retirada pasan p10 = 218 s, **p50 = 378 s**, p90 = 609 s
  (n = 341). Una alerta en el momento del aporte llegaría ~6 minutos antes del tirón.
- **Honestidad sobre el 97,8 %:** la etiqueta (el colapso) la mide mi propio stream. De los 8
  "no colapsados", 6 aportaron cerca del final de la captura y nunca se vio la retirada.

Lo que **no** separa:
- **Reutilización de nombres entre creadores:** 52,1 % en colapsados y 50,2 % en no colapsados.
- **`bundlers_count` (solo REST, muestra de 50):** 0–2 en los dos grupos, sin diferencia visible.
- **Liquidez final repetida (señal 3):** en los colapsados la final es ~0 (p50 0,00 $, p90 0,89 $).
  No queda nada que "repetir". La huella de automatización está en el aporte inicial (85 SOL),
  no en la liquidez final.

**Swaps (solo graduados dentro de los 40 min con swaps: 57 colapsados y 65 no):**

| Variable | Colapsados | No colapsados | AUC |
|---|---|---|---|
| Nº de swaps | 1.366 | 1.377 | 0,51 |
| Traders distintos | 223 | 218 | 0,60 |
| Trades por trader | 2,92 | 4,13 | 0,43 |
| Proporción de ventas | **0,11** [0,04–0,28] | **0,47** [0,31–0,52] | **0,14** |

En los que colapsan casi nadie vende antes del tirón (compran bots o gente que no llega a
salir; sin verificar). Es la segunda variable más fuerte, pero **n = 122 y solo 40 minutos**:
hace falta capturar swaps de los tokens seguidos para confirmarla.

---

## 4. dev-history: ¿tienen pasado los creadores de colapsos?

Muestra aleatoria con semilla fija: 30 creadores de colapsos graduados y 20 de graduados no
colapsados. Inicio de la captura: 2026-09-25 04:37 UTC.

| | Colapsos (30) | Control (20) |
|---|---|---|
| Wallet de 1 solo token, sin nada antes de la captura | **23** | 10 |
| Sin historial antes de la captura | 26 | 13 |
| Con historial antes de la captura | 4 (`Ge4Drz` 37, `CVWZDW` 7, `FYjpSv` 6, `HCRQbm` 6) | 7 |
| Token consultado a ≤ 5 $ según Solami | 20 | 8 |
| Holders del token consultado | 13–45 (salvo seriales: 187–206) | 3–1.508 |

"Antes de la captura" se cuenta sobre los tokens que lista dev-history, que corta en 100. En un
creador del control (`8WZwQJ…`, 287 lanzados, primer lanzamiento el 20-09) sale 0 por ese corte.

**Respuesta:** la gran mayoría son **wallets realmente nuevas**. No hay un historial escondido
que el stream no viera: 23 de 30 nacieron, lanzaron un token y lo vaciaron dentro de la captura.

Los tokens del grupo A tienen **pocos holders (13–19)**, frente a ~200 en el patrón original. Es
decir, mucho SOL extraído de pocas carteras. Probablemente sean bots que compran tokens "recién
graduados", pero **no está verificado**.

Hallazgos colaterales de la API:
- dev-history devuelve `ath_mcap_usd`/`ath_usd` = `null` en algunos tokens, y el esquema de la
  fase 1 rechazaba la respuesta entera (9 de 52 fallaron). **Corregido**, con test.
- dev-history lista **como máximo 100 tokens** aunque se pida `limit=200` (`Ge4Drz`: 227
  lanzados, 100 listados).

---

## 5. El caso que originó el proyecto

| Creador | ¿En la captura de 12,5 h? | dev-history hoy |
|---|---|---|
| `BpxbkX…` | **No** (sí en las capturas del 24-09) | 63 lanzados, 63 migrados, **todos antes** del inicio de la captura; 56/63 a ≤ 5 $; 197 holders |
| `95kdrk…` | **No** (sí en las capturas del 24-09) | 97 lanzados, 97 migrados, **todos antes** de la captura; 95/97 a ≤ 5 $; 209 holders |

Los dos dejaron de lanzar con esas wallets antes del 25-09 a las 04:37 UTC. En la captura sí hay
operadores del mismo estilo: los **12 seriales que gradúan > 50 %** (223 lanzamientos).

**¿Qué fracción del daño cubren?** No se puede calcular en SOL con estos datos. Su vaciado no
pasa por un `remove` que el stream vea, y solo hay 40 minutos de swaps.

Lo que sí se puede comparar:

| | Tokens | Holders por token | SOL extraído medible |
|---|---|---|---|
| Patrón original (12 seriales) | 223 | ~190–210 (3 creadores de muestra) | no medible |
| Tirón de liquidez (grupo A) | 348 | 13–19 (muestra) | 18.498 SOL netos |

Por SOL, el grupo A es con seguridad la mayor parte de lo medible. Por número de víctimas, el
patrón original afecta a ~10 veces más carteras por token. **Cuál de los dos es "más daño"
depende de la métrica, y la del patrón original no la tenemos.**

---

## Conclusión

1. **Señal 1 (> 10 lanzamientos en 24 h) tal como está: no sirve sola.** Marca a 230 creadores
   con una precisión del 1,0 % para colapsos, y 216 de ellos casi nunca gradúan (spam). **Sí
   sirve combinada con "gradúa la mayor parte de lo que lanza"**: eso aísla a 12 creadores que
   son exactamente el patrón original, confirmado por dev-history. El corte sale de una
   distribución bimodal, no de un ajuste.
2. **Señal 2 (colapso de liquidez): hay que partirla.** "≥ 1.000 $ → ≤ 5 $" mezcla tres cosas
   (tirón de LP, curvas de pump.fun que vuelven a cero y un resto sin aclarar). Además discrepa
   de Solami en ~1 de cada 3 casos de la muestra, en las dos direcciones.
3. **Señal 3 (liquidez final repetida): no aparece** en estos datos; la final es ~0. La huella
   de automatización es el aporte inicial idéntico (85 SOL), pero no discrimina por sí sola.
4. **Señal nueva propuesta: "el creador aporta liquidez a su propio token recién lanzado".**
   - 356 tokens la cumplen y **348 se vaciaron (97,8 %)**, de **345 wallets distintas**, con
     **18.498 SOL netos extraídos** en 10,5 h.
   - Se ve **~6 minutos antes** del tirón (p50 = 378 s).
   - La señal 1 no ve a ninguno de ellos.
   - No necesita umbral: es un hecho del evento (`liquidity.kind = add` con `provider` = creador
     del mint).

Lo que no se puede responder con estos datos, y haría falta para cerrar la calibración:
- Swaps de toda la vida de los tokens seguidos (hoy solo hay 40 min). Es la mejora ya anotada:
  suscribirse a `swap` filtrado por los mints que seguimos.
- Quién financia las wallets nuevas: el SOL nativo no está en los datos. Sin eso no se puede
  saber si las 345 wallets son un solo operador.
- Una fuente de verdad para "vaciado" que no dependa de cómo Solami valora `liquidity_usd`.
