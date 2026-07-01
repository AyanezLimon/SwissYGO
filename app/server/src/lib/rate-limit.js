/* Tiny dependency-free rate limiter (fixed window, in-memory). The Pi runs a
 * single API process, so a Map is enough; counts reset on restart, which is fine
 * for throttling brute-force / abuse. Kept lean on purpose — no @fastify/rate-limit
 * (extra dep + native-free but still weight the deploy doesn't need).
 *
 * IMPORTANT — shared-IP reality: SwissYGO is a LAN-tournament app, so a whole venue
 * frequently sits behind ONE public IP. Ceilings must stay generous enough that a
 * real event never trips them, while still stopping scripted brute force (which
 * makes far more requests than any human venue). Do NOT rate-limit /join by IP for
 * this reason — dozens of players legitimately join from the same address. */

// Best-effort client IP. Public traffic always arrives via Cloudflare → Caddy, so
// prefer the headers those set; fall back to the socket address. These headers are
// spoofable by anyone who can reach the host directly (LAN), but the limiter is a
// speed bump, not a hard control — the real brute-force defenses are bcrypt cost
// and the reset code's 5-try burn. `req.ip` alone would bucket every proxied
// client under Caddy's address (turning the limiter into a self-DoS), so we can't
// use it as the primary key.
function clientIp(req) {
  const cf = req.headers['cf-connecting-ip'];
  if (cf) return String(cf);
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return req.ip || 'unknown';
}

/**
 * Build a Fastify preHandler that caps requests per client IP within a fixed
 * window. On exceed it replies 429 with a Retry-After header.
 * @param {object} opts
 * @param {number} opts.max - Max requests allowed per window, per IP.
 * @param {number} opts.windowMs - Window length in milliseconds.
 * @return {Function} async (req, reply) => void
 */
export function rateLimit({ max, windowMs }) {
  const hits = new Map(); // ip -> { count, resetAt }
  let lastSweep = 0;
  return async function rateLimitPreHandler(req, reply) {
    const now = Date.now();
    // Opportunistic sweep so the Map can't grow unbounded from one-off IPs.
    if (now - lastSweep > windowMs) {
      for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
      lastSweep = now;
    }
    const key = clientIp(req);
    let e = hits.get(key);
    if (!e || e.resetAt <= now) { e = { count: 0, resetAt: now + windowMs }; hits.set(key, e); }
    e.count++;
    if (e.count > max) {
      reply.header('Retry-After', String(Math.ceil((e.resetAt - now) / 1000)));
      return reply.code(429).send({ error: 'Demasiados intentos. Espera un momento e inténtalo de nuevo.' });
    }
  };
}
