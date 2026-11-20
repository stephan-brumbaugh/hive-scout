// Official numbers to compare against what our scouts saw:
//  - FTCScout OPR (straight from the iPad, no key)
//  - FIRST league roster, league rankings and per-meet results (through the Google Sheet script, which holds the API key)
// Falls back to FTCScout for per-meet results when FIRST isn't set up yet.
import { state, persist, hasLeague, saveLeague, activeEvent } from './store.js';
import { callScript, cloudConfigured } from './cloud.js';
import { ftcscoutQuickStats, ftcscoutTeamResults, ftcscoutLive, ftcscoutTeamEvents, ftcscoutEventInfo, ftcscoutEventField, ftcscoutTeamNames } from './api.js';

export const official = { busy: false, progress: '', onChange: null, liveBusy: false, viewBusy: false, viewProgress: '' };

const STALE_MS = 3 * 60 * 60 * 1000; // refresh automatically when older than 3 hours
const OPR_TTL = 3 * 60 * 60 * 1000;  // a team's OPR is re-checked after 3 hours…
const OPR_LIVE_TTL = 10 * 60 * 1000; // …or 10 minutes while its event is being played
export const LIVE_MS = 5 * 60 * 1000;  // League tab refresh while a meet / championship is on today
export const IDLE_MS = 30 * 60 * 1000; // …and on other days
const CAL_MS = 6 * 60 * 60 * 1000;   // season calendar check while it's still league season

function notify() {
  if (official.onChange) { try { official.onChange(); } catch (e) { console.error(e); } }
}

function teamsToCover() {
  const set = new Set();
  if (hasLeague()) Object.keys(state.league.teams).forEach(t => set.add(Number(t)));
  const ev = activeEvent();
  if (ev) Object.keys(ev.teams || {}).forEach(t => set.add(Number(t)));
  if (Number(state.settings.ourTeam)) set.add(Number(state.settings.ourTeam));
  return [...set].filter(Boolean).sort((a, b) => a - b);
}

// Apply FIRST's league answer: rankings, meets, and (unless the roster was hand-edited) the roster itself.
function applyLeagueReply(j, replaceRoster) {
  const o = state.official;
  o.leagueInfo = j.league ? { region: j.league.region, code: j.league.code, name: j.league.name } : null;
  o.leagues = j.leagues || [];
  o.rankings = {};
  for (const r of j.rankings || []) o.rankings[r.team] = r;
  o.rankAt = Date.now();
  o.meets = (j.meets || []).map(m => ({ ...m, src: 'FIRST' }));
  o.meetsAt = Date.now();
  o.leagueLive = !!j.live;
  o.firstErr = '';
  if (j.league && j.league.members && j.league.members.length) {
    const cur = state.league;
    if (!cur || cur.src !== 'manual' || replaceRoster) {
      const teams = {};
      for (const t of j.league.members) teams[t] = (cur && cur.teams && cur.teams[t]) || (j.league.names && j.league.names[t]) || '';
      // keep names we already know from loaded events
      for (const ev of Object.values(state.events)) for (const [t, n] of Object.entries(ev.teams || {})) if (t in teams && !teams[t] && n) teams[t] = n;
      const same = cur && cur.code === j.league.code && Object.keys(cur.teams).length === Object.keys(teams).length &&
        Object.keys(teams).every(t => t in cur.teams);
      if (!same) saveLeague({ name: j.league.name, region: j.league.region, code: j.league.code, teams, src: 'FIRST', upd: Date.now() });
    }
  }
}

export function officialAge() {
  const o = state.official;
  return Math.max(o.oprAt || 0, o.rankAt || 0, o.meetsAt || 0);
}

