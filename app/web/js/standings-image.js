/* SwissYGO standings image — THE single source of truth for the branded,
 * shareable/printable results artifact (Velvet Room + Budget Occidente). The
 * console "Compartir/Descargar" buttons, the TO "Resultados" view and the
 * player's finished-tournament screen ALL render through here, so changing the
 * format in one place changes it everywhere.
 *
 * Ported verbatim from the original buildStandingsImageBlob() in app.js, but
 * parameterized: it takes a plain `data` object instead of reading the global
 * `state`, reads the palette from CSS vars (theme-aware on any page) and the
 * logos from window.BRAND (so it works on /u/, which has no header/footer).
 *
 * data = {
 *   standings: [{ name, matchPoints, wins, losses, dropped }],  // final order
 *   finished, maxRounds, currentRound, note, date(optional Date)
 * }
 * Classic script → exposes window.StandingsImage.
 */
(function () {
  function svgWithSize(src, px) {
    try {
      const svg = atob(src.split(',')[1]).replace('<svg ', '<svg width="' + px + '" height="' + px + '" ');
      return 'data:image/svg+xml;base64,' + btoa(svg);
    } catch (e) { return src; }
  }
  function loadImg(src) {
    return new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error('No se pudo cargar un logo.'));
      im.src = src;
    });
  }
  function wrapLines(ctx, text, maxW, maxLines) {
    const words = String(text).split(/\s+/).filter(Boolean);
    const lines = []; let line = '';
    for (const w of words) {
      const t = line ? line + ' ' + w : w;
      if (ctx.measureText(t).width > maxW && line) {
        lines.push(line); line = w;
        if (lines.length === maxLines) { line = ''; break; }
      } else line = t;
    }
    if (line && lines.length < maxLines) lines.push(line);
    if (lines.length === maxLines && ctx.measureText(words.join(' ')).width > maxW * maxLines) {
      lines[maxLines - 1] = lines[maxLines - 1].replace(/.{2}$/, '') + '…';
    }
    return lines;
  }
  function ellipsize(ctx, text, maxW) {
    let t = String(text);
    if (ctx.measureText(t).width <= maxW) return t;
    while (t.length > 1 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1);
    return t + '…';
  }

  async function buildCanvas(data) {
    const ordered = (data.standings || []).map((s) => ({
      name: s.name,
      matchPoints: s.matchPoints != null ? s.matchPoints : (s.points || 0),
      wins: s.wins || 0,
      losses: s.losses || 0,
      dropped: !!s.dropped,
    }));
    const finished = !!data.finished;
    const champ = finished ? (ordered.find((s) => !s.dropped) || ordered[0]) : null;
    const listRows = finished ? ordered.filter((s) => s !== champ) : ordered;

    /* Palette: respect the active theme of whatever page we're on. */
    const cs = getComputedStyle(document.documentElement);
    const v = (n, fb) => (cs.getPropertyValue(n).trim() || fb);
    const C = {
      bg: v('--bg', '#14131f'),
      ink: v('--ink', '#eef1f7'),
      soft: v('--ink-soft', '#a7adc2'),
      faint: v('--ink-faint', '#767089'),
      gold: v('--gold', '#82d8eb'),
      line: v('--border-2', '#443f5d'),
    };
    const SANS = v('--sans', 'system-ui, sans-serif');
    const MONO = v('--mono', 'monospace');

    /* Both logos from window.BRAND (works on every page). */
    const B = window.BRAND || {};
    const [crest, budget] = await Promise.all([
      loadImg(svgWithSize(B.crest || '', 256)),
      loadImg(svgWithSize(B.budget || '', 256)),
    ]);

    const W = 1080, PAD = 72;
    const meas = document.createElement('canvas').getContext('2d');
    const dateTxt = (data.date || new Date()).toLocaleDateString('es-CR', { day: 'numeric', month: 'long', year: 'numeric' });
    const note = (data.note || '').trim();

    meas.font = '400 27px ' + SANS;
    const noteLines = note ? wrapLines(meas, note, W - PAD * 2, 3) : [];

    let champFS = 0;
    if (champ) {
      champFS = 124;
      meas.font = '900 ' + champFS + 'px ' + SANS;
      while (meas.measureText(champ.name).width > W - PAD * 2 && champFS > 46) {
        champFS -= 4;
        meas.font = '900 ' + champFS + 'px ' + SANS;
      }
    }

    const headerH = 96;
    const heroH = champ ? (44 + Math.ceil(champFS * 1.3) + 52) : 0;
    const ROW_H = 62;
    const rowsH = listRows.length * ROW_H + (listRows.length ? 18 : 0);
    const noteH = noteLines.length ? noteLines.length * 38 + 34 : 0;
    const footerH = 132;
    const H = PAD + headerH + 44 + heroH + rowsH + noteH + footerH;

    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d');
    ctx.textBaseline = 'alphabetic';

    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, W, H);

    /* Header: crest + store name + date */
    ctx.drawImage(crest, PAD, PAD - 6, headerH, headerH);
    ctx.fillStyle = C.ink;
    ctx.font = '800 42px ' + SANS;
    ctx.fillText('Torneo Yu-Gi-Oh!', PAD + headerH + 28, PAD + 36);
    ctx.fillStyle = C.gold;
    ctx.font = '700 27px ' + SANS;
    ctx.fillText('Velvet Room Game Store', PAD + headerH + 28, PAD + 72);
    ctx.fillStyle = C.soft;
    ctx.font = '400 23px ' + SANS;
    const subInfo = finished
      ? 'Resultados finales · ' + data.maxRounds + ' ronda' + (data.maxRounds === 1 ? '' : 's') + ' · ' + dateTxt
      : 'Standings · Ronda ' + data.currentRound + ' de ' + data.maxRounds + ' · ' + dateTxt;
    ctx.fillText(subInfo, PAD + headerH + 28, PAD + headerH - 2);

    let y = PAD + headerH + 26;
    ctx.strokeStyle = C.line; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(PAD, y); ctx.lineTo(W - PAD, y); ctx.stroke();
    y += 18;

    /* Champion hero (finished only) */
    if (champ) {
      y += 44;
      ctx.fillStyle = C.gold;
      ctx.font = '800 30px ' + SANS;
      try { ctx.letterSpacing = '6px'; } catch (e) {}
      ctx.textAlign = 'center';
      ctx.fillText('🏆 CAMPEÓN', W / 2, y);
      try { ctx.letterSpacing = '0px'; } catch (e) {}

      y += Math.ceil(champFS * 1.08);
      ctx.fillStyle = C.ink;
      ctx.font = '900 ' + champFS + 'px ' + SANS;
      ctx.fillText(champ.name, W / 2, y);

      y += 46;
      ctx.fillStyle = C.soft;
      ctx.font = '600 27px ' + MONO;
      ctx.fillText(champ.matchPoints + ' pts · ' + champ.wins + '-' + champ.losses, W / 2, y);
      ctx.textAlign = 'left';
      y += 6;
    }

    /* Table (from 2nd place if there's a hero; full list otherwise) */
    y += 18;
    const numX = PAD + 64;
    const nameX = PAD + 92;
    const ptsX = W - PAD;
    const maxNameW = ptsX - nameX - 300;
    for (let i = 0; i < listRows.length; i++) {
      const r = listRows[i];
      const pos = ordered.indexOf(r) + 1;
      const rowY = y + ROW_H * (i + 1) - 20;
      const inkMain = r.dropped ? C.faint : C.ink;

      ctx.font = '700 30px ' + MONO;
      ctx.fillStyle = r.dropped ? C.faint : C.gold;
      ctx.textAlign = 'right';
      ctx.fillText(pos + '.', numX, rowY);

      ctx.textAlign = 'left';
      ctx.font = '600 32px ' + SANS;
      ctx.fillStyle = inkMain;
      const nm = ellipsize(ctx, r.name, maxNameW);
      ctx.fillText(nm, nameX, rowY);
      if (r.dropped) {
        const w = ctx.measureText(nm).width;
        ctx.strokeStyle = C.faint; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(nameX, rowY - 10); ctx.lineTo(nameX + w, rowY - 10); ctx.stroke();
        ctx.font = '700 19px ' + SANS;
        ctx.fillText('DROP', nameX + w + 16, rowY - 4);
      }

      ctx.textAlign = 'right';
      ctx.font = '600 28px ' + MONO;
      ctx.fillStyle = r.dropped ? C.faint : C.gold;
      ctx.fillText(r.matchPoints + ' pts (' + r.wins + '-' + r.losses + ')', ptsX, rowY);
      ctx.textAlign = 'left';
    }
    y += rowsH;

    /* Tournament note (prizing, venue…) */
    if (noteLines.length) {
      y += 40;
      ctx.fillStyle = C.soft;
      ctx.font = 'italic 400 27px ' + SANS;
      for (const ln of noteLines) { ctx.fillText(ln, PAD, y); y += 38; }
      y -= 38;
    }

    /* Footer: divider + both brands */
    const fy = H - 64;
    ctx.strokeStyle = C.line; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(PAD, fy - 42); ctx.lineTo(W - PAD, fy - 42); ctx.stroke();
    ctx.drawImage(crest, PAD, fy - 26, 44, 44);
    ctx.fillStyle = C.soft;
    ctx.font = '600 22px ' + SANS;
    ctx.fillText('Velvet Room Game Store', PAD + 58, fy + 4);
    ctx.textAlign = 'right';
    ctx.fillStyle = C.faint;
    ctx.font = '400 21px ' + SANS;
    ctx.fillText('Made with passion by', W - PAD - 56, fy + 3);
    ctx.textAlign = 'left';
    ctx.drawImage(budget, W - PAD - 46, fy - 26, 46, 46);

    return canvas;
  }

  // Returns { blob, file, fname, dataUrl } — same contract the console share/
  // download code expects, plus a dataUrl for <img> previews in results views.
  async function build(data) {
    const canvas = await buildCanvas(data);
    const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
    if (!blob) throw new Error('No se pudo generar la imagen.');
    const fname = data.finished ? 'resultados-torneo.png' : ('standings-ronda-' + data.currentRound + '.png');
    return { blob, file: new File([blob], fname, { type: 'image/png' }), fname, dataUrl: canvas.toDataURL('image/png') };
  }

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // The SAME layout as the PNG above, but as a live HTML element (the "web view"):
  // brand header, champion hero, ranked list, note, dual-logo footer. Styled by
  // .sresult* in connect.css (theme-aware), so it reads identical to the share
  // image. Used by the TO "Resultados" view and the player's finished screen.
  function buildCardEl(data) {
    const ordered = (data.standings || []).map((s) => ({
      name: s.name,
      matchPoints: s.matchPoints != null ? s.matchPoints : (s.points || 0),
      wins: s.wins || 0, losses: s.losses || 0, dropped: !!s.dropped,
    }));
    const finished = !!data.finished;
    const champ = finished ? (ordered.find((s) => !s.dropped) || ordered[0]) : null;
    const list = finished ? ordered.filter((s) => s !== champ) : ordered;
    const B = window.BRAND || {};
    const dateTxt = (data.date || new Date()).toLocaleDateString('es-CR', { day: 'numeric', month: 'long', year: 'numeric' });
    const sub = finished
      ? 'Resultados finales · ' + data.maxRounds + ' ronda' + (data.maxRounds === 1 ? '' : 's') + ' · ' + dateTxt
      : 'Standings · Ronda ' + data.currentRound + ' de ' + data.maxRounds + ' · ' + dateTxt;
    const note = (data.note || '').trim();

    const rows = list.map((r) => {
      const pos = ordered.indexOf(r) + 1;
      return '<div class="sr-row' + (r.dropped ? ' drop' : '') + '">'
        + '<span class="sr-pos">' + pos + '.</span>'
        + '<span class="sr-name">' + esc(r.name) + (r.dropped ? '<span class="sr-drop">DROP</span>' : '') + '</span>'
        + '<span class="sr-pts">' + r.matchPoints + ' pts (' + r.wins + '-' + r.losses + ')</span></div>';
    }).join('');

    const el = document.createElement('div');
    el.className = 'sresult';
    el.innerHTML =
      '<div class="sr-head">'
      + (B.crest ? '<img class="sr-crest" src="' + B.crest + '" alt="">' : '')
      + '<div class="sr-titles"><div class="sr-t1">Torneo Yu-Gi-Oh!</div>'
      + '<div class="sr-t2">Velvet Room Game Store</div>'
      + '<div class="sr-sub">' + esc(sub) + '</div></div></div>'
      + '<div class="sr-divider"></div>'
      + (champ ? '<div class="sr-hero"><div class="sr-champ-label">🏆 CAMPEÓN</div>'
        + '<div class="sr-champ-name">' + esc(champ.name) + '</div>'
        + '<div class="sr-champ-pts">' + champ.matchPoints + ' pts · ' + champ.wins + '-' + champ.losses + '</div></div>' : '')
      + '<div class="sr-list">' + rows + '</div>'
      + (note ? '<div class="sr-note">' + esc(note) + '</div>' : '')
      + '<div class="sr-divider"></div>'
      + '<div class="sr-foot"><div class="sr-foot-l">'
      + (B.crest ? '<img class="sr-foot-logo" src="' + B.crest + '" alt="">' : '')
      + '<span>Velvet Room Game Store</span></div>'
      + '<div class="sr-foot-r"><span>Made with passion by</span>'
      + (B.budget ? '<img class="sr-foot-logo" src="' + B.budget + '" alt="">' : '')
      + '</div></div>';

    // Scale the champion name down to fit on one line (mirrors the PNG, which
    // shrinks the font until it fits). Refit only when the card's WIDTH changes
    // (guarded so font-driven height changes don't loop the ResizeObserver).
    const champEl = el.querySelector('.sr-champ-name');
    if (champEl) {
      const MAX = 76, MIN = 26;
      const fit = () => {
        champEl.style.whiteSpace = 'nowrap'; champEl.style.wordBreak = 'normal';
        let fs = MAX; champEl.style.fontSize = fs + 'px';
        while (champEl.scrollWidth > champEl.clientWidth && fs > MIN) { fs -= 2; champEl.style.fontSize = fs + 'px'; }
        if (champEl.scrollWidth > champEl.clientWidth) { champEl.style.whiteSpace = 'normal'; champEl.style.wordBreak = 'break-word'; }
      };
      if (window.ResizeObserver) {
        let lastW = -1;
        new ResizeObserver((entries) => {
          const w = entries[0].contentRect.width;
          if (Math.abs(w - lastW) < 1) return;
          lastW = w; fit();
        }).observe(el);
      } else {
        requestAnimationFrame(fit);
      }
    }
    return el;
  }

  window.StandingsImage = { build, buildCardEl };
})();
