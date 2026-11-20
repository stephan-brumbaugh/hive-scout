// Local persistence (localStorage). Everything lives on this device until it is sent by QR or exported.
import { validRecord } from './schema.js';

const K = {
  settings: 'hs.settings',
  events: 'hs.events',
  records: 'hs.records',
  picks: 'hs.picks',
  sent: 'hs.sent',
  cloudSent: 'hs.cloudSent',      // record id -> ts last uploaded to the Google Sheet
  cloudSentEv: 'hs.cloudSentEv',  // event code -> upd last uploaded
  cloudDel: 'hs.cloudDel',        // record id -> time deleted here, waiting to be deleted in the Sheet
  league: 'hs.league',            // our league roster {name, region, code, teams: {num: name}, src, upd}
  official: 'hs.official',        // downloaded official data (FTCScout OPR, FIRST rankings / meet results)
};

export const DEFAULT_SETTINGS = {
  scoutName: '',
  ourTeam: '',
  deviceId: '',
  activeEvent: '',
  season: 2026,               // BIOBUZZ = 2026-2027 season
  ftcUser: '',
  ftcKey: '',
  ftcBase: 'https://ftc-api.firstinspires.org/v2.0',
  firstTip: 3,                // launches needed for the first tip (3 NECTAR start in the CELL)
  perTip: 8,                  // launches per tip after that
  swarmT: 16,                 // SWARM RP threshold (LEAVE + PARK points)
  pol1: 4,                    // POLLINATOR 1 RP threshold (tips)
  pol2: 7,                    // POLLINATOR 2 RP threshold (tips)
  symmetry: 'mirror',         // how the blue half maps onto the red half for AUTO comparisons
  weights: { role: 25, auto: 20, rp: 30, rel: 25 },
  slot: '',                   // remembered match-scouting position: R1 R2 B1 B2
  qrSpeed: 900,
  cloudUrl: '',               // Google Apps Script web app URL (…/exec)
  cloudKey: '',               // TEAM_KEY from the script
  cloudOn: true,
  cloudCursor: 0,             // last change number pulled from the Sheet
  cloudLeagueUpd: 0,          // league roster version the Sheet already has
  show: { opr: true, rank: true, meets: true }, // official-data columns shown on the League tab
  watch: [],                  // team numbers whose matches the Schedule tab lists
  watchOurs: true,            // also list our own matches
  // League tab: stage 'auto' follows the season (league → region championship → worlds);
  // league '' = our own league; champ / worlds / div narrow the championship views.
  lview: { stage: 'auto', league: '', champ: '', worlds: '', div: '' },
};

let storageOK = true;

function load(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v ? JSON.parse(v) : fallback;
  } catch (e) {
    storageOK = false;
    return fallback;
  }
}

function saveKey(key, val) {
  try {
    localStorage.setItem(key, JSON.stringify(val));
    return true;
  } catch (e) {
    storageOK = false;
    console.warn('Storage write failed', e);
    return false;
  }
}

const savedSettings = load(K.settings, {});
export const state = {
  settings: {
    ...DEFAULT_SETTINGS,
    ...savedSettings,
    weights: { ...DEFAULT_SETTINGS.weights, ...(savedSettings.weights || {}) },
    show: { ...DEFAULT_SETTINGS.show, ...(savedSettings.show || {}) },
    lview: { ...DEFAULT_SETTINGS.lview, ...(savedSettings.lview || {}) },
  },
  events: load(K.events, {}),
  records: load(K.records, {}),
  picks: load(K.picks, {}),
  sent: load(K.sent, {}),
  cloudSent: load(K.cloudSent, {}),
  cloudSentEv: load(K.cloudSentEv, {}),
  cloudDel: load(K.cloudDel, {}),
  league: load(K.league, null),
  official: { ...emptyOfficial(), ...(load(K.official, null) || {}) },
};

export function emptyOfficial() {
  return {
    opr: {}, oprAt: 0, oprT: {}, rankings: {}, rankAt: 0, meets: [], meetsAt: 0, leagueInfo: null, leagues: [], firstErr: '', scoutErr: '',
    views: {},     // other leagues picked on the League tab: 'L:<code>' -> { code, name, teams, rankings, meets, at, err }
    stage: null,   // season calendar + championship fields: { at, src, region, lt, champs, worlds, leagueOf, err }
    tmeets: {},    // team -> { at, list } season results per team (FTCScout), for championship views
  };
}

// ---------------------------------------------------------------- league & event scope

export function hasLeague() {
  return !!(state.league && Object.keys(state.league.teams || {}).length);
}

export function inLeague(team) {
  team = Number(team);
  if (team && team === Number(state.settings.ourTeam)) return true;
  return hasLeague() && Object.prototype.hasOwnProperty.call(state.league.teams, team);
}

// 'league' = show only our league's teams (league meets / league tournament); 'all' = everyone.
export function eventScope(ev) {
  if (!ev || !hasLeague()) return 'all';
  if (ev.scope === 'league' || ev.scope === 'all') return ev.scope;
  if (ev.type) return /league/i.test(ev.type) ? 'league' : 'all';
  const teams = Object.keys(ev.teams || {});
  if (!teams.length) return 'league';
  const share = teams.filter(t => inLeague(t)).length / teams.length;
  return share >= 0.4 ? 'league' : 'all';
}

