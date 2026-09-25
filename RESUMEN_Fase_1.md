# Resumen de la Fase 1: qué hay y por qué

Este documento explica cada pieza de la fase 1 en lenguaje sencillo, con el **porqué** de cada
decisión, para que puedas defenderla ante el jurado o contarla en un post.

---

## La idea en una frase

Solami ya vende "fotos" de cada token (¿tiene autoridad de mint?, ¿cuántos tokens lanzó su
creador?). Nosotros hacemos **la película**: escuchamos en directo, recordamos, y unimos los
puntos entre tokens del mismo creador. Un rug pull en serie no se ve mirando un token; se ve
mirando 48 tokens del mismo creador en 12 horas.

---

## 1. La capa de normalización: la "aduana" de los datos

**Qué es:** todo dato que llega de Solami pasa por un control de aduana antes de entrar al
sistema. Ahí se revisa y se convierte a tipos seguros. Lo que no cumple, se rechaza.

**Por qué:** los datos de Solami tienen trampas que en JavaScript **fallan en silencio**: el
programa no da error, simplemente calcula mal.

| Trampa | Qué pasa si no la tratas | Cómo la resolvemos |
|---|---|---|
| Decimales como texto (`"1.5"`) | `"1.5" + "0.5"` da `"1.50.5"`; ordenar pone `"9"` delante de `"10"` | Se convierten a `Decimal` (librería decimal.js, precisión exacta) |
| Enteros gigantes (reservas on-chain) | `11196105564446459` se convierte en `11196105564446460` **al leer el JSON**, antes de que tu código lo vea | Parser "sin pérdida" que los convierte a `bigint` |
| Segundos vs milisegundos | Restar uno del otro da resultados 1000 veces mal | Tipos distintos que el compilador no deja mezclar |

**Cómo defenderlo:** "Validamos en el borde. Dentro del sistema no puede existir un número
escrito como texto ni un timestamp sin unidad. No es disciplina del programador: el compilador
y los tests lo impiden."

### El descubrimiento de 2^53 (buen material para un post)

JavaScript guarda los números con una precisión máxima de 2^53 (unos 9.000 billones). Por
encima, redondea sin avisar. En tus capturas, **500 swaps** traían reservas por encima de ese
límite. La solución estándar (`JSON.parse`) ya las ha estropeado cuando te las entrega.

Node 24 añadió una función nueva: al leer el JSON puedes ver el **texto original** de cada
número. Si es un entero demasiado grande, lo reconstruimos exacto como `bigint`. Por eso el
proyecto exige **Node 24**. Lo comprobé: Node 22 no tiene esta función. Además, Node 20 ya
está fuera de soporte desde abril de 2026.

### Los tipos de tiempo "opacos"

Lo habitual en TypeScript (`number & { marca }`) **no basta**: el compilador sigue dejando
restar segundos menos milisegundos, porque para él ambos son números. Nosotros declaramos los
tiempos como tipos opacos, así que el compilador:
- ❌ no deja sumar ni restar segundos con milisegundos
- ❌ no deja compararlos entre sí (`<`, `===`)
- ✅ sí deja ordenar dentro de la misma unidad, porque eso es seguro

Hay que pasar por funciones con la unidad en el nombre: `elapsedSeconds()` o `secondsToMillis()`.
Esto está comprobado con tests *de compilación*: si alguien quitara la protección, el build fallaría.

Además, la aduana rechaza un valor en milisegundos metido en un campo de segundos. Cualquier
fecha real en segundos es menor que 10^11, y en milisegundos es mayor.

---

## 2. Los tipos de evento

**Qué es:** la descripción exacta de cada uno de los 12 eventos del stream, los 2 de control y
los 4 snapshots.

**Por qué los tipamos contra capturas reales y no contra la documentación:** la documentación
puede estar desactualizada. Pasé **254.206 eventos reales** de tus capturas por la aduana:
**0 rechazados**. Los 12 tipos de stream están verificados.

**Qué descubrimos por el camino** (esto es lo que da credibilidad ante un jurado):

1. **`created_time` en `graduation` y `meme` está mal en la fuente.** Va unos 8,8 días por
   delante de la creación real del token. Lo verifiqué cruzándolo con el `token_create` del
   mismo mint, y el desfase ni siquiera es constante. Lo renombramos a `reportedCreatedTime`
   para que nadie lo use sin darse cuenta.
2. **`resolved_at` = 9223372036854775807** es un valor especial que significa "sin fecha".
   Lo convertimos a `null`.
3. **Los eventos `metadata` traen tu API key dentro de las URLs de imagen.** La aduana la borra.
4. Transfers: los `mint` nunca tienen origen y los `burn` nunca tienen destino. Hay los tres
   tipos en tus datos: 1.762 burns y 2.347 mints.

**Los 4 snapshots** (`launches`, `graduating`, `graduated`, `trending`) no llegaron al
suscribirse con `type=`. Quedan **en cuarentena**: pasan por el sistema, pero su contenido se
guarda como "desconocido" y no se puede usar sin validarlo primero.

**Otra decisión:** si llega un evento mal formado, el normalizador **no se cae**. Devuelve un
error estructurado (qué campo falló y por qué). Con ~1 evento por segundo de cada tipo, un
dato roto no puede tumbar la ingesta.

