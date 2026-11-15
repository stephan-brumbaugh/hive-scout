// Event data sources: FTCScout (public, browser-friendly), the official FIRST FTC Events API,
// event files, and manual entry. Every source produces the same event object:
// { code, season, name, teams: { [number]: name }, matches: [{ n, r: [t1, t2], b: [t3, t4] }], src, upd }

const SCOUT_GQL = 'https://api.ftcscout.org/graphql';
const SCOUT_REST = 'https://api.ftcscout.org/rest/v1';

async function fetchT(url, opts = {}, ms = 20000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctl.signal });
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('The request timed out. Check the internet connection.');
    throw e;
  } finally {
    clearTimeout(t);
  }
}

function offlineCheck() {
  if (navigator.onLine === false) throw new Error('This iPad is offline. Connect to the internet, or use Manual / File / QR instead.');
}

async function gql(query, variables) {
  const res = await fetchT(SCOUT_GQL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error('FTCScout returned HTTP ' + res.status);
  const j = await res.json();
  if (j.errors && j.errors.length) throw new Error(j.errors[0].message || 'FTCScout query error');
  return j.data;
}

async function rest(path) {
  const res = await fetchT(SCOUT_REST + path);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error('FTCScout returned HTTP ' + res.status);
  return res.json();
}

async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try { out[idx] = await fn(items[idx]); } catch (e) { out[idx] = null; }
    }
  });
  await Promise.all(workers);
  return out;
}

const isQual = lvl => /qual/i.test(String(lvl || ''));
const isRed = a => /red/i.test(String(a || ''));
const stationNum = s => {
  const m = String(s ?? '').match(/(\d)|one|two|three/i);
  if (!m) return 9;
  if (m[1]) return Number(m[1]);
  return { one: 1, two: 2, three: 3 }[m[0].toLowerCase()] || 9;
};

function buildMatches(list, getNum, getLevel, getTeams, getTeamNum, getAlliance, getStation) {
  const byNum = new Map();
  for (const m of list || []) {
    if (getLevel && !isQual(getLevel(m))) continue;
    const n = Number(getNum(m));
    if (!n) continue;
    const teams = (getTeams(m) || []).slice().sort((a, b) => stationNum(getStation(a)) - stationNum(getStation(b)));
    const r = teams.filter(t => isRed(getAlliance(t))).map(t => Number(getTeamNum(t))).filter(Boolean);
    const b = teams.filter(t => !isRed(getAlliance(t))).map(t => Number(getTeamNum(t))).filter(Boolean);
    byNum.set(n, { n, r, b });
  }
  return [...byNum.values()].sort((a, b) => a.n - b.n);
}

// ---------- FTCScout ----------

const Q_EVENT_TYPE = `query E($s:Int!,$c:String!){eventByCode(season:$s,code:$c){code name start type teams{teamNumber team{name}} matches{matchNum tournamentLevel teams{teamNumber alliance station}}}}`;
const Q_EVENT_FULL = `query E($s:Int!,$c:String!){eventByCode(season:$s,code:$c){code name start teams{teamNumber team{name}} matches{matchNum tournamentLevel teams{teamNumber alliance station}}}}`;
const Q_EVENT_MIN = `query E($s:Int!,$c:String!){eventByCode(season:$s,code:$c){code name teams{teamNumber} matches{matchNum tournamentLevel teams{teamNumber alliance}}}}`;

async function fillNames(teams) {
  const missing = Object.keys(teams).filter(n => !teams[n]);
  if (!missing.length) return;
  const got = await pool(missing, 6, n => rest('/teams/' + n));
  missing.forEach((n, i) => { if (got[i] && got[i].name) teams[n] = got[i].name; });
}