export function inScope(team, ev) {
  return eventScope(ev) === 'all' || inLeague(team);
}

export function saveLeague(league) {
  state.league = league ? { ...league, upd: league.upd || Date.now() } : null;
  persist('league');
}

if (!state.settings.deviceId) {
  const letters = 'abcdefghjkmnpqrstuvwxyz', abc = letters + '23456789';
  let id = letters[Math.floor(Math.random() * letters.length)]; // starts with a letter so spreadsheets keep IDs as text
  for (let i = 0; i < 2; i++) id += abc[Math.floor(Math.random() * abc.length)];
  state.settings.deviceId = id;
  saveKey(K.settings, state.settings);
}

export function storageWorks() { return storageOK; }

export function persist(...which) {
  const list = which.length ? which : Object.keys(K);
  let ok = true;
  for (const w of list) ok = saveKey(K[w], state[w]) && ok;
  return ok;
}

export function newId() {
  return state.settings.deviceId + Date.now().toString(36) + Math.random().toString(36).slice(2, 4);
}

// Insert or update a record; newer timestamp wins. Returns 'new' | 'updated' | 'same'.
export function upsertRecord(r) {
  if (!validRecord(r)) return 'invalid';
  const ex = state.records[r.id];
  if (!ex) { state.records[r.id] = r; return 'new'; }
  if ((r.ts || 0) > (ex.ts || 0)) { state.records[r.id] = r; return 'updated'; }
  return 'same';
}

export function deleteRecord(id) {
  delete state.records[id];
  delete state.sent[id];
  delete state.cloudSent[id];
  state.cloudDel[id] = Math.floor(Date.now() / 1000); // remove it from the Google Sheet (and other iPads) too
  persist('records', 'sent', 'cloudSent', 'cloudDel');
}

export function isMine(r) { return r.id.startsWith(state.settings.deviceId); }

// Records that exist only on this iPad: not handed over by QR and not yet in the Google Sheet.
export function unsentRecords() {
  const s = state.settings;
  const cloudOn = s.cloudOn !== false && s.cloudUrl && s.cloudKey;
  return Object.values(state.records).filter(r => r.t !== 's' && isMine(r) && !state.sent[r.id] && !(cloudOn && state.cloudSent[r.id] === r.ts));
}

export function markSent(ids) {
  const now = Math.floor(Date.now() / 1000);
  for (const id of ids) state.sent[id] = now;
  persist('sent');
}

export function activeEvent() {
  return state.events[state.settings.activeEvent] || null;
}

export function eventRecords(code = state.settings.activeEvent, type) {
  return Object.values(state.records).filter(r => r.ev === code && (!type || r.t === type));
}

export function saveEvent(ev) {
  const prev = state.events[ev.code];
  // Keep manually added team names if the new source lacks them
  if (prev) {
    for (const [n, name] of Object.entries(prev.teams || {})) {
      if (!(n in ev.teams)) continue;
      if (!ev.teams[n] && name) ev.teams[n] = name;
    }
  }
  state.events[ev.code] = ev;
  state.settings.activeEvent = ev.code;
  persist('events', 'settings');
}

export function getPick(team, ev = state.settings.activeEvent) {
  return (state.picks[ev] || {})[team] || '';
}

export function setPick(team, flag, ev = state.settings.activeEvent) {
  state.picks[ev] = state.picks[ev] || {};
  if (flag) state.picks[ev][team] = flag; else delete state.picks[ev][team];
  persist('picks');
}

export function backupObject() {
  const { ftcUser, ftcKey, cloudKey, cloudUrl, cloudCursor, cloudLeagueUpd, ...settings } = state.settings;
  return {
    hsBackup: 1,
    exported: new Date().toISOString(),
    settings,
    events: state.events,
    records: state.records,
    picks: state.picks,
    league: state.league,
  };
}

export function mergeBackup(obj) {
  let n = 0, u = 0;
  for (const ev of Object.values(obj.events || {})) {
    if (ev && ev.code) state.events[ev.code] = ev;
  }
  for (const r of Object.values(obj.records || {})) {
    const res = upsertRecord(r);
    if (res === 'new') n++; else if (res === 'updated') u++;
  }
  for (const [ev, teams] of Object.entries(obj.picks || {})) {
    state.picks[ev] = { ...(state.picks[ev] || {}), ...teams };
  }
  if (obj.league && (!state.league || (obj.league.upd || 0) > (state.league.upd || 0))) state.league = obj.league;
  if (!state.settings.activeEvent && obj.settings && obj.settings.activeEvent) {
    state.settings.activeEvent = obj.settings.activeEvent;
  }
  persist();
  return { n, u };
}

export function clearAll() {
  const keepId = state.settings.deviceId;
  for (const k of Object.values(K)) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } }
  state.settings = { ...DEFAULT_SETTINGS, weights: { ...DEFAULT_SETTINGS.weights }, lview: { ...DEFAULT_SETTINGS.lview }, deviceId: keepId };
  state.events = {}; state.records = {}; state.picks = {}; state.sent = {};
  state.cloudSent = {}; state.cloudSentEv = {}; state.cloudDel = {};
  state.league = null; state.official = emptyOfficial();
  persist();
}
