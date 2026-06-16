/* SwissYGO — bulk player-name paste parser (pure).
 * Ported verbatim from SwissYGO.html (lines 1206-1211).
 *
 * Acepta una lista pegada (un nombre por línea), tolerando numeración tipo
 * "1.", "10)", "3 -", etc., y descartando líneas vacías. Solo se quita el
 * prefijo cuando hay un delimitador tras el número (. ) : -), para no mutilar
 * nombres como "2 Pac". */
export function parseBulkNames(text) {
  return (text || '')
    .split(/\r?\n/)
    .map((s) => s.replace(/^\s*\d{1,4}[.)\:\-]\s*/, '').trim())
    .filter(Boolean);
}
