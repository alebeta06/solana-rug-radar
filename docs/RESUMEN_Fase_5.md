# Resumen de la Fase 5: el dashboard

Este documento explica en lenguaje sencillo qué hace la fase 5 y **por qué** se decidió así,
para poder defenderlo ante el jurado o contarlo en el vídeo.

---

## Qué hace la fase 5, en una frase

Abres `http://localhost:8080/` y ves, en una sola pantalla, **que la alerta llegó antes que el
vaciado, y cuánto antes**, con la precisión de cada regla y lo que el detector no ve. Funciona
igual con API key (en directo) que sin ella (repitiendo una hora real grabada).

![Dashboard en directo, 2026-09-27](dashboard-live.png)

---

## 1. Lo que se ve, por orden de importancia

1. **"Warned before the drain"** (avisado antes del vaciado). Cada fila es la secuencia completa:
   > 🔴 01:59:16 — `CE3p8Q…E5sU` — el creador metió 84,99 SOL en su propio token
   > **5 min 49 s de aviso**
   > DRAINED 02:05:05 — $10.862 → $0 — el creador retiró la liquidez que había puesto

   La etiqueta de la alerta lleva **la precisión de SU regla** (`RED · 97,9 %`,
   `AMBER · 82,5 %`), nunca una media. El token y la wallet enlazan a Solscan para que cualquiera
   lo compruebe.