export async function ftcscoutEvent(season, code) {
  offlineCheck();
  code = code.trim().toUpperCase();
  let ev = null, lastErr = null;
  for (const q of [Q_EVENT_TYPE, Q_EVENT_FULL, Q_EVENT_MIN]) {
    try {
      const d = await gql(q, { s: Number(season), c: code });
      if (!d || !d.eventByCode) throw new Error(`Event ${code} was not found on FTCScout for the ${season} season.`);
      ev = d.eventByCode;
      break;
    } catch (e) {
      lastErr = e;
      if (/not found/i.test(e.message)) throw e;
    }
  }
  let teams = {}, matches = [], name = code, type = '';
  if (ev) {
    name = ev.name || code;
    type = ev.type ? String(ev.type) : '';
    for (const t of ev.teams || []) teams[t.teamNumber] = (t.team && t.team.name) || '';
    matches = buildMatches(ev.matches, m => m.matchNum, m => m.tournamentLevel, m => m.teams,
      t => t.teamNumber, t => t.alliance, t => t.station);
  } else {
    // REST fallback
    const info = await rest(`/events/${season}/${code}`).catch(() => null);
    const tlist = await rest(`/events/${season}/${code}/teams`).catch(e => { lastErr = e; return null; });
    if (!tlist) throw lastErr || new Error(`Event ${code} was not found on FTCScout.`);
    name = (info && info.name) || code;
    type = (info && info.type) ? String(info.type) : '';
    for (const t of tlist) teams[t.teamNumber] = (t.team && t.team.name) || '';
    const mlist = await rest(`/events/${season}/${code}/matches`).catch(() => []);
    matches = buildMatches(mlist, m => m.matchNum, m => m.tournamentLevel, m => m.teams,
      t => t.teamNumber, t => t.alliance, t => t.station);
  }
  await fillNames(teams);
  // Teams that appear in the schedule but not the team list
  for (const m of matches) for (const t of [...m.r, ...m.b]) if (!(t in teams)) teams[t] = '';
  return { code, season: Number(season), name, type, teams, matches, src: 'FTCScout', upd: Date.now() };
}

export async function ftcscoutTeamEvents(season, team) {
  offlineCheck();
  try {
    const d = await gql(`query T($n:Int!,$s:Int!){teamByNumber(number:$n){name events(season:$s){eventCode event{name start}}}}`,
      { n: Number(team), s: Number(season) });
    if (!d.teamByNumber) throw new Error(`Team ${team} was not found on FTCScout.`);
    return (d.teamByNumber.events || []).map(e => ({ code: e.eventCode, name: (e.event && e.event.name) || e.eventCode, start: e.event && e.event.start }))
      .sort((a, b) => String(a.start).localeCompare(String(b.start)));
  } catch (e) {
    if (/not found/i.test(e.message)) throw e;
    const list = await rest(`/teams/${team}/events/${season}`);
    if (!list) throw new Error(`Team ${team} was not found on FTCScout.`);
    const out = list.map(e => ({ code: e.eventCode, name: e.eventCode }));
    const infos = await pool(out, 4, e => rest(`/events/${season}/${e.code}`));
    out.forEach((e, i) => { if (infos[i]) { e.name = infos[i].name || e.code; e.start = infos[i].start; } });
    return out;
  }
}

export async function ftcscoutSearch(season, text) {
  offlineCheck();
  try {
    const d = await gql(`query S($s:Int!,$t:String){eventsSearch(season:$s,searchText:$t,limit:30){code name start}}`,
      { s: Number(season), t: text });
    return (d.eventsSearch || []).map(e => ({ code: e.code, name: e.name, start: e.start }));
  } catch (e) {
    const list = await rest(`/events/search/${season}?limit=30&searchText=${encodeURIComponent(text)}`);
    return (list || []).map(e => ({ code: e.code, name: e.name, start: e.start }));
  }
}

// ---------- Official FIRST FTC Events API ----------

