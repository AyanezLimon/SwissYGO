/* #142: monitor en vivo de requests. Ring EN MEMORIA (cero disco — la SD lo
 * agradece; se resetea al reiniciar el contenedor, correcto para un monitor en
 * vivo) + suscriptores para el streaming SSE del admin. Una sola instancia se
 * comparte entre el API público (quien registra) y el admin (quien lee). */

const DEFAULT_SIZE = 500;

export function makeReqMonitor(size = DEFAULT_SIZE) {
  const ring = [];
  const subs = new Set();
  let seq = 0;
  return {
    record(entry) {
      const e = { id: ++seq, ...entry };
      ring.push(e);
      if (ring.length > size) ring.shift();
      for (const fn of subs) {
        try { fn(e); } catch { /* un suscriptor roto no afecta al resto */ }
      }
      return e;
    },
    list() { return ring.slice(); },
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
  };
}
