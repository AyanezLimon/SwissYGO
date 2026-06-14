# SwissYGO

Gestor de torneos **formato suizo** para **Yu-Gi-Oh!**, hecho para **Velvet Room Game Store**.

Una sola página HTML, **100 % offline**, sin dependencias externas ni CDN. Todo —emparejamiento, desempates, cronómetro, standings, proyección de campeón e imagen compartible— vive en un único archivo `SwissYGO.html` y persiste en el navegador vía `localStorage`.

> **Estado del deploy:** ![Release & Deploy](../../actions/workflows/release-and-deploy.yml/badge.svg)

---

## Tabla de contenidos

- [Qué hace](#qué-hace)
- [Características](#características)
- [Cómo usarlo](#cómo-usarlo-flujo-de-un-torneo)
- [Cómo funciona por dentro](#cómo-funciona-por-dentro)
  - [Arquitectura](#arquitectura)
  - [Emparejamiento suizo](#emparejamiento-suizo)
  - [Matemática de desempates](#matemática-de-desempates)
  - [Persistencia](#persistencia-y-portabilidad)
- [Despliegue (CI/CD)](#despliegue-cicd)
- [Versionado y releases](#versionado-y-releases)
- [Política de contribución](#política-de-contribución)
- [Restricciones de diseño](#restricciones-de-diseño)

---

## Qué hace

SwissYGO corre un torneo suizo de principio a fin desde una tablet, laptop o el navegador del Raspberry Pi de la tienda:

1. Registras jugadores (uno por uno o pegando una lista).
2. Fijas el número de rondas (se autosugiere según la cantidad de jugadores).
3. La app empareja cada ronda, tú reportas resultados, y ella recalcula puntos y desempates en vivo.
4. Al cerrar la última ronda muestra una **pantalla de campeón** lista para proyectar, y permite **compartir/descargar** una imagen brandeada de los resultados para el grupo de WhatsApp o redes.

Todo sin internet: ideal para una tienda donde el wifi puede fallar a mitad del evento.

## Características

- **Emparejamiento suizo** con backtracking para evitar revanchas y asignación justa de *byes*.
- **Desempates oficiales** (puntos → OMW% → OOMW% → criterio de ronda perdida), con desglose visual y explicación integrada.
- **Cronómetro de ronda** autoconducido, con ventana de proyección sincronizada al tema (resiste el congelamiento de pestañas en segundo plano en móvil).
- **Pantalla de campeón** a pantalla completa para proyectar al finalizar.
- **Imagen compartible** (PNG brandeado con los logos de Velvet Room y Budget Occidente): botón **Compartir** (share sheet nativo) y **Descargar** (para adjuntar en WhatsApp Web).
- **Impresión limpia** (`Ctrl+P`): solo la tabla, sin controles, en paleta clara.
- **Late entries** y **drops** manejados correctamente en puntos y porcentajes.
- **Tema claro/oscuro**, colores de marca, UI pulida y responsive.
- **Exportar/Importar JSON** del torneo completo para respaldo o traspaso entre equipos.
- **Persistencia automática** en `localStorage`: recargar la página no pierde el torneo.

## Cómo usarlo (flujo de un torneo)

1. Abre `SwissYGO.html` (local o desde la URL del Pi).
2. **Registro:** agrega jugadores o pega una lista; opcionalmente escribe la nota de premiación.
3. Ajusta **Número de Rondas** (autosugerido) y presiona **Iniciar**.
4. **Rondas:** reporta el ganador de cada mesa; usa el cronómetro si lo necesitas.
5. Genera la siguiente ronda cuando todas las mesas estén reportadas.
6. Al cerrar la última ronda, ve a **Standings** → **Compartir/Descargar** la imagen final, o proyecta la pantalla de campeón.

## Cómo funciona por dentro

### Arquitectura

- **Un solo archivo** `SwissYGO.html`: HTML + CSS + JS vanilla, sin frameworks ni paquetes.
- **Sin red:** no carga fuentes, scripts ni estilos externos. Los íconos son Unicode o SVG inline; los logos van embebidos como data-URI.
- **Estado central** (`state`) serializado a `localStorage` bajo la clave `ygo_swiss_v1`. Forma del estado:

  ```
  started, finished, maxRounds, currentRound, viewRound,
  players: [{ id, name, dropped, hasReceivedBye, lateEntry, droppedAtRounds }],
  rounds:  [{ roundNumber, matches: [...] }],
  note, excludeDrops,
  timer: { endsAt, pausedMs, durationMin }
  ```

### Emparejamiento suizo

- El número de rondas sugerido sigue la tabla Tier 1/2: 4–8 jugadores → 3 rondas; para N ≥ 9 equivale a ⌈log₂(N)⌉. El campo queda editable.
- El emparejador intenta primero una solución **sin revanchas** mediante backtracking; si no existe (típico en torneos pequeños y avanzados), permite revancha como último recurso.
- **Bye:** cuando hay número impar de activos, lo recibe el jugador de menor puntaje que aún no haya tenido bye. El bye otorga 3 puntos pero se **excluye** de todos los porcentajes de desempate.

### Matemática de desempates

Cada jugador acumula un “número” de desempate **AA·BBB·CCC·DDD**, que se lee como un único valor y se ordena **de mayor a menor**:

| Parte | Significado | Notas |
|------|-------------|-------|
| **AA**  | Puntos de match | Victoria 3 / Derrota 0 / Bye 3 |
| **BBB** | **OMW%** — % de victorias de tus oponentes | ×1000, sin suelo del 33 %, Bye excluido |
| **CCC** | **OOMW%** — % de victorias de los oponentes de tus oponentes | ×1000 |
| **DDD** | Σ (ronda_perdida)² | Mayor es mejor: perder **tarde** vale más que perder temprano |

Detalles de implementación que importan:

- El orden real usa la **tupla numérica**, no la cadena, para no romperse cuando un porcentaje llega a 100 % (1000 → 4 dígitos) o DDD supera 999 (14+ rondas).
- BBB y CCC se comparan por el **entero redondeado al primer decimal** (0–1000), de modo que el orden coincide exactamente con lo mostrado y el ruido de punto flotante no decide empates que el spec considera idénticos.
- **Head-to-head** desempata como criterio final entre jugadores aún empatados; si persiste, un orden estable por `id` evita que la tabla cambie al recargar o exportar.
- **Late entry:** derrota administrativa que **sí** cuenta como duelo jugado-y-perdido (afecta el winrate visible para sus rivales), a diferencia del Bye.

### Persistencia y portabilidad

- Guardado automático en `localStorage` (envuelto en `try/catch`: si el entorno lo bloquea, la app sigue funcionando en memoria).
- **Exportar/Importar JSON** permite respaldar el torneo o moverlo a otro dispositivo a mitad del evento.

## Despliegue (CI/CD)

Cada push a `master` dispara el workflow [`release-and-deploy.yml`](.github/workflows/release-and-deploy.yml):

1. **Release** (runner de GitHub): lee la versión del HTML, y si es nueva publica un GitHub Release con notas autogeneradas desde los commits/PRs, adjuntando el HTML.
2. **Deploy** (runner self-hosted en el Raspberry Pi): copia `SwissYGO.html` al directorio que sirve el servidor web del Pi.

La guía completa de instalación del runner, variables y protección de rama está en **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)**.

## Versionado y releases

- La versión canónica vive en el propio HTML: `<!-- app-version: X.Y.Z -->` (SemVer).
- **Para publicar un release:** sube ese número en el PR. El workflow detecta el cambio y crea el release automáticamente.
- Si subes a master sin cambiar la versión, **se despliega igual** pero **no** se crea un release duplicado.

## Política de contribución

Repo **privado**, un solo dueño. Los cambios entran por **Pull Request**, no por push directo a `master`:

- **Claude Code** (u cualquier trabajo) ocurre en una **rama aparte** y se abre un PR.
- **Tú revisas el diff y mergeas** a `master`. Ese merge es lo único que dispara deploy + release.

Como eres el único con acceso de escritura, nadie más puede empujar a `master` — el control queda garantizado sin protección de rama. Si algún día sumas un colaborador externo y quieres bloquear *técnicamente* el push directo, ve [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) §1.

## Restricciones de diseño

Para mantener el archivo portable y offline, cualquier cambio respeta:

- **Un solo archivo**, sin dependencias externas ni CDN.
- Sin webfonts de íconos — solo Unicode o SVG inline.
- Reutilizar assets ya embebidos en lugar de agregar nuevos (evita inflar el tamaño).
- Validación: extraer el bloque `<script>` principal y correr `node --check`.
- Mantener exactamente 2 `</script>`, 2 `</style>` y 1 `<\/script>` escapado (dentro del template de la ventana de proyección).