export async function firstApiEvent(settings, code) {
  offlineCheck();
  const { ftcUser, ftcKey, season } = settings;
  if (!ftcUser || !ftcKey) throw new Error('Enter your FTC Events API username and authorization key first.');
  const base = (settings.ftcBase || 'https://ftc-api.firstinspires.org/v2.0').replace(/\/+$/, '');
  code = code.trim().toUpperCase();
  const headers = { Authorization: 'Basic ' + btoa(`${ftcUser}:${ftcKey}`), Accept: 'application/json' };
  const get = async path => {
    let res;
    try {
      res = await fetchT(base + path, { headers });
    } catch (e) {
      throw new Error("The browser blocked the request to FIRST's API. FIRST's servers don't allow direct browser access (CORS). " +
        'Use FTCScout instead, run tools/ftc_event_download.py on a laptop and import the file, or enter a proxy URL.');
    }
    if (res.status === 401) throw new Error('FIRST rejected the username/key (401 Unauthorized).');
    if (!res.ok) throw new Error(`FIRST API returned HTTP ${res.status} for ${path}`);
    return res.json();
  };
  const evs = await get(`/${season}/events?eventCode=${code}`).catch(() => null);
  const evInfo = (evs && evs.events && evs.events[0]) || {};
  const name = evInfo.name || code;
  const type = String(evInfo.typeName || evInfo.type || '');
  const teams = {};
  let page = 1, pages = 1;
  do {
    const t = await get(`/${season}/teams?eventCode=${code}&page=${page}`);
    for (const tm of t.teams || []) teams[tm.teamNumber] = tm.nameShort || tm.nameFull || '';
    pages = t.pageTotal || 1;
    page++;
  } while (page <= pages && page < 20);
  const sched = await get(`/${season}/schedule/${code}?tournamentLevel=qual`).catch(() => ({ schedule: [] }));
  const matches = buildMatches(sched.schedule, m => m.matchNumber, null, m => m.teams,
    t => t.teamNumber, t => t.station, t => t.station);
  for (const m of matches) for (const t of [...m.r, ...m.b]) if (!(t in teams)) teams[t] = '';
  return { code, season: Number(season), name, type, teams, matches, src: 'FIRST API', upd: Date.now() };
}

// ---------- Manual entry & files ----------

export function parseTeams(text) {
  const teams = {};
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^(\d{1,6})\s*[-–:,\t ]\s*(.*[A-Za-z].*)$/);
    if (m) { teams[Number(m[1])] = m[2].trim(); continue; }
    for (const tok of line.split(/[^0-9]+/)) if (tok) teams[Number(tok)] = teams[Number(tok)] || '';
  }
  return teams;
}

export function parseSchedule(text) {
  const matches = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const nums = (raw.match(/\d+/g) || []).map(Number);
    if (nums.length < 3) continue;
    const [n, ...ts] = nums;
    if (ts.length >= 4) matches.push({ n, r: ts.slice(0, 2), b: ts.slice(2, 4) });
    else if (ts.length >= 2) matches.push({ n, r: ts.slice(0, Math.ceil(ts.length / 2)), b: ts.slice(Math.ceil(ts.length / 2)) });
  }
  return matches.sort((a, b) => a.n - b.n);
}

export function scheduleToText(matches) {
  return (matches || []).map(m => [m.n, ...m.r, ...m.b].join(' ')).join('\n');
}

export function teamsToText(teams) {
  return Object.keys(teams || {}).map(Number).sort((a, b) => a - b).map(n => teams[n] ? `${n} ${teams[n]}` : `${n}`).join('\n');
}

export function manualEvent(code, name, season, teamsText, schedText) {
  code = String(code || '').trim().toUpperCase();
  if (!code) throw new Error('Enter an event code (any short name works, e.g. MYQUAL1).');
  const teams = parseTeams(teamsText);
  const matches = parseSchedule(schedText);
  for (const m of matches) for (const t of [...m.r, ...m.b]) if (!(t in teams)) teams[t] = '';
  return { code, season: Number(season), name: String(name || '').trim() || code, teams, matches, src: 'Manual', upd: Date.now() };
}

export function normalizeEvent(obj) {
  if (!obj || !obj.code) throw new Error('That file is not an event file.');
  const teams = {};
  for (const [k, v] of Object.entries(obj.teams || {})) if (Number(k)) teams[Number(k)] = String(v || '');
  const matches = (obj.matches || []).map(m => ({ n: Number(m.n), r: (m.r || []).map(Number), b: (m.b || []).map(Number) })).filter(m => m.n);
  const out = { code: String(obj.code).toUpperCase(), season: Number(obj.season) || 2026, name: obj.name || obj.code, type: String(obj.type || ''), teams, matches, src: obj.src || 'File', upd: obj.upd || Date.now() };
  if (obj.scope === 'league' || obj.scope === 'all') out.scope = obj.scope;
  return out;
}

