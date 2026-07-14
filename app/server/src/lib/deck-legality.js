/* Deck legality for ranked registration (#109). The banlist is read per-card from
 * YGOProDeck's cardinfo (`banlist_info.ban_tcg`) — always current, nothing to maintain;
 * an absent entry means Unlimited. Copies are counted by card NAME across main+extra+side
 * together, so alternate-art passcodes can't bypass a limit. Default format: TCG. */

const LIMIT = { Forbidden: 0, Limited: 1, 'Semi-Limited': 2 }; // → max copies; anything else = 3
const YGO_CARDINFO = 'https://db.ygoprodeck.com/api/v7/cardinfo.php?misc=yes&id=';

// Resolve passcodes → { [code]: { name, ban } } from YGOProDeck (chunked).
// FAILS CLOSED: a ranked legality check must never silently pass an unverifiable deck,
// so any fetch/abort/non-2xx problem throws (banlist_unavailable) instead of returning
/**
 * Fetches banlist metadata for the provided card passcodes.
 * @param {Array<*>} codes - Card passcodes to look up.
 * @param {Function} fetchImpl - Fetch implementation used to query the API.
 * @return {Promise<Object<string, {name: string, ban: string|null}>>} A mapping from card ID to its name and ban status.
 */
export async function fetchCardInfo(codes, fetchImpl = fetch) {
  const uniq = [...new Set((codes || []).map(Number).filter(Boolean))];
  const map = {};
  const query = async (list) => {
    for (let i = 0; i < list.length; i += 100) {
      const chunk = list.slice(i, i + 100);
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 12000);
      try {
        const res = await fetchImpl(YGO_CARDINFO + chunk.join(','), { signal: ctrl.signal });
        if (!res.ok) throw new Error('cardinfo HTTP ' + res.status);
        const data = await res.json();
        for (const c of (data.data || [])) {
          const meta = { name: c.name, ban: (c.banlist_info && c.banlist_info.ban_tcg) || null };
          map[c.id] = meta;
          // Alternate-art/reprint passcodes get normalized to a canonical `id` by the API;
          // the passcode we actually queried with only survives as `misc_info[].beta_id`.
          const betaId = c.misc_info && c.misc_info[0] && c.misc_info[0].beta_id;
          if (betaId) map[betaId] = meta;
        }
      } catch (e) {
        const err = new Error('No se pudo consultar la banlist.');
        err.code = 'banlist_unavailable';
        throw err;
      } finally { clearTimeout(timer); }
    }
  };
  await query(uniq);

  // Some alt-art reprints (e.g. Quarter Century/Rarity Collection prints) get an image
  // asset on YGOProDeck's CDN but never get their own cardinfo record — confirmed the
  // record only ever exists one passcode lower, for the original printing (72270340 →
  // 72270339, 25592143 → 25592142). Retry those specific misses at passcode-1.
  const stillMissing = uniq.filter((c) => !(c in map));
  const fallbackIds = [...new Set(stillMissing.map((c) => c - 1).filter((c) => c > 0))];
  if (fallbackIds.length) {
    await query(fallbackIds);
    for (const c of stillMissing) { const meta = map[c - 1]; if (meta) map[c] = meta; }
  }

  return map;
}

/**
 * Validates deck size and card copy limits.
 * @param {Object} cards - The deck lists to validate.
 * @param {Object} [info={}] - Card metadata indexed by passcode.
 * @return {{ legal: boolean, violations: string[] }} The legality result and any violation messages.
 */
export function validateDeck(cards, info = {}) {
  const main = cards.main || [], extra = cards.extra || [], side = cards.side || [];
  const violations = [];
  if (main.length < 40) violations.push(`Main Deck: ${main.length} cartas — mínimo 40.`);
  if (main.length > 60) violations.push(`Main Deck: ${main.length} cartas — máximo 60.`);
  if (extra.length > 15) violations.push(`Extra Deck: ${extra.length} cartas — máximo 15.`);
  if (side.length > 15) violations.push(`Side Deck: ${side.length} cartas — máximo 15.`);

  // Count copies by card NAME across every section; keep the most restrictive ban seen.
  const seen = new Map(); // name -> { count, ban }
  const rank = (b) => (b in LIMIT ? LIMIT[b] : 3);
  for (const code of [...main, ...extra, ...side]) {
    const meta = info[code] || { name: '#' + code, ban: null };
    const e = seen.get(meta.name) || { count: 0, ban: null };
    e.count++;
    if (meta.ban && (e.ban === null || rank(meta.ban) < rank(e.ban))) e.ban = meta.ban;
    seen.set(meta.name, e);
  }
  for (const [name, e] of seen) {
    const allowed = rank(e.ban);
    if (e.count > allowed) {
      const tag = allowed === 0 ? 'Prohibida' : allowed === 1 ? 'Limitada (máx 1)' : allowed === 2 ? 'Semi-limitada (máx 2)' : 'máx 3';
      violations.push(`${e.count}× ${name} — ${tag}.`);
    }
  }
  return { legal: violations.length === 0, violations };
}

// Convenience: fetch + validate in one call. Fails CLOSED — throws banlist_unavailable
// if the lookup fails, or banlist_incomplete if any card couldn't be resolved, so the
/**
 * Checks whether a deck is legal with banlist data.
 * @param {Object} cards - The deck lists to validate.
 * @param {Function} [fetchImpl=fetch] - The fetch implementation used to retrieve card data.
 * @returns {Promise<{legal: boolean, violations: string[]}>} The deck legality result.
 * @throws {Error} `deck_malformed` if a passcode is invalid, or `banlist_incomplete` if any card cannot be resolved.
 */
export async function checkDeckLegality(cards, fetchImpl = fetch) {
  const codes = [...(cards.main || []), ...(cards.extra || []), ...(cards.side || [])];
  // A malformed passcode (non-positive-integer) can't be verified — fail closed instead of
  // letting it slip past the unresolved check (which drops NaN/0) and be read as Unlimited.
  if (codes.some((c) => !Number.isInteger(Number(c)) || Number(c) <= 0)) {
    const err = new Error('El decklist contiene cartas inválidas.');
    err.code = 'deck_malformed';
    throw err;
  }
  const info = await fetchCardInfo(codes, fetchImpl);
  const unresolved = [...new Set(codes.map(Number))].filter((c) => !(c in info));
  if (unresolved.length) {
    const err = new Error('No se pudo verificar la legalidad de ' + unresolved.length + ' carta(s).');
    err.code = 'banlist_incomplete';
    throw err;
  }
  return validateDeck(cards, info);
}
