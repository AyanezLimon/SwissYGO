/* Cosmetics API (#37, Phase 1). The caller reads the catalog + what they own +
 * their equipped set, and equips owned items. Ownership = the implicit base set
 * (lib/cosmetics.js) ∪ anything granted (user_cosmetics). Validation lives in
 * sanitizeEquipped, so a client can never equip something it doesn't own. */
import { requireAuth } from '../auth.js';
import { COSMETICS, baseIds, sanitizeEquipped, defaultEquipped } from '../lib/cosmetics.js';

export default async function cosmeticsRoutes(app) {
  const db = app.db;

  const ownedSet = (userId) => {
    const set = new Set(baseIds());
    for (const r of db.prepare('SELECT cosmetic_id FROM user_cosmetics WHERE user_id = ?').all(userId)) set.add(r.cosmetic_id);
    return set;
  };
  const equippedOf = (userId, owned) => {
    const row = db.prepare('SELECT cosmetics_equipped FROM users WHERE id = ?').get(userId);
    let raw = null; try { raw = row && row.cosmetics_equipped ? JSON.parse(row.cosmetics_equipped) : null; } catch {}
    return sanitizeEquipped(raw || defaultEquipped(), owned);
  };

  app.get('/api/cosmetics', { preHandler: requireAuth }, async (req) => {
    const owned = ownedSet(req.user.id);
    return { catalog: COSMETICS, owned: [...owned], equipped: equippedOf(req.user.id, owned) };
  });

  app.put('/api/cosmetics/equipped', { preHandler: requireAuth }, async (req) => {
    const owned = ownedSet(req.user.id);
    const clean = sanitizeEquipped(req.body, owned); // silently drops unowned / wrong-type / >max
    db.prepare('UPDATE users SET cosmetics_equipped = ? WHERE id = ?').run(JSON.stringify(clean), req.user.id);
    return { ok: true, equipped: clean };
  });
}