// ---------- FTCScout per-team official numbers ----------

const num = v => (v === null || v === undefined || v === '' || isNaN(Number(v)) ? null : Number(v));
const pick = (o, k) => (o && typeof o[k] === 'object' && o[k] !== null ? num(o[k].value) : num(o && o[k]));

// Season OPR (points a team adds per match, estimated from official scores) split into AUTO / TELEOP / endgame.
export async function ftcscoutQuickStats(season, teams, onProgress) {
  offlineCheck();
  let done = 0;
  const res = await pool(teams, 6, async t => {
    const q = await rest(`/teams/${t}/quick-stats?season=${season}`);
    if (onProgress) onProgress(++done, teams.length);
    if (!q) return null;
    const tot = pick(q, 'tot');
    if (tot === null) return null;
    return { tot, auto: pick(q, 'auto'), dc: pick(q, 'dc'), eg: pick(q, 'eg'), rank: q.tot && num(q.tot.rank), count: num(q.count) };
  });
  const out = {};
  teams.forEach((t, i) => { if (res[i]) out[t] = res[i]; });
  return out;
}

// Rank and record at each event a team played (FTCScout); used when FIRST data isn't set up.
export async function ftcscoutTeamResults(season, teams) {
  offlineCheck();
  const res = await pool(teams, 6, t => rest(`/teams/${t}/events/${season}`));
  const meets = {};
  teams.forEach((t, i) => {
    for (const p of res[i] || []) {
      const code = p.eventCode || (p.event && p.event.code);
      if (!code) continue;
      const st = p.stats || {};
      const rank = num(st.rank ?? p.rank);
      if (rank === null && st.wins === undefined) continue;
      const m = meets[code] || (meets[code] = { code, name: (p.event && p.event.name) || code, date: (p.event && p.event.start) || '', rankings: [] });
      m.rankings.push({ team: Number(t), rank: rank || 0, rs: num(st.rp ?? st.rankingScore), w: num(st.wins) || 0, l: num(st.losses) || 0, t: num(st.ties) || 0, played: num(st.qualMatchesPlayed ?? st.matchesPlayed) || 0, avg: null });
    }
  });
  return Object.values(meets).sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

// Qualification match times and scores from FTCScout (used when FIRST isn't set up).
export async function ftcscoutLive(season, code) {
  offlineCheck();
  const list = await rest(`/events/${season}/${code}/matches`);
  if (!list) throw new Error('FTCScout has no matches for this event yet.');
  const total = (sc, side) => {
    if (!sc) return null;
    const o = sc[side] ?? sc[side + 'Score'];
    if (o === null || o === undefined) return null;
    if (typeof o === 'number') return o;
    return num(o.totalPoints ?? o.total ?? o.totalPointsNp);
  };
  const out = [];
  for (const m of list) {
    if (m.tournamentLevel && !isQual(m.tournamentLevel)) continue;
    const n = Number(m.matchNum ?? m.matchNumber);
    if (!n) continue;
    const teams = (m.teams || []).slice().sort((a, b) => stationNum(a.station) - stationNum(b.station));
    const red = teams.filter(t => isRed(t.alliance)).map(t => Number(t.teamNumber)).filter(Boolean);
    const blue = teams.filter(t => t.alliance && !isRed(t.alliance)).map(t => Number(t.teamNumber)).filter(Boolean);
    const played = m.hasBeenPlayed !== false;
    const rs = played ? total(m.scores, 'red') : null, bs = played ? total(m.scores, 'blue') : null;
    out.push({ n, time: m.scheduledStartTime || m.startTime || null, actual: m.actualStartTime || null, red, blue, rs, bs });
  }
  return out.sort((a, b) => a.n - b.n);
}