// FTCScout OPR for these teams, skipping any we checked within `ttl`.
async function refreshOpr(teams, ttl, season, label = 'Getting FTCScout OPR') {
  const o = state.official;
  o.oprT = o.oprT || {};
  const now = Date.now();
  const due = teams.filter(t => now - (o.oprT[t] || 0) > ttl);
  if (!due.length) return;
  const say = (d, n) => { official.progress = official.viewProgress = `${label} (${d}/${n})…`; notify(); };
  say(0, due.length);
  try {
    const opr = await ftcscoutQuickStats(season, due, say);
    if (Object.keys(opr).length) for (const t of due) o.oprT[t] = now;
    o.opr = { ...o.opr, ...opr };
    o.oprAt = now;
    o.scoutErr = Object.keys(o.opr).length ? '' : 'FTCScout has no OPR for these teams yet.';
  } catch (e) { o.scoutErr = e.message || String(e); }
}

export async function refreshOfficial({ force = false, replaceRoster = false, oprTtl } = {}) {
  if (official.busy) return;
  if (navigator.onLine === false) { official.progress = 'Offline — showing the last download.'; notify(); return; }
  if (!force && Date.now() - officialAge() < STALE_MS) return;
  official.busy = true;
  const o = state.official;
  const season = Number(state.settings.season) || 2026;
  try {
    // 1) FIRST via the Google Sheet script
    let gotFirstMeets = false;
    if (cloudConfigured() && Number(state.settings.ourTeam)) {
      official.progress = 'Asking FIRST for league rankings…'; notify();
      try {
        const lg = !replaceRoster && state.league && state.league.src === 'manual' && state.league.code ? { region: state.league.region, league: state.league.code } : {};
        const j = await callScript({ action: 'league', season, team: Number(state.settings.ourTeam), ...lg }, 120000);
        if (!j.version || j.version < 2 || j.kind !== 'league') throw new Error('Update the Google Sheet script to the newest version (see README) to get FIRST data.');
        applyLeagueReply(j, replaceRoster);
        gotFirstMeets = true;
      } catch (e) {
        o.firstErr = e.code === 'nokey' ? 'nokey' : (e.message || String(e));
        if (e.reply && e.reply.leagues) o.leagues = e.reply.leagues;
      }
    } else {
      o.firstErr = cloudConfigured() ? 'Enter your team number on the Event tab.' : 'nocloud';
    }
    // 2) FTCScout OPR for league + current event teams
    const teams = teamsToCover();
    if (teams.length) {
      await refreshOpr(teams, oprTtl !== undefined ? oprTtl : force ? 0 : OPR_TTL, season);
      // 3) Per-meet results from FTCScout when FIRST isn't available
      if (!gotFirstMeets && teams.length <= 80) {
        official.progress = 'Getting meet results from FTCScout…'; notify();
        try {
          o.meets = (await ftcscoutTeamResults(season, teams)).map(m => ({ ...m, src: 'FTCScout' }));
          o.meetsAt = Date.now();
        } catch (e) { /* keep previous */ }
      }
    }
    persist('official');
    official.progress = '';
  } finally {
    official.busy = false;
    notify();
  }
}

export function startOfficial() {
  setTimeout(() => refreshOfficial(), 4000);
  window.addEventListener('online', () => setTimeout(() => refreshOfficial(), 3000));
}

// Helpers for screens
export function oprFor(team) { return state.official.opr[team] || null; }
export function rankFor(team) { return state.official.rankings[team] || null; }
export function meetsFor(team) {
  const out = [];
  for (const m of state.official.meets || []) {
    const r = (m.rankings || []).find(x => x.team === Number(team));
    if (r) out.push({ code: m.code, name: m.name, date: m.date, ...r, of: (m.rankings || []).length });
  }
  return out;
}

// ---------- match times & results for the Schedule tab ----------

export function liveFor(code) {
  return ((state.official.live || {})[code]) || null;
}

