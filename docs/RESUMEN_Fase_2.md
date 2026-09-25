# Resumen de la Fase 2: la ingesta en vivo

Este documento explica en lenguaje sencillo qué hace cada pieza de la fase 2 y **por qué** se
decidió así, para poder defenderlo ante el jurado o contarlo en un post.

---

## Qué hace la fase 2, en una frase

El sistema se conecta al WebSocket de Blur, recibe eventos reales, los pasa por la "aduana" de
la fase 1 y los entrega limpios al resto del sistema. Mientras tanto, guarda una copia en disco,
se reconecta solo si se cae y puede decir en todo momento cómo está.

---

## 0. Antes de programar: medir

Antes de escribir código me conecté al stream real con tu plan Pro. Cuatro cosas cambiaron el
diseño:

| Qué se midió | Resultado | Consecuencia |
|---|---|---|
| Volumen real con los 7 tipos | **~970 eventos por segundo** (no ~1/s) | La contrapresión no es teórica: pasa de verdad |
| Reparto | `swap` ~440/s y `transfer` ~450/s son **todos** los de Solana | El 95% del volumen es ruido para el detector |
| Tamaño en disco | **~58 GB al día** | Guardarlo todo sin límite llena el disco en horas |
| ¿El backfill reenvía lo mismo? | **Sí, byte a byte** (200/200 en cada tipo, con dos conexiones solapadas) | La deduplicación por contenido es segura, también en `meme` |

Otros hallazgos, que ya están en `CLAUDE.md`:
- `transfer` **no tiene backfill**: lo que se pierde durante una desconexión no se recupera.
- `metadata` llega aunque no lo pidas.
- El servidor admite filtros (`dex=`), pero se aplican a toda la conexión y **eliminan los
  transfers**.

**Cómo defenderlo:** "No diseñamos por intuición. Medimos el stream real antes de escribir la
primera línea."

---

## 1. Una fuente, dos orígenes (el plan B)

**Qué es:** el resto del sistema recibe eventos a través de una única "ventanilla"
(`EventSource`). Detrás puede haber dos cosas:
- **`LiveSource`:** el WebSocket en directo.
- **`ReplaySource`:** ficheros guardados en disco.

Las fases 3, 4 y 5 **no saben de dónde vienen los eventos**, y así debe ser.

**Por qué:**
- Se puede desarrollar y probar **sin red** y sin gastar cuota.
- **Si el acceso al stream se reduce tras el 1 de octubre, el sistema sigue funcionando** con
  lo grabado.
- Un jurado sin API key ve el sistema funcionando con las muestras incluidas.

**Garantía de que es de verdad la misma:** los dos orígenes pasan cada trama por la **misma
tubería** (`FrameProcessor`), y hay un test que alimenta ambos con las mismas tramas y
comprueba que entregan **exactamente los mismos eventos**.

---

## 2. La deduplicación: no contar dos veces lo mismo

**El problema:** al reconectar, el servidor reenvía los últimos 200 eventos de cada tipo (el
"backfill"). Muchos ya los habíamos procesado. Si los contamos dos veces, el detector vería el
doble de lanzamientos de un creador.

**La clave: la elegí mirando los datos, no por intuición.** Probé varias candidatas sobre
181.000 eventos reales de tus capturas:

| Clave candidata | Colisiones entre swaps **distintos** |
|---|---|
| `signature` | 17.980 |
| `signature + ix_index` | 16.174 |
| `signature + ix_index + inner_ix_index` | **5.868** ← aún falla |
| `… + mint` | **0** ✅ |

**El descubrimiento** (buen material para un post): una misma instrucción de swap genera **dos
eventos**, uno por cada lado del par. Si alguien cambia USDC por USD1, llegan un evento con
`mint=USDC` y otro con `mint=USD1`, con la misma signature y la misma posición. Sin el mint en
la clave, el segundo se descartaría como duplicado y **perderíamos la mitad del swap**.

Por tipo de evento:
- **Transacciones** (swap, transfer, token_create, pool_create, liquidity):
  `signature + ix_index + inner_ix_index + mint`.
- **graduation** (no tiene signature): `mint + slot`.
- **meme** y similares: no tienen identidad natural, porque son "fotos" del estado de un token.
  Usamos una huella (hash) de todo el contenido. Es seguro porque medimos que el backfill
  reenvía bytes idénticos.

**Memoria acotada, y por qué POR TIPO:** el servidor solo puede reenviar sus últimos 200 por
tipo, así que basta recordar los últimos 1.000 de cada tipo. Si la memoria fuera global, los
~900 swaps y transfers por segundo expulsarían a los token_create en segundos, y un token_create
reenviado tras una reconexión se contaría dos veces. La config impide poner una ventana menor
que el backfill.

---

## 3. Contrapresión: qué pasa si el consumidor va lento

**El problema:** entran ~970 eventos/s. Si la fase 3 procesa más despacio, algo tiene que ceder.