2. **Alertas abiertas**: todavía sin vaciado, con su edad y cuándo suele llegar el vaciado en esa
   regla. Debajo, las alertas que **no** acabaron en vaciado en 60 minutos ("cuenta en contra de
   la precisión").
3. **Precisión por regla**: la medida en la noche de calibración y la que lleva esta sesión. Las
   dos reglas por separado.
4. **Lo que NO ve** (recuadro ámbar, siempre visible): avisó antes del 65,3 % de los rugs de pool
   de la noche medida; no ve los dev dumps ni las retiradas de liquidez de migración de un creador
   sin rug previo, porque ahí el evento ES el vaciado. Y cuenta en vivo los vaciados que llegaron
   sin aviso.
5. **Sistema**: estado del stream, eventos/s, tokens y creadores en memoria, presupuesto REST y
   memoria. Y las señales descartadas con su motivo (desplegable, con enlace al README).

Todo cabe en una pantalla de 1080p sin hacer scroll (comprobado con capturas a 1920×1080).

---

## 2. Cómo está construido (y por qué así)

- **Mismo proceso, mismo servidor.** El servidor `node:http` de `/health` sirve ahora también
  `GET /` (la página) y `GET /api/dashboard` (los datos). Sin framework, sin build aparte, sin
  segundo contenedor. Todo sigue arrancando con `docker compose up --build`.
- **La página solo dibuja.** Todo lo que se decide (qué es una secuencia, qué alerta está abierta,
  qué modo mostrar) se calcula en `src/dashboard/view.ts`, que tiene tests. La página
  (`page.ts`) es un HTML con un poco de JavaScript que pregunta cada segundo.
- **Sondeo cada segundo** en vez de SSE: es lo más simple de mantener y basta para esto.
- **Sin emojis en la página.** En la primera captura salían como cuadrados: un navegador sin
  fuente de emojis no los pinta. Ahora son círculos de color hechos con CSS.
- **Si una vista falla, el detector no cae.** Un error al preparar los datos responde 500; el
  proceso sigue.

---

## 3. Sin API key: una hora real, no una pantalla vacía

**El problema que encontré antes de empezar:** las muestras que llevaba la imagen (236 tramas)
producían **0 alertas**. Y además, al acabar el replay el proceso se cerraba y la página moría.
Un jurado sin clave habría visto una pantalla vacía.

**La solución (la elegiste tú):** un extracto real de la noche del 26-09, pasado por el
**detector de verdad**, no una grabación de sus resultados.

- `samples/demo-20260926.jsonl.gz`: **todas** las tramas de 17 tokens, de 13:28 a 15:10 UTC.
  34.744 tramas, 7,3 MB comprimido. Lo genera `src/calibration/demo.ts`.
- **Muestra los límites, no solo los aciertos:**
  - 10 alertas rojas que acabaron en vaciado (de 86 s a 9 min de aviso);
  - dos creadores cuyo **primer** vaciado (un dev dump) nadie pudo anticipar, y cuyo siguiente
    token sí dispara la ámbar;
  - un creador con una retirada de migración que no se ve, y una ámbar en su siguiente token;
  - **una ámbar que NO acabó en vaciado** (`GbKawF…`): sale como "alertada, pero NO vaciada".
- **Sin claves.** Antes de hacer commit: `zcat … | grep -io "sk_[a-z0-9_]*"` → nada. Tampoco hay
  `api_key=` ni `image_url`. El script además se para si ve algo parecido a `sk_`.

**Una cosa que quise meter y no cupo: una roja fallida.** Las rojas que fallaron esa noche
(el creador puso ~0,01 SOL) son tokens sanos con mucha actividad: 22.000–31.000 swaps a lo largo
de horas (por eso no son rugs). Uno solo doblaba el fichero y añadía 80 minutos sin nada antes de
la primera alerta. Seguí tu regla ("recorta tokens antes que tramas") y lo dejé fuera. La
honestidad sobre los fallos la da la ámbar fallida, los vaciados sin aviso y la precisión medida
de la roja (9 de 431 no acabaron en vaciado).

**El final de la grabación.** Todos los tokens se cortan a la misma hora, 15:10, como si la
grabación terminara ahí: después del último vaciado y después de los 60 minutos de la ámbar
fallida. Lo que viene luego es gente operando con un pool ya vacío, que no cambia ningún registro.

---

## 4. Replay acelerado, y por qué no hace trampas

El replay va **40 veces más rápido** (`REPLAY_SPEED`): la hora y cuarenta de grabación se ve en
unos 2 minutos y medio. Así el jurado ve la alerta aparecer y, un poco después, el vaciado.

**¿La aceleración cambia la detección?** Lo revisé antes de programarlo, como pediste. Todo lo
que depende del tiempo usa el **tiempo de los eventos** (la "marca de agua", el `block_time` más
alto visto), no el reloj del ordenador:
- los 60 minutos para dar una alerta por no confirmada;
- los 10 segundos de edad mínima antes de preguntar por un token;
- la expulsión de tokens y creadores de la memoria;
- la ventana de 24 h de lanzamientos.

**Hay un único punto con reloj de pared:** la marca de agua no puede ir más de 60 s por delante
de la hora a la que llegó el evento. En un replay de una captura pasada ese tope no puede actuar
nunca (la hora de llegada siempre va días por detrás). Lo dejé como está.

**Cómo acelera:** solo retrasa la entrega. Un evento 60 s posterior al primero se entrega
60/40 = 1,5 s después. Los eventos son los mismos y en el mismo orden.

**En pantalla:** el reloj es **el de la grabación**, y el cartel lo dice:
`REPLAY · recorded 2026-09-26 · 40×` y "NOT real time: a recorded capture replayed through the
real detector, 40 times faster".

![Dashboard en replay a 40×](dashboard-replay.png)

---

## 5. Tres estados que no se confunden nunca

| Cartel | Qué significa |
|---|---|
| `● LIVE · 02:12:32 UTC` (verde) | Conectado al stream. Cada alerta dice cuántos segundos después del bloque se lanzó |
| `▶ REPLAY · recorded 2026-09-26 · 40×` (ámbar) | Grabación por el detector real, acelerada. Reloj = el de la grabación |
| `■ REPLAY FINISHED` (gris) | Estado final congelado. **Eventos/s desaparece**: no se queda con el último valor |

Y dos más que salieron al probarlo en directo:

| Cartel | Por qué existe |
|---|---|
| `STARTING · not live yet` | En directo, el arranque en caliente rehace la memoria con las últimas 24 h guardadas: tardó **124 s** en esta máquina. Sin este cartel, la página decía "LIVE" con la hora de ayer. Mientras dura, no se muestran edades de alertas (serían falsas) |
| `LIVE STREAM NOT CONNECTED` | Reconectando: lo que se ve no es actual |
| `DISCONNECTED` | La página no llega al proceso: lo que se ve está congelado |

**"En vivo" incluye el registro.** Al arrancar en directo se releen las alertas y vaciados de los
últimos 7 días (fase 4). Por eso los contadores dicen `Live, incl. the saved last 7 days`, no
"esta sesión", que sería falso.

---

## 6. Probado en directo (2026-09-27, ~02:00 UTC)

Lo arranqué con tu `.env` seis veces, unos minutos cada una (para probar y para las capturas).
Resultado real:

| Alerta | Vaciado | Aviso |
|---|---|---|
| ROJA `CE3p8Q…` 01:59:16, 84,99 SOL | 02:05:05, $10.862 → $0 | **349 s** |
| ÁMBAR `GSbukM…` 02:00:16 | 02:02:13, dev dump | 117 s desde el bloque, **56 s reales** (ver abajo) |
| ROJA `577AEF…` 02:01:57, 84,99 SOL | 02:09:36, $11.814 → $0 | 459 s |
| ÁMBAR `715PB1…` 02:05:06 | 02:06:07, dev dump | 61 s |
| ROJA `GhN6Jf…` 02:05:56, 84,99 SOL | 02:11:45, $10.311 → $0 | **349 s** |

- Las alertas en tiempo real se lanzaron **1–2 s después del bloque**.
- **Pero no todas llegan en tiempo real.** Las que salen del backfill que Solami manda al
  conectar llegan tarde: la ámbar de `GSbukM…` se lanzó 61 s después de su bloque. El aviso se
  mide desde el bloque (117 s), así que el aviso real fue de 56 s. Al principio la pantalla solo
  ponía la latencia a las alertas en tiempo real, y esta parecía mejor de lo que fue. Ahora cada
  alerta en directo dice cuánto tardamos y, si vino del backfill, lo pone:
  "alerted 64 s after the block (raised from the backfill sent on connecting)".
- La ámbar de `GSbukM…` existió **gracias al registro**: el creador había vaciado otro token a las
  01:58:48, visto por la sesión anterior. El reinicio no le hizo olvidar.
- Dos rojas con **exactamente 349 s** de aviso, la misma cifra que el ejemplo de la noche del 26
  en el README. El operador parece funcionar con un temporizador fijo. Es una observación, no una
  regla.
- La wallet `789cyT29…`, creadora de uno de los tokens del extracto demo, vació otro token esa
  noche: el operador sigue activo un día después.

**Algo que vi y NO he arreglado (sin verificar la causa):** al arrancar en directo, un vaciado
de esa wallet salió como `migration-pull` y no como `creator-pull`. Lo más probable es que su
aporte de 84,99 SOL ocurriera antes de conectarnos: sin alerta roja previa, el detector no puede
saber que la liquidez era suya. Solo pasa en los primeros minutos tras arrancar. Está anotado.

**Otra que se ve al reiniciar mucho (ya existía en la fase 4):** si el vaciado ocurre mientras el
proceso está parado, nadie lo ve, y su alerta acabará contando como "no vaciada". Con los
reinicios de esta prueba quedaron varias rojas abiertas así. En un despliegue que no se reinicia
no pasa; en el vídeo conviene no reiniciar justo antes de grabar.

---

## 7. Tests

**+22 tests** (de 219 a 241). Los nuevos cubren:

- **La captura demo** (test de CI, no script manual):
  - reproduce, registro a registro y en el mismo orden, lo que la validación de la fase 4 dio para
    esos 17 tokens;
  - da **exactamente lo mismo a 1× y a 20×**, y la aceleración ocurre de verdad (el reloj falso
    avanza ~100 minutos a 1×);
  - el reloj acaba en el último `block_time` de la grabación y la ámbar fallida queda "no
    confirmada" a los 60 min **del reloj de la grabación**.

  **Una tolerancia, explicada:** `peakUsd` (el pico de liquidez en dólares) difiere en céntimos,
  como mucho un 0,15 %. El precio de SOL en dólares se estima con los swaps de **todos** los tokens
  seguidos, y el extracto solo lleva 17. Todo lo demás, `lastUsd` incluido, es idéntico. El test
  admite ±0,5 % solo en ese campo.
- **`.gz`**: el mismo fichero en plano y comprimido da exactamente las mismas tramas (con un
  nombre con `U+2028`, eñes y emojis, que tienen que sobrevivir a los trozos del descompresor).
- **Ritmo**: a 10×, +10 s de evento = 1 s de espera; un evento atrasado no espera; a 0× nada espera.
- **La vista**: secuencias con su aviso, precisión por regla sin promediar, vaciados sin aviso
  contados aparte, abiertas / no confirmadas por el reloj del evento (con el límite exacto de 60
  min), los cinco modos, la latencia de una alerta del backfill, el contador de eventos/s, el
  registro acotado.
- **Rutas**: la página y los datos junto a `/health`, y una vista que falla da 500 sin tumbar nada.
- **La página**: su JavaScript compila (vive dentro de un string y el comprobador de tipos no lo ve).

**Prueba de mutación** (los tests pasaron a la primera, así que rompí el código a propósito).
**17 roturas**, todas detectadas al final:
- el aviso se mide desde la alerta más tardía;
- la precisión se promedia entre reglas;
- abiertas/no confirmadas con el reloj del ordenador;
- el límite de 60 min con `<` en vez de `<=`;
- eventos/s en replay;
- el replay terminado parece en marcha;
- los vaciados sin aviso salen como secuencias;
- un vaciado repetido cuenta dos veces;
- el ritmo ignora la velocidad;
- el ritmo se aplica después de sellar la hora de llegada;
- el `.gz` no se descomprime;
- **la marca de agua con el reloj del ordenador**;
- un error en una ruta tumba el servidor;
- "conectado" siempre verdadero;
- se ignora el arranque en caliente;
- un error de sintaxis en la página;
- la latencia solo para alertas en tiempo real (la del backfill desaparece).

**Una sobrevivió al principio:** la marca de agua con el reloj del ordenador. Las alertas y los
vaciados del extracto no cambiaban, así que el test no lo veía; pero el reloj de la pantalla y
el estado de las alertas sí. Añadí al test que el reloj acabe en el último `block_time` y que las
estadísticas del detector sean iguales a 1× y a 20×. Ahora la caza.

---

## 8. Qué NO he podido comprobar

- **`docker compose up --build`**: en esta WSL no hay Docker (`docker` no está en la distro).
  He cambiado el `Dockerfile` (copia `samples/` en vez de las muestras antiguas) y comprobado
  en local lo que hará dentro: `npm start` sin clave lee `samples/`, reproduce, y deja la página
  arriba. **Conviene que lo pruebes tú** antes de grabar el vídeo.
- Solo he mirado la página en Chromium (sin cabeza, 1920×1080). No en Firefox ni Safari.

---

## 9. Cambios de comportamiento que conviene saber

- **Sin clave, ya no se reproduce `./data`**: el replay por defecto es la captura demo
  (`REPLAY_PATHS=samples`). Para repetir tus capturas: `REPLAY_PATHS=data`.
- **El replay ya no termina el proceso**: se queda sirviendo el estado final hasta Ctrl+C.
  `REPLAY_SPEED=0` lo hace a toda velocidad (como antes).
- Las muestras antiguas (`tests/fixtures/*.jsonl`) siguen en los tests, pero ya no van en la imagen.
