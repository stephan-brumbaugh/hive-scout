// Turns raw scouting records into team stats and alliance-partner compatibility scores.

const clamp = (x, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, x));
const mean = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const sd = a => {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
};

export function tipsFrom(made, s) {
  if (made < s.firstTip) return 0;
  return 1 + Math.floor((made - s.firstTip) / Math.max(1, s.perTip));
}

const NUM = ['ns', 'lv', 'aM', 'aX', 'aP', 'tM', 'tX', 'fN', 'fP', 'gd', 'pk', 'df', 'dr', 'mn', 'mj'];

// Several scouts may record the same robot in the same match: average them into one observation.
export function observations(records) {
  const groups = new Map();
  for (const r of records) {
    if (r.t !== 'm') continue;
    const key = `${r.ev}|${r.mt}|${r.tm}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const obs = [];
  for (const list of groups.values()) {
    const o = { ev: list[0].ev, mt: list[0].mt, tm: list[0].tm, al: list[0].al, scouts: list.length, ts: Math.max(...list.map(r => r.ts || 0)) };
    for (const k of NUM) o[k] = mean(list.map(r => Number(r[k]) || 0));
    const rated = list.filter(r => r.dr > 0);
    o.dr = rated.length ? mean(rated.map(r => r.dr)) : 0;
    o.cd = Math.max(...list.map(r => r.cd || 0));
    const withTile = list.find(r => r.st);
    o.st = withTile ? withTile.st : '';
    if (withTile) o.al = withTile.al;
    for (const k of ['aS', 'iS', 'br']) o[k] = [...new Set(list.map(r => r[k] || '').join(''))].join('');
    o.nt = list.map(r => r.nt).filter(Boolean).join(' | ');
    obs.push(o);
  }
  return obs.sort((a, b) => a.mt - b.mt);
}

function obsPoints(o, s) {
  const perLaunch = 20 / Math.max(1, s.perTip);
  const auto = o.lv * 3 + o.aP * 5 + o.aM * perLaunch;
  const tele = o.tM * perLaunch + (o.fN + o.fP) * 2 + o.gd + o.pk * 5;
  return { auto, total: auto + tele };
}

// Pit claims become one low-confidence pseudo-observation when no matches have been scouted.
function pitPseudo(p) {
  return {
    mt: 0, tm: p.tm, al: '', scouts: 0, ns: 0,
    lv: p.aLv ? 1 : 0.5, aM: p.aL || 0, aX: 0, aP: p.aPk ? 1 : 0,
    tM: p.cy || 0, tX: 0, fN: p.fl ? 2 : 0, fP: 0, gd: 0, pk: 0.5,
    df: p.rl === 'D' ? 2 : 0, dr: 0, mn: 0, mj: 0, cd: 0, br: '', aS: p.aS || '', iS: '', st: '', nt: '',
  };
}

export function teamStats(team, obsAll, pit, s) {
  let obs = obsAll.filter(o => o.tm === team);
  const claimed = !obs.length && !!pit;
  const use = claimed ? [pitPseudo(pit)] : obs;
  const pts = use.map(o => obsPoints(o, s));
  const st = {
    team, n: obs.length, claimed, pit, obs: use,
    autoMade: mean(use.map(o => o.aM)),
    teleMade: mean(use.map(o => o.tM)),
    made: mean(use.map(o => o.aM + o.tM)),
    missed: mean(use.map(o => o.aX + o.tX)),
    leave: mean(use.map(o => o.lv)),
    autoPark: mean(use.map(o => o.aP)),
    park: mean(use.map(o => o.pk)),
    flowerN: mean(use.map(o => o.fN)),
    flowerP: mean(use.map(o => o.fP)),
    garden: mean(use.map(o => o.gd)),
    defense: mean(use.map(o => o.df)),
    driver: mean(use.filter(o => o.dr > 0).map(o => o.dr)),
    foulPts: mean(use.map(o => o.mn * 5 + o.mj * 20)),
    broke: mean(use.map(o => (o.ns >= 0.5 || /[DB]/.test(o.br)) ? 1 : 0)),
    tipped: mean(use.map(o => (/T/.test(o.br) ? 1 : 0))),
    yellow: use.some(o => o.cd === 1),
    red: use.some(o => o.cd >= 2),
    est: mean(pts.map(p => p.total)),
    estAuto: mean(pts.map(p => p.auto)),
    estSd: sd(pts.map(p => p.total)),
    tiles: {},
    autoSrc: new Set(),
  };
  st.flower = st.flowerN + st.flowerP;
  const shots = st.made + st.missed;
  st.acc = shots > 0 ? st.made / shots : null;
  for (const o of obs) {
    if (o.st) st.tiles[o.st + '|' + (o.al || 'R')] = (st.tiles[o.st + '|' + (o.al || 'R')] || 0) + 1;
    for (const c of o.aS || '') st.autoSrc.add(c);
  }
  if (pit) {
    for (const t of String(pit.ast || '').split(',').map(x => x.trim()).filter(Boolean)) st.tiles[t + '|R'] = (st.tiles[t + '|R'] || 0) + 1;
    for (const c of pit.aS || '') st.autoSrc.add(c);
  }
  return st;
}

// ---- Tiles: absolute "A1".."F6" as seen from the audience; row 1 = audience side ----
const COLS = 'ABCDEF';
export function tileXY(tile) {
  const m = /^([A-F])([1-6])$/i.exec(String(tile || '').trim());
  if (!m) return null;
  return { c: COLS.indexOf(m[1].toUpperCase()), r: Number(m[2]) - 1 };
}

// Convert a tile observed for an alliance into red-side coordinates so partners can be compared.
function toRedFrame(tile, alliance, symmetry) {
  const p = tileXY(tile);
  if (!p) return null;
  if (alliance !== 'B') return p;
  return symmetry === 'rotate' ? { c: 5 - p.c, r: 5 - p.r } : { c: 5 - p.c, r: p.r };
}

function tilesRed(st, symmetry) {
  return Object.keys(st.tiles).map(k => { const [t, al] = k.split('|'); return toRedFrame(t, al, symmetry); }).filter(Boolean);
}

export function eventContext(statsList) {
  const has = statsList.filter(s => s.n || s.claimed);
  return {
    hMax: Math.max(4, ...has.map(s => s.made)),
    fMax: Math.max(2, ...has.map(s => s.flower)),
    aMax: Math.max(8, ...has.map(s => s.estAuto)),
  };
}

// Expected bonus-RP outcome for an alliance of two teams, by pairing every observed match of each.
export function rpOdds(us, them, s) {
  const A = us.obs.slice(-12), B = them.obs.slice(-12);
  if (!A.length || !B.length) return null;
  let p4 = 0, p7 = 0, pS = 0, tipSum = 0, n = 0;
  for (const a of A) for (const b of B) {
    const made = a.aM + a.tM + b.aM + b.tM;
    const tips = tipsFrom(made, s);
    const swarm = (a.lv + b.lv) * 3 + (a.aP + b.aP + a.pk + b.pk) * 5;
    tipSum += tips;
    if (tips >= s.pol1) p4++;
    if (tips >= s.pol2) p7++;
    if (swarm >= s.swarmT - 1e-9) pS++;
    n++;
  }
  return { pS: pS / n, p4: p4 / n, p7: p7 / n, tips: tipSum / n, expRP: (pS + p4 + p7) / n, pairs: n };
}

export function compatibility(us, them, ctx, s) {
  const notes = [];
  const usOK = us && (us.n || us.claimed);
  const themOK = them && (them.n || them.claimed);

  // 1. Complementary roles: reward strength where we are weaker (HIVE launching vs FLOWER endgame).
  let role = 0.5;
  if (usOK && themOK) {
    const uh = clamp(us.made / ctx.hMax), uf = clamp(us.flower / ctx.fMax);
    const th = clamp(them.made / ctx.hMax), tf = clamp(them.flower / ctx.fMax);
    const wH = 0.5 + 0.5 * (1 - uh), wF = 0.5 + 0.5 * (1 - uf);
    role = (wH * th + wF * tf) / (wH + wF);
    if (uf < uh && tf >= 0.5) notes.push('+ Strong at FLOWERs, where you are weaker');
    if (uh < uf && th >= 0.5) notes.push('+ Strong HIVE launcher, where you are weaker');
    const ur = us.pit && us.pit.rl, tr = them.pit && them.pit.rl;
    if (ur && tr && ur !== 'X' && tr !== 'X') {
      if (ur === tr) { role *= 0.85; notes.push('– Same preferred role as you (' + ({ H: 'HIVE', F: 'FLOWER', D: 'defense' }[tr] || tr) + ')'); }
      else { role = clamp(role * 1.1); notes.push('+ Different preferred role from you'); }
    } else if (tr === 'X') notes.push('+ Says they can play any role');
  }

  // 2. AUTO compatibility: starting tiles far apart, not fighting over the same pieces, and real AUTO points.
  let auto = 0.5;
  const ut = usOK ? tilesRed(us, s.symmetry) : [], tt = themOK ? tilesRed(them, s.symmetry) : [];
  if (ut.length && tt.length) {
    let best = 0;
    for (const a of ut) for (const b of tt) {
      const d = Math.max(Math.abs(a.c - b.c), Math.abs(a.r - b.r));
      best = Math.max(best, d === 0 ? 0.2 : d === 1 ? 0.6 : 1);
    }
    let pos = best;
    if (best <= 0.2) notes.push('– Only seen starting on the same tile as you');
    else if (best <= 0.6) notes.push('~ Starts next to your tile; check AUTO paths');
    else notes.push('+ AUTO starts away from yours');
    const shared = [...us.autoSrc].filter(c => c !== 'P' && them.autoSrc.has(c));
    if (shared.includes('G')) { pos -= 0.15; notes.push('– Both use the GARDEN in AUTO'); }
    if (shared.includes('F')) { pos -= 0.1; notes.push('– Both pull from FLOWERs in AUTO'); }
    const value = clamp(them.estAuto / ctx.aMax);
    auto = clamp(0.65 * clamp(pos) + 0.35 * value);
  } else if (themOK) {
    auto = clamp(0.5 * 0.65 + 0.35 * clamp(them.estAuto / ctx.aMax));
    notes.push('? No AUTO start data yet');
  }

  // 3. Ranking-point odds for the pair.
  let rp = 0.5, odds = null;
  if (usOK && themOK) {
    odds = rpOdds(us, them, s);
    if (odds) rp = odds.expRP / 3;
  }

  // 4. Reliability & clean play (partner only).
  let rel = 0.5;
  if (themOK) {
    rel = 0.65 * (1 - them.broke) + 0.35 * clamp(1 - them.foulPts / 25);
    if (them.tipped > 0) rel -= 0.05;
    if (them.yellow) { rel -= 0.1; notes.push('– Has a YELLOW CARD this event'); }
    if (them.red) { rel -= 0.25; notes.push('– Has a RED CARD this event'); }
    if (them.broke >= 0.25) notes.push(`– Broke down or no-show in ${Math.round(them.broke * 100)}% of matches`);
    if (them.foulPts >= 10) notes.push(`– Gives away ${them.foulPts.toFixed(0)} foul pts/match`);
    rel = clamp(rel);
  }

  const w = s.weights;
  const wSum = (w.role + w.auto + w.rp + w.rel) || 1;
  const score = 100 * (w.role * role + w.auto * auto + w.rp * rp + w.rel * rel) / wSum;
  const conf = !themOK ? 'none' : them.claimed ? 'pit' : them.n >= 4 ? 'good' : them.n >= 2 ? 'some' : 'low';
  if (!usOK) notes.unshift('? No data for your own robot yet');
  if (them && them.claimed) notes.push('? Based on pit claims only');
  return { score, parts: { role, auto, rp, rel }, odds, notes, conf };
}