**Opción descartada: "dejar de leer".** Suena prudente, pero un WebSocket en directo no se puede
pausar. Si dejas de leer, el servidor acumula un rato y después **te desconecta**. Al reconectar,
el backfill solo recupera 200 eventos por tipo, que en swaps es **medio segundo**. Dejar de leer
también pierde datos, solo que sin control y sin enterarte.

**Opción elegida: una cola con tope que descarta por prioridad.**

| Prioridad | Tipos | Volumen | Se descarta… |
|---|---|---|---|
| Crítica | token_create, pool_create, graduation | ~1/s | lo último |
| Normal | liquidity, meme, metadata | decenas/s | después |
| Bulk | swap, transfer | ~900/s | primero |

Si la cola se llena, se expulsa el evento más antiguo de la clase menos importante. Los
lanzamientos de tokens, que son la señal principal, son lo último que se toca. Además:
- **Cada descarte se cuenta**, por tipo, y se ve en la salud.
- **El orden de entrega se mantiene:** la prioridad decide qué se pierde, nunca reordena lo que
  se entrega.

**Cómo defenderlo:** "Perder datos bajo carga es inevitable; lo que elegimos es **qué** se
pierde, y que quede registrado."

---

## 4. Reconexión: sin martillear al servidor

**Solo se reconecta si la conexión se cae.** Hay dos formas de caerse:
1. **El servidor o la red la cierran:** llega un error o un cierre.
2. **Silencio.** El stream trae ~1.000 eventos/s, así que 30 s sin recibir nada significan que
   la conexión está muerta aunque el sistema operativo no se haya dado cuenta (TCP "medio
   abierto"). Un vigilante (*watchdog*) lo detecta y lo trata como una caída.

**Backoff exponencial:** si el servidor está caído, se espera 1 s, luego 2, 4, 8… hasta un tope
de 60 s. Así no hacemos un bucle que lo acribille a peticiones.

**Jitter (aleatoriedad):** si Solami se reinicia, miles de clientes se desconectan a la vez. Sin
aleatoriedad volverían todos en el mismo instante y lo tumbarían otra vez (*thundering herd*).
Usamos jitter "igual": la mitad de la espera es fija y la otra mitad aleatoria. La variante
"completa" podría dar esperas de ~0 ms, que es un bucle cerrado disfrazado.

**Trampa evitada:** el contador de fallos solo se reinicia si la conexión aguantó al menos 30 s.
Si no, un servidor que acepta y cierra al instante nos tendría reconectando cada segundo para
siempre.

---

## 5. Persistencia: guardar el crudo para reprocesarlo

**Qué hace:** escribe cada trama tal como llega (JSONL), **con tu API key borrada**, en
`data/live/`. La fuente de replay puede releer esos ficheros: lo grabado hoy se reprocesa
mañana sin volver a capturar.

**Dos niveles, decididos contigo:**

| Nivel | Qué guarda | Tope por defecto | ¿Cuánto dura? |
|---|---|---|---|
| `lifecycle` | lanzamientos, graduaciones, liquidez, meme… | **1 GB** | ~10 horas |
| `firehose` | swaps y transfers | **500 MB** | ~13 minutos |

**Los valores por defecto son conservadores a propósito:** un jurado lo va a ejecutar sin leer
la config y no queremos llenarle el disco. Tú los subes en tu `.env` con
`PERSIST_LIFECYCLE_MAX_MB=10240` y `PERSIST_FIREHOSE_MAX_MB=5120`.

- **Rotación:** un fichero nuevo cada 50 MB o cada día UTC. Cuando se supera el tope, se borran
  los más antiguos.
- **Si el disco va lento:** hay un búfer máximo de 16 MB. Si se llena, esas líneas no se guardan
  (y se cuentan), pero **la ingesta no se detiene**.
- **Si el disco falla:** la persistencia se desactiva y se informa en la salud, sin tumbar nada.

**Un bug que encontraron los tests:** para respetar el tope, primero medía los ficheros en disco
con `stat()`. Pero justo después de rotar, un fichero todavía no está volcado y "mide" 0 bytes,
así que no se borraba nada y el tope se superaba. Ahora el tamaño se lleva en memoria.

---

## 6. Salud observable

El sistema contesta en `http://localhost:8080/health` (JSON). Devuelve 200 si está sano y 503 si
no; Docker lo usa para marcar el contenedor como `healthy`. Además, cada 30 s escribe una línea
en el log. Muestra:
- estado (`connecting`, `backfilling`, `live`, `reconnecting`, `closed`)
- cuándo llegó el último evento (la respuesta a "¿sigue vivo?")
- por tipo: recibidos, duplicados, **descartados** y entregados
- tramas malformadas y las últimas 10 (sin la key)
- tamaño de la cola, reconexiones, último error
- bytes escritos en disco y líneas perdidas

Es lo que la fase 5 mostrará en el dashboard.

**Tramas malformadas:** se cuentan, se descartan y se sigue. Cada *tipo* de error se escribe en
el log **una sola vez**. Si Solami cambiara un campo, a 1.000 tramas/s inundaríamos el log;
después de la primera vez, solo sube el contador.

---

## 7. Cierre limpio

Con Ctrl+C (o `docker compose stop`, que envía SIGTERM):
1. Se cancela cualquier reconexión pendiente y se detiene el vigilante.
2. Se cierra el socket.
3. Se entregan los eventos que quedaban en la cola.
4. Se vuelca a disco lo pendiente y se cierran los ficheros.
5. Se sale.

Un segundo Ctrl+C fuerza la salida. Comprobado en real: tras la parada, todos los ficheros
terminan en una línea completa y se pueden releer.

---

## 8. Docker: lo que ve el jurado

`docker compose up --build`:
- **Con su API key** en `.env`: ingesta en directo, estado `healthy` en ~30 s.
- **Sin key:** replay de las muestras reales incluidas en la imagen; luego sale limpio.

Probados los dos modos, y también la parada con `docker compose stop`.

---

## 9. Tests: cómo sé que funciona

**144 tests, ninguno toca la red, y los de tiempo usan relojes falsos:** una espera de 60 s se
simula en milisegundos. Los datos son tramas reales de tus capturas: una sesión de 212 tramas
con backfill, `backfill_end` y tiempo real.

Probados, entre otros:
- **Reconexión tras caída:** esperas de 500, 1.000, 2.000 y 4.000 ms; tope; reinicio del
  contador solo tras una conexión estable; vigilante de silencio.
- **Deduplicación backfill ↔ tiempo real:** se entregan 100 eventos, se corta la conexión, el
  servidor reenvía 60 ya vistos más 20 nuevos, y cada evento se entrega **exactamente una vez**.
  Además, los dos lados de un swap real no se fusionan.
- **Evento malformado:** JSON roto, un array, un tipo desconocido, un campo con el tipo
  equivocado… Todo se cuenta y los eventos válidos siguen llegando.
- **Consumidor lento:** la cola nunca pasa del tope, se descartan swaps y ningún lanzamiento, y
  el orden se mantiene.
- **Cierre:** no queda ningún temporizador vivo que retrase la salida.

**Pruebas de sabotaje (como en la fase 1).** Rompí a propósito 17 piezas críticas y comprobé
que los tests lo detectan. Detectan las 17:

| Sabotaje | ¿Lo detectan? |
|---|---|
| Clave de dedup sin mint | ✅ |
| Deduplicación desactivada / ventana global | ✅ ✅ |
| Backoff sin crecer / sin tope / reiniciado siempre | ✅ ✅ ✅ |
| Vigilante de silencio desactivado | ✅ |
| Socket muerto sin desenganchar (doble reconexión) | ✅ |
| Cola sin límite / descartar críticos primero | ✅ ✅ |
| JSON inválido que lanza excepción | ✅ |
| Key sin redactar en la salud / en disco | ✅ ✅ |
| Retención midiendo con `stat()` (el bug real) | ✅ |
| `backfill_end` que no pasa a `live` | ✅ |
| `close()` sin cancelar la reconexión / el vigilante | ✅ ✅ |

Una curiosidad honesta: la primera ronda detectó 16 de 17. Si `close()` no cancelaba la
reconexión, no se abría ningún socket (había una segunda defensa), así que los tests pasaban.
Pero el temporizador pendiente **retrasaba la salida hasta 60 s** tras Ctrl+C. Añadí la
comprobación de que tras cerrar no queda ningún temporizador vivo, y ahora lo detecta.

---

## 10. Límites conocidos y trabajo futuro

- **El firehose de swaps es un despilfarro.** Guardar 38 GB/día de swaps trata todos por igual,
  cuando solo importan los de tokens que ya vigilamos. Lo correcto es **una segunda conexión
  suscrita a swaps filtrados por `mints=`** de los tokens bajo seguimiento. Depende de la
  máquina de estados de la fase 3; está anotado en `CLAUDE.md` para no reinventarlo.
- **Los transfers perdidos en una desconexión no se recuperan:** el servidor no hace backfill
  de ese tipo.
- **La igualdad byte a byte del backfill se verificó en una ventana de 30 s.** Si algún día
  Solami recalculara un `meme`, lo peor que pasaría es que llegue un estado más reciente del
  mismo token, cosa que la fase 3 absorbe sin problema.
- **Replay:** los dos niveles de ficheros se leen uno detrás de otro, no intercalados por
  tiempo. La fase 3 debe tolerar eventos desordenados, como ya ocurre con el backfill.
- **Plan gratuito:** no sabemos qué límites tiene el stream para un jurado sin plan Pro. Si el
  servidor rechaza la conexión, el sistema reintenta con backoff y lo muestra en la salud, sin
  caerse.