---

## 3. El cliente REST y el límite de 1 petición por segundo

### El token bucket (la "máquina de turnos")

**Qué es:** imagina una máquina que da un ticket por segundo. Para hacer una petición necesitas
un ticket; si no hay, esperas en la cola.

**Decisiones:**
- **Capacidad 1:** no se acumulan tickets. Aunque el sistema esté 1 minuto parado, después no
  salen 60 peticiones de golpe, porque eso violaría el límite.
- **Cola con tope (500):** a 86.000 tokens/día no podemos consultar todos. Si la cola se llena,
  se rechaza la petición en vez de acumular memoria sin fin.
- **Devolver el ticket (`refund`):** si mientras esperabas en la cola la respuesta ya llegó a la
  caché (por otra petición), devuelves el ticket y el siguiente pasa al instante.

### La caché de tres niveles (decidida contigo)

El prompt original pedía cachear todo para siempre porque "los datos de creación son
inmutables". Solo es verdad en parte: `dev-history` también trae la liquidez y los holders
actuales, **que cambian cada minuto**, y justo de ellos depende la señal de colapso.

| Nivel | Qué guarda | Duración | Por qué |
|---|---|---|---|
| Identidad | mint → creador, fecha de creación, nombre | Para siempre | Nunca cambia |
| Security | autoridades, extensiones, impuestos | 10 min | Cambia poco, y solo en un sentido (se revocan) |
| Historial | tokens lanzados, liquidez, holders | 60 s | Cambia constantemente |

**El detalle clave:** `dev-history` recibe un mint pero responde sobre **el creador**. Por eso
lo guardamos **por creador**. Si un operador tiene 48 tokens, consultamos una vez y no 48, lo
que con 1 petición por segundo marca la diferencia. Además, una sola respuesta nos dice de
golpe quién es el creador de los 48 tokens.

**El histórico de liquidez:** cada vez que consultamos, guardamos la liquidez de cada token con
la hora. Un token con $3 de liquidez puede haber nacido así (token flojo) o haber tenido
$250.000 y perderla (rug). Solo el histórico distingue un caso del otro.

**Memoria acotada:** todas las cachés tienen un tamaño máximo. Cuando se llenan, se descarta lo
que lleva más tiempo sin usarse (LRU). Con 86.000 tokens al día, cualquier estructura sin
límite acaba reventando la memoria.

---

## 4. Configuración

`config/config.json` contiene todos los umbrales y parámetros. Se valida al arrancar: si alguien
escribe `"5,0"` en lugar de `"5"`, el programa se niega a arrancar y dice qué campo está mal. Un
umbral mal escrito no puede desactivar una regla en silencio.

- **Dado por la investigación:** más de 10 lanzamientos en 24 h.
- **Rangos observados, a calibrar en la fase 4:** liquidez ≤ $5, ≥ 150 holders, ATH ≥ $200k,
  margen de liquidez repetida de $1,5 (en los datos, el margen observado fue de $1,25).

La API key va en variables de entorno, nunca en el fichero de configuración ni en el código.

---

## 5. Docker, CI y tests

- **`docker compose up --build`** construye y ejecuta el "replay": pasa eventos reales por la
  aduana y muestra un informe por tipo. **No necesita API key:** la imagen incluye 24 eventos
  reales de muestra, con la key sustituida por una falsa. Así el jurado lo prueba sin nada más.
- **CI (GitHub Actions):** en cada push ejecuta lint, comprobación de tipos, tests con informe
  de cobertura (visible en el resumen del job y descargable) y build.
- **Tests:** 96 tests, cobertura ~99,6%. Además hice **pruebas de sabotaje**: rompí a propósito
  el código crítico (quitar la devolución de tickets, cachear por mint en vez de por creador,
  usar `JSON.parse` normal, quitar la frontera de unidades) y comprobé que los tests fallan.
  Un test que no puede fallar no protege nada.
- **ESLint prohíbe `parseFloat` y `parseInt`** en todo el proyecto. Los números solo se
  interpretan en la aduana.

---

## 6. Decisiones que cambiaron respecto al plan original

| Plan | Cambio | Motivo |
|---|---|---|
| Node 20+ | Node 24 | Parseo sin pérdida de enteros gigantes; Node 20 ya no tiene soporte |
| SDK oficial de Solami | `fetch` y `WebSocket` nativos | El SDK `solami` no cubre la Data API (Blur): solo RPC, gRPC y transacciones |
| Caché por mint, para siempre | Tres niveles; historial por creador | La liquidez cambia cada minuto; ahorra peticiones |
| — | Borrado de la API key en las URLs | Solami la incrusta en las URLs de imagen |

---

## ⚠️ Pendientes para ti

1. **Crear `.env.example`.** Tu configuración de permisos me impide escribir ficheros `.env*`.
   El contenido está en el mensaje final de la sesión.
2. **Tu API key está en los `.jsonl` de `data/`** (más de 1.100 veces). Ya están en
   `.gitignore`. Si los has compartido o subido a algún sitio, **rota la key**.
3. El proyecto aún no es un repositorio git. Para que funcione la CI: `git init`, crear el repo
   en GitHub y hacer push.
4. Averiguar cómo se piden los 4 snapshots, y confirmar que el parámetro REST se llama `mint`.