export async function refreshLive(ev, { force = false } = {}) {
  if (!ev || official.liveBusy || navigator.onLine === false) return;
  const o = state.official;
  o.live = o.live || {};
  const cur = o.live[ev.code];
  if (!force && cur && Date.now() - cur.at < 90 * 1000) return;
  official.liveBusy = true;
  notify();
  const season = Number(ev.season) || Number(state.settings.season) || 2026;
  let matches = null, src = '', err = '';
  try {
    const oldScript = o.liveOld && Date.now() - o.liveOld < 30 * 60 * 1000;
    if (cloudConfigured() && (force || (o.firstErr !== 'nokey' && !oldScript))) {
      try {
        // 'since' keeps an older script (which doesn't know this action) on its cheap no-change path
        const j = await callScript({ action: 'matches', season, event: ev.code, since: Number(state.settings.cloudCursor) || 0 }, 60000);
        if (j.kind !== 'matches') { o.liveOld = Date.now(); throw new Error('Update the Google Sheet script (README section 7) to get FIRST match times and results.'); }
        o.liveOld = 0;
        matches = j.matches;
        src = 'FIRST';
      } catch (e) {
        if (e.code === 'nokey') o.firstErr = 'nokey'; else err = e.message || String(e);
      }
    }
    if (!matches) {
      try { matches = await ftcscoutLive(season, ev.code); src = 'FTCScout'; } catch (e) { err = err || e.message || String(e); }
    }
    if (matches) {
      const m = {};
      for (const x of matches) m[x.n] = x;
      o.live[ev.code] = { at: Date.now(), src, m };
      o.liveErr = '';
      // If we had no schedule yet, use the one that just arrived.
      if ((!ev.matches || !ev.matches.length) && matches.some(x => x.red.length && x.blue.length)) {
        ev.matches = matches.filter(x => x.red.length || x.blue.length).map(x => ({ n: x.n, r: x.red, b: x.blue }));
        persist('events');
      }
    } else {
      o.liveErr = err || 'No match data yet.';
    }
    persist('official');
  } finally {
    official.liveBusy = false;
    notify();
  }
}

// ---------- League tab: any league in our region, then the region championship, then worlds ----------
// The tab follows the season on its own: league standings until our League Tournament is over, then only
// the teams that advanced to the region championship, then only the teams at the FIRST Championship.

