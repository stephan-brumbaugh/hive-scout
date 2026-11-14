// Official numbers to compare against what our scouts saw:
//  - FTCScout OPR (straight from the iPad, no key)
//  - FIRST league roster, league rankings and per-meet results (through the Google Sheet script, which holds the API key)
// Falls back to FTCScout for per-meet results when FIRST isn't set up yet.
import { state, persist, hasLeague, saveLeague, activeEvent } from './store.js';
import { callScript, cloudConfigured } from './cloud.js';
import { ftcscoutQuickStats, ftcscoutTeamResults } from './api.js';

export const official = { busy: false, progress: '', onChange: null };

const STALE_MS = 3 * 60 * 60 * 1000; // refresh automatically when older than 3 hours

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
  o.firstErr = '';
  if (j.league && j.league.members && j.league.members.length) {
    const cur = state.league;
    if (!cur || cur.src !== 'manual' || replaceRoster) {
      const teams = {};
      for (const t of j.league.members) teams[t] = (cur && cur.teams && cur.teams[t]) || '';
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

export async function refreshOfficial({ force = false, replaceRoster = false } = {}) {
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
      official.progress = `Getting FTCScout OPR (0/${teams.length})…`; notify();
      try {
        const opr = await ftcscoutQuickStats(season, teams, (d, n) => { official.progress = `Getting FTCScout OPR (${d}/${n})…`; notify(); });
        o.opr = { ...o.opr, ...opr };
        o.oprAt = Date.now();
        o.scoutErr = Object.keys(opr).length ? '' : 'FTCScout has no OPR for these teams yet.';
      } catch (e) { o.scoutErr = e.message || String(e); }
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
