# Changelog

Todas las versiones notables de SwissYGO. El workflow de release inyecta la
sección de la versión publicada como cuerpo de las notas en GitHub.

## v2.7.1

### ⚖️ Confirmar empates (incluido el orden aleatorio)
Antes, un empate solo se marcaba como **fijado** si el TO arrastraba las filas; si
decidía dejar el orden aleatorio tal cual, el grupo quedaba como *tentativo* para
siempre. Ahora cada grupo empatado tiene un botón **✓ Dejar** que fija el orden
actual (aleatorio o ya reordenado) como definitivo. El botón **↺** reabre el empate
si el TO se arrepiente.

## v2.7.0

### ⚖️ Desempate de standings idénticos
Cuando varios jugadores empatan en **todo** lo oficial (MatchPoints, OMW%, OOMW% y
DDD), el orden entre ellos lo decidía solo el azar. Ahora el TO puede resolverlo al
finalizar el torneo:

- **Detección automática**: agrupa a quienes comparten el mismo número de desempate.
- **Marcado tipo bracket**: barra de color agrupando el empate + badge `⚖ empate`
  (ámbar = aleatorio/tentativo) o `⚖ fijado` (azul = resuelto por el TO).
- **Resolución del TO** (solo al finalizar): **arrastrar filas** para reordenar
  (desktop) + botones `↑`/`↓` (táctil/proyector) + `↺` para volver al aleatorio.
  La app solo registra el orden; el método (volado, dado, playoff…) lo realiza el TO.
- **Campeón provisional**: si el 1.º lugar está en un empate sin resolver, el banner
  lo marca como provisional.
- **Persistencia**: el orden fijado sobrevive recargas y lo respetan la tabla, el PNG
  compartible y el proyector; se invalida si cambian los integrantes del empate.

### 📋 Pegar lista con numeración (estilo WhatsApp)
"Pegar lista completa" ahora descarta automáticamente la numeración de lista
(`1.`, `10)`, `3:`, `4-`) y las líneas vacías que deja, ingresando solo los nombres
limpios. Aplica en Registro y en Late Entry. No mutila nombres con números reales
(solo quita el prefijo cuando hay un delimitador tras el número).