const pad2 = n => String(n).padStart(2, '0');
export function todayStr() {
  if (globalThis.__hsToday) return globalThis.__hsToday; // automated tests
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
export const isOver = e => !!e && !!(e.end || e.start) && (e.end || e.start) < todayStr();
export const isOn = e => !!e && !!e.start && e.start <= todayStr() && todayStr() <= (e.end || e.start);

export function lview() {
  return { stage: 'auto', league: '', champ: '', worlds: '', div: '', ...(state.settings.lview || {}) };
}
export function setLview(p) {
  state.settings.lview = { ...lview(), ...p };
  persist('settings');
}

export function ourLeagueCode() {
  return (state.league && state.league.code) || (state.official.leagueInfo && state.official.leagueInfo.code) || '';
}
export function ourRegion() {
  const o = state.official;
  return (state.league && state.league.region) || (o.leagueInfo && o.leagueInfo.region) || (o.stage && o.stage.region) || '';
}

// Leagues FIRST lists for our region (ours first). Empty until FIRST data has loaded once.
export function leagueChoices() {
  const our = ourLeagueCode();
  const list = (state.official.leagues || []).filter(l => l && l.code);
  const parents = new Set(list.map(l => l.parent).filter(Boolean));
  const out = list.map(l => ({ code: l.code, name: l.name || l.code, parent: parents.has(l.code), ours: l.code === our }));
  if (our && !out.some(l => l.ours)) out.push({ code: our, name: (state.league && state.league.name) || our, parent: false, ours: true });
  return out.sort((a, b) => (b.ours - a.ours) || (a.parent - b.parent) || a.name.localeCompare(b.name));
}

// The league shown on the League tab: ours unless another one was picked.
export function leagueView(code = lview().league) {
  const o = state.official;
  const our = ourLeagueCode();
  if (!code || code === our) {
    return {
      ours: true, code: our, name: (state.league && state.league.name) || (o.leagueInfo && o.leagueInfo.name) || '',
      teams: (state.league && state.league.teams) || {}, rankings: o.rankings || {}, meets: o.meets || [],
      at: o.rankAt || o.meetsAt || 0, tried: o.leagueTried || 0, err: o.firstErr || '', live: !!o.leagueLive,
    };
  }
  const v = (o.views || {})['L:' + code];
  const ch = leagueChoices().find(l => l.code === code);
  return { ours: false, code, name: (ch && ch.name) || code, teams: {}, rankings: {}, meets: [], at: 0, tried: 0, err: '', live: false, ...(v || {}) };
}

// FIRST Championship events grouped into families: the championship and its divisions.
export function worldsFamily(list, pick = '') {
  list = (list || []).filter(e => e && e.code);
  if (!list.length) return null;
  const child = (c, p) => c.code !== p.code && (c.div === p.code || (c.code.startsWith(p.code) && c.code.length > p.code.length));
  const day = s => Math.floor((Date.parse(s) || 0) / 864e5);
  const tops = list.filter(p => !list.some(q => child(p, q)))
    .sort((a, b) => a.code.length - b.code.length || a.code.localeCompare(b.code));
  const fams = [];
  for (const p of tops) {
    const kids = list.filter(c => child(c, p));
    const near = fams.find(f => Math.abs(day(f.parent.start) - day(p.start)) <= 5);
    if (near) near.divs.push(p, ...kids);
    else fams.push({ parent: p, divs: kids });
  }
  const our = Number(state.settings.ourTeam);
  const has = f => [f.parent, ...f.divs].some(e => (e.teams || []).some(t => t.n === our));
  const size = f => [f.parent, ...f.divs].reduce((n, e) => n + (e.teams || []).length, 0);
  return (pick && fams.find(f => [f.parent, ...f.divs].some(e => e.code === pick))) || fams.find(has) || fams.find(f => size(f) > 0) || fams[0];
}

export function divLabel(e, parent) {
  if (!e || (parent && e.code === parent.code)) return '';
  let n = String(e.name || '');
  if (parent && parent.name && n.startsWith(parent.name)) n = n.slice(parent.name.length);
  n = n.replace(/^[\s\-–—:]+/, '').replace(/\s*division$/i, '').trim();
  return n || e.code;
}

// Everyone at worlds, with the division they play in and their rank there.
export function worldsTeams(fam) {
  const out = new Map();
  if (!fam) return [];
  for (const e of [fam.parent, ...fam.divs]) {
    const ranks = {};
    for (const r of e.rankings || []) ranks[r.team] = r;
    for (const t of e.teams || []) {
      const cur = out.get(t.n);
      const isDiv = e !== fam.parent;
      if (cur && !isDiv) continue; // a division listing beats the parent listing
      out.set(t.n, { n: t.n, name: t.name || (cur && cur.name) || '', home: t.home || (cur && cur.home) || '', div: isDiv ? e.code : '', divName: divLabel(e, fam.parent), r: ranks[t.n] || (cur && cur.r) || null });
    }
  }
  return [...out.values()];
}

export function pickChamp(champs, code = '') {
  const our = Number(state.settings.ourTeam);
  return (champs || []).find(c => c.code === code) || (champs || []).find(c => (c.teams || []).some(t => t.n === our)) || (champs || [])[0] || null;
}

// Where the season is, and what the League tab should show.
export function stageInfo() {
  const o = state.official;
  const cal = o.stage || {};
  const p = lview();
  const lc = ourLeagueCode();
  const allLt = cal.lt || [];
  const lts = lc && allLt.some(e => e.league === lc) ? allLt.filter(e => e.league === lc) : allLt;
  const ltDone = lts.length > 0 && lts.every(isOver);
  const champs = cal.champs || [];
  const champ = pickChamp(champs, p.champ);
  const fam = worldsFamily(cal.worlds || [], p.worlds);
  const wTeams = worldsTeams(fam);
  const champTeams = champ ? (champ.teams || []).length : 0;
  const famEvents = fam ? [fam.parent, ...fam.divs] : [];
  let auto = 'league';
  if (champ && champTeams && (ltDone || isOn(champ) || isOver(champ))) auto = 'region';
  if (wTeams.length && ((champ && isOver(champ)) || famEvents.some(e => isOn(e) || isOver(e)))) auto = 'worlds';
  const manual = ['league', 'region', 'worlds'].includes(p.stage);
  const stage = manual ? p.stage : auto;
  // Worlds division: the one picked, else ours if we're there, else everyone.
  const our = Number(state.settings.ourTeam);
  const mine = wTeams.find(t => t.n === our);
  const div = p.div === 'all' ? '' : p.div && fam && fam.divs.some(d => d.code === p.div) ? p.div : (mine && mine.div) || '';
  return { cal, p, lts, ltDone, champs, champ, champTeams, fam, famEvents, wTeams, div, auto, stage, manual };
}

export function viewLive(info = stageInfo()) {
  if (info.stage === 'region') return isOn(info.champ);
  if (info.stage === 'worlds') return info.famEvents.some(isOn);
  const lv = leagueView();
  return (lv.meets || []).some(m => m.date === todayStr()) || (lv.live && sameDay(lv.at)) || info.lts.some(isOn);
}
function sameDay(ts) {
  if (!ts) return false;
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` === todayStr();
}
export function viewInterval(info = stageInfo()) { return viewLive(info) ? LIVE_MS : IDLE_MS; }

// When the data on screen was last downloaded (0 = never).
export function viewUpdated(info = stageInfo()) {
  if (info.stage === 'league') return leagueView().at || 0;
  return (info.cal && info.cal.at) || 0;
}
export function viewSource(info = stageInfo()) {
  if (info.stage === 'league') {
    const lv = leagueView();
    return lv.ours ? ((state.official.meets || [])[0] || {}).src || (state.official.rankAt ? 'FIRST' : '') : 'FIRST';
  }
  return (info.cal && info.cal.src) || '';
}

// Team numbers shown in the current view (for OPR and season results).
export function viewTeamNums(info = stageInfo()) {
  if (info.stage === 'region') return ((info.champ && info.champ.teams) || []).map(t => t.n);
  if (info.stage === 'worlds') return info.wTeams.filter(t => !info.div || t.div === info.div).map(t => t.n);
  return Object.keys(leagueView().teams || {}).map(Number).filter(Boolean);
}

export function seasonMeetsFor(team) {
  return (((state.official.tmeets || {})[team]) || {}).list || [];
}

// Rank at the region championship / worlds division, for the team detail card.
export function stageRanksFor(team) {
  const cal = state.official.stage || {};
  const out = [];
  for (const e of [...(cal.champs || []), ...(cal.worlds || [])]) {
    const r = (e.rankings || []).find(x => x.team === Number(team));
    if (r) out.push({ code: e.code, name: e.name, ...r, of: (e.rankings || []).length });
  }
  return out;
}

// A team's name from any league or championship list we've downloaded.
export function officialName(t) {
  t = Number(t);
  const o = state.official;
  for (const v of Object.values(o.views || {})) if (v.teams && v.teams[t]) return v.teams[t];
  const cal = o.stage || {};
  for (const e of [...(cal.champs || []), ...(cal.worlds || [])]) {
    const x = (e.teams || []).find(y => y.n === t);
    if (x && x.name) return x.name;
  }
  return '';
}

function knownName(t) {
  if (state.league && state.league.teams && state.league.teams[t]) return state.league.teams[t];
  for (const ev of Object.values(state.events)) if (ev.teams && ev.teams[t]) return ev.teams[t];
  return '';
}

// Another league's roster, standings and meets (FIRST, through the Google Sheet script).
async function refreshLeague(code, season) {
  const o = state.official;
  o.views = o.views || {};
  const key = 'L:' + code;
  const prev = o.views[key] || {};
  const fail = err => { o.views[key] = { ...prev, code, tried: Date.now(), err }; };
  if (!cloudConfigured()) return fail('nocloud');
  if (o.firstErr === 'nokey') return fail('nokey');
  official.viewProgress = 'Asking FIRST for this league…'; notify();
  try {
    const j = await callScript({ action: 'league', season, team: 0, region: ourRegion(), league: code }, 120000);
    if (j.kind !== 'league' || !j.league) throw new Error('Update the Google Sheet script to the newest version (README section 7).');
    const teams = {};
    for (const t of j.league.members || []) teams[t] = (j.league.names && j.league.names[t]) || (prev.teams && prev.teams[t]) || knownName(t) || '';
    const missing = Object.keys(teams).filter(t => !teams[t]);
    if (missing.length && missing.length <= 60) {
      try { const nm = await ftcscoutTeamNames(missing); for (const t of missing) if (nm[t]) teams[t] = nm[t]; } catch (e) { /* numbers only */ }
    }
    const rankings = {};
    for (const r of j.rankings || []) rankings[r.team] = r;
    o.views[key] = { code, name: j.league.name || code, region: j.league.region, teams, rankings, meets: (j.meets || []).map(m => ({ ...m, src: 'FIRST' })), live: !!j.live, at: Date.now(), tried: Date.now(), err: '' };
    if (j.leagues && j.leagues.length) o.leagues = j.leagues;
  } catch (e) {
    if (e.code === 'nokey') o.firstErr = 'nokey';
    fail(e.code === 'nokey' ? 'nokey' : (e.message || String(e)));
  }
}

const typeOf = e => {
  const t = String(e.type || '');
  if (/first\s*championship/i.test(t)) return 'worlds';
  if (/league\s*tournament/i.test(t)) return 'lt';
  if (/championship/i.test(t)) return 'champ';
  return '';
};

// Without FIRST: our own team's events on FTCScout (and any championship picked by hand).
async function stageFromFtcscout(season, our) {
  const evs = our ? await ftcscoutTeamEvents(season, our) : [];
  const infos = (await Promise.all(evs.map(e => ftcscoutEventInfo(season, e.code).catch(() => null)))).filter(Boolean);
  const cal = { src: 'FTCScout', region: ourRegion(), lt: [], champs: [], worlds: [], leagueOf: {} };
  for (const e of infos) {
    const k = typeOf(e);
    if (k === 'lt') cal.lt.push(e); else if (k === 'champ') cal.champs.push(e); else if (k === 'worlds') cal.worlds.push(e);
  }
  for (const e of [...cal.champs, ...cal.worlds]) Object.assign(e, await ftcscoutEventField(season, e.code));
  return cal;
}

// Championships picked by hand that the main source didn't list.
async function addPicked(cal, season) {
  const p = lview();
  for (const [code, list] of [[p.champ, cal.champs], [p.worlds, cal.worlds]]) {
    if (!code || list.some(e => e.code === code)) continue;
    try {
      const info = (await ftcscoutEventInfo(season, code)) || { code, name: code, start: '', end: '' };
      Object.assign(info, await ftcscoutEventField(season, code));
      info.picked = true;
      list.push(info);
    } catch (e) { /* keep the rest */ }
  }
}

async function refreshStage(season) {
  const o = state.official;
  const our = Number(state.settings.ourTeam);
  const prev = o.stage || {};
  let cal = null, err = '', note = '';
  const oldScript = o.stageOld && Date.now() - o.stageOld < 30 * 60 * 1000;
  if (cloudConfigured() && our && o.firstErr !== 'nokey' && !oldScript) {
    official.viewProgress = 'Asking FIRST for the championship lists…'; notify();
    try {
      // 'since' keeps an older script (which doesn't know this action) on its cheap no-change path
      const j = await callScript({ action: 'stage', season, team: our, region: ourRegion() || undefined, since: Number(state.settings.cloudCursor) || 0 }, 120000);
      if (j.kind !== 'stage') { o.stageOld = Date.now(); throw new Error('old'); }
      o.stageOld = 0;
      cal = { src: 'FIRST', region: j.region || ourRegion(), lt: j.lt || [], champs: j.champs || [], worlds: j.worlds || [], leagueOf: j.leagueOf || {} };
    } catch (e) {
      if (e.code === 'nokey') o.firstErr = 'nokey';
      else if (e.message === 'old' || o.stageOld) note = 'old';
      else err = e.message || String(e);
    }
  }
  if (!cal) {
    official.viewProgress = 'Checking FTCScout for championships…'; notify();
    try { cal = await stageFromFtcscout(season, our); } catch (e) { err = err || e.message || String(e); }
  }
  if (cal) {
    await addPicked(cal, season);
    o.stage = { ...cal, at: Date.now(), tried: Date.now(), err: '', note };
  } else {
    o.stage = { ...prev, tried: Date.now(), err: err || 'No championship data yet.', note };
  }
}

async function refreshTeamMeets(teams, season, force) {
  const o = state.official;
  o.tmeets = o.tmeets || {};
  const ttl = force ? 30 * 60 * 1000 : 3 * 60 * 60 * 1000;
  const due = teams.filter(t => Date.now() - ((o.tmeets[t] && o.tmeets[t].at) || 0) > ttl).slice(0, 80);
  if (!due.length) return;
  official.viewProgress = `Getting season results for ${due.length} teams…`; notify();
  try {
    const meets = await ftcscoutTeamResults(season, due);
    for (const t of due) o.tmeets[t] = { at: Date.now(), list: [] };
    for (const m of meets) for (const r of m.rankings) if (o.tmeets[r.team]) o.tmeets[r.team].list.push({ code: m.code, name: m.name, date: m.date, ...r });
  } catch (e) { /* keep the last copy */ }
}

// What's out of date for the League tab right now (nothing → no network at all).
function viewDue(info, force) {
  const o = state.official;
  const now = Date.now();
  const every = viewInterval(info);
  const calAge = now - Math.max((o.stage && o.stage.at) || 0, (o.stage && o.stage.tried) || 0);
  const cal = force || calAge > (info.stage !== 'league' || info.ltDone ? every : CAL_MS);
  let league = false;
  if (info.stage === 'league') {
    const lv = leagueView();
    league = force || now - Math.max(lv.at || 0, lv.tried || 0) > every;
  }
  const ttl = force ? 0 : viewLive(info) ? OPR_LIVE_TTL : OPR_TTL;
  const opr = viewTeamNums(info).some(t => now - ((o.oprT || {})[t] || 0) > ttl);
  return { cal, league, opr, ttl, any: cal || league || opr };
}

// Keep the League tab current. Cheap to call often: it only downloads what is out of date.
export async function refreshView({ force = false } = {}) {
  if (official.viewBusy || navigator.onLine === false) return;
  let info = stageInfo();
  const due = viewDue(info, force);
  if (!due.any) return;
  const season = Number(state.settings.season) || 2026;
  const o = state.official;
  official.viewBusy = true;
  official.viewProgress = 'Updating…';
  notify();
  try {
    if (due.cal) {
      await refreshStage(season);
      info = stageInfo();
    }
    if (info.stage === 'league' && (due.league || due.cal && viewDue(info, false).league)) {
      const lv = leagueView();
      if (lv.ours) {
        o.leagueTried = Date.now();
        await refreshOfficial({ force: true, oprTtl: due.ttl });
      } else {
        await refreshLeague(lv.code, season);
      }
    }
    const teams = viewTeamNums(info);
    await refreshOpr(teams, force ? 0 : viewLive(info) ? OPR_LIVE_TTL : OPR_TTL, season);
    if (info.stage !== 'league') await refreshTeamMeets(teams, season, force);
    persist('official');
  } finally {
    official.viewBusy = false;
    official.viewProgress = '';
    official.progress = '';
    notify();
  }
}
