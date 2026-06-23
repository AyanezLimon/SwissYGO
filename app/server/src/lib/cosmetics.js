/* Cosmetic catalog (#37, Phase 1). Profile decorations of three kinds:
 *   - border: a frame/glow around your name chip
 *   - banner: a background strip on your profile header
 *   - badge:  small icons shown next to your name (up to MAX_BADGES equipped)
 * `base: true` items belong to EVERYONE implicitly; the rest must be granted
 * (admin in Phase 1; seasonal rules in Phase 3). `render` is a plain object of CSS
 * properties the client applies via Object.assign(el.style, render) — so this file
 * is the single source of truth for both ownership AND look. Keep ids stable: they
 * are persisted in users.cosmetics_equipped / user_cosmetics. */

export const MAX_BADGES = 3;

export const COSMETICS = [
  // ---- borders ----
  { id: 'border-none',     type: 'border', name: 'Sin borde',   rarity: 'base',      base: true,  render: {} },
  { id: 'border-slate',    type: 'border', name: 'Pizarra',     rarity: 'base',      base: true,  render: { border: '2px solid #6b7280', borderRadius: '10px' } },
  { id: 'border-teal',     type: 'border', name: 'Turquesa',    rarity: 'base',      base: true,  render: { border: '2px solid #2dd4bf', borderRadius: '10px' } },
  { id: 'border-gold',     type: 'border', name: 'Oro',         rarity: 'rare',      base: false, render: { border: '2px solid #d4af37', borderRadius: '10px', boxShadow: '0 0 10px rgba(212,175,55,.45)' } },
  { id: 'border-crimson',  type: 'border', name: 'Carmesí',     rarity: 'rare',      base: false, render: { border: '2px solid #e5534b', borderRadius: '10px', boxShadow: '0 0 10px rgba(229,83,75,.40)' } },
  { id: 'border-champion', type: 'border', name: 'Campeón',     rarity: 'legendary', base: false, render: { border: '2px solid #d4af37', borderRadius: '10px', boxShadow: '0 0 16px rgba(212,175,55,.75)' } },

  // ---- banners ----
  { id: 'banner-none',   type: 'banner', name: 'Sin banner', rarity: 'base',      base: true,  render: {} },
  { id: 'banner-dusk',   type: 'banner', name: 'Crepúsculo', rarity: 'base',      base: true,  render: { background: 'linear-gradient(135deg,#2b2942,#211f35)' } },
  { id: 'banner-ocean',  type: 'banner', name: 'Océano',     rarity: 'base',      base: true,  render: { background: 'linear-gradient(135deg,#0e7490,#1e3a5f)' } },
  { id: 'banner-sunset', type: 'banner', name: 'Atardecer',  rarity: 'rare',      base: false, render: { background: 'linear-gradient(135deg,#7c2d12,#b45309,#d4af37)' } },
  { id: 'banner-royal',  type: 'banner', name: 'Realeza',    rarity: 'rare',      base: false, render: { background: 'linear-gradient(135deg,#4c1d95,#7c3aed)' } },

  // ---- badges (icon = emoji shown by the name) ----
  { id: 'badge-rookie', type: 'badge', name: 'Novato',    rarity: 'base',      base: true,  icon: '🐣' },
  { id: 'badge-fire',   type: 'badge', name: 'En racha',  rarity: 'base',      base: true,  icon: '🔥' },
  { id: 'badge-star',   type: 'badge', name: 'Estrella',  rarity: 'base',      base: true,  icon: '⭐' },
  { id: 'badge-skull',  type: 'badge', name: 'Calavera',  rarity: 'base',      base: true,  icon: '💀' },
  { id: 'badge-crown',  type: 'badge', name: 'Corona',    rarity: 'rare',      base: false, icon: '👑' },
  { id: 'badge-trophy', type: 'badge', name: 'Trofeo',    rarity: 'rare',      base: false, icon: '🏆' },
  { id: 'badge-goat',   type: 'badge', name: 'GOAT',      rarity: 'legendary', base: false, icon: '🐐' },
];

const BY_ID = new Map(COSMETICS.map((c) => [c.id, c]));
export const byId = (id) => BY_ID.get(id) || null;
export const exists = (id) => BY_ID.has(id);
export const isType = (id, type) => { const c = BY_ID.get(id); return !!c && c.type === type; };
export const isBase = (id) => { const c = BY_ID.get(id); return !!c && c.base; };
export const baseIds = () => COSMETICS.filter((c) => c.base).map((c) => c.id);
export const grantableIds = () => COSMETICS.filter((c) => !c.base).map((c) => c.id);

// Default equipped set (everything "none"/empty) — used when a user hasn't chosen.
export const defaultEquipped = () => ({ border: 'border-none', banner: 'banner-none', badges: [] });

// Resolve+sanitize an equipped selection against what the user OWNS (set of ids).
// Drops anything not owned or of the wrong type; clamps badges to MAX_BADGES.
export function sanitizeEquipped(equipped, ownedSet) {
  const e = equipped && typeof equipped === 'object' ? equipped : {};
  const okOne = (id, type) => (typeof id === 'string' && isType(id, type) && ownedSet.has(id)) ? id : (type === 'border' ? 'border-none' : 'banner-none');
  const badges = Array.isArray(e.badges)
    ? [...new Set(e.badges.filter((id) => isType(id, 'badge') && ownedSet.has(id)))].slice(0, MAX_BADGES)
    : [];
  return { border: okOne(e.border, 'border'), banner: okOne(e.banner, 'banner'), badges };
}
