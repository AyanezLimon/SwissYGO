/* Deck legality for ranked registration (#109). The banlist is read per-card from
 * YGOProDeck's cardinfo (`banlist_info.ban_tcg`) — always current, nothing to maintain;
 * an absent entry means Unlimited. Copies are counted by card NAME across main+extra+side
 * together, so alternate-art passcodes can't bypass a limit. Default format: TCG. */

const LIMIT = { Forbidden: 0, Limited: 1, 'Semi-Limited': 2 }; // → max copies; anything else = 3
const YGO_CARDINFO = 'https://db.ygoprodeck.com/api/v7/cardinfo.php?id=';

// Resolve passcodes → { [code]: { name, ban } } from YGOProDeck (chunked; best-effort).
export async function fetchCardInfo(codes, fetchImpl = fetch) {
  const uniq = [...new Set((codes || []).map(Number).filter(Boolean))];
  const map = {};
  for (let i = 0; i < uniq.length; i += 100) {
    const chunk = uniq.slice(i, i + 100);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12000);
    try {
      const res = await fetchImpl(YGO_CARDINFO + chunk.join(','), { signal: ctrl.signal });
      if (res.ok) {
        const data = await res.json();
        for (const c of (data.data || [])) map[c.id] = { name: c.name, ban: (c.banlist_info && c.banlist_info.ban_tcg) || null };
      }
    } catch { /* leave these codes unresolved → treated as Unlimited, name '#code' */ }
    finally { clearTimeout(timer); }
  }
  return map;
}

// Pure validator: deck sizes + per-name copy limits. `info` from fetchCardInfo.
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

// Convenience: fetch + validate in one call.
export async function checkDeckLegality(cards, fetchImpl = fetch) {
  const info = await fetchCardInfo([...(cards.main || []), ...(cards.extra || []), ...(cards.side || [])], fetchImpl);
  return validateDeck(cards, info);
}
