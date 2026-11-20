/**
 * Hive Scout cloud sync — Google Apps Script for the "Hive Scout Data" Google Sheet.
 *
 * SETUP (once, on a computer):
 *  1. Open the Google Sheet > Extensions > Apps Script. Delete the sample code and paste this whole file.
 *  2. Change TEAM_KEY below to your own password (letters/numbers, no spaces). Click Save.
 *  3. Choose the "setup" function in the toolbar and click Run. Approve the permissions (it only uses this Sheet).
 *  4. Deploy > New deployment > gear icon > Web app.
 *       Execute as: Me      Who has access: Anyone
 *     Click Deploy and copy the Web app URL (ends in /exec).
 *  5. In Hive Scout (Sync tab > Cloud backup) enter that URL and the same TEAM_KEY.
 *
 * UPDATING THIS SCRIPT LATER: paste the new version, Save, Run "setup" once (approve any new permission),
 * then Deploy > Manage deployments > pencil icon > Version: New version > Deploy. The URL stays the same.
 *
 * OFFICIAL FIRST DATA (league rosters and rankings, meet results, match times, and after the league
 * tournaments the region championship and FIRST Championship fields): register for a free FTC Events API
 * key at https://ftc-events.firstinspires.org/services/API, then in Apps Script open Project Settings (gear)
 * > Script properties > Add: FIRST_USER = your API username, FIRST_KEY = your authorization key. Save.
 * No redeploy is needed after adding the key.
 *
 * Tabs it creates: Matches and Pits (readable copies you can sort/filter — they are rebuilt on every
 * change, so don't type in them), and _records / _events (the sync data the iPads use — don't edit).
 */

const TEAM_KEY = 'PUT-YOUR-TEAM-KEY-HERE';

const MAX_PULL = 600; // records returned per request
const API_VERSION = 5;
const FIRST_BASE = 'https://ftc-api.firstinspires.org/v2.0';

const REC_HEAD = ['id', 'seq', 'ts', 'type', 'event', 'team', 'match', 'device', 'deleted', 'json'];
const EV_HEAD = ['code', 'seq', 'upd', 'name', 'json'];

const MATCH_COLS = [
  ['ev', 'Event'], ['mt', 'Match'], ['tm', 'Team'], ['al', 'Alliance'], ['ps', 'Position'], ['sc', 'Scout'], ['ts', 'Saved'],
  ['ns', 'No show'], ['st', 'Start tile'], ['lv', 'AUTO leave'], ['aM', 'AUTO HIVE made'], ['aX', 'AUTO HIVE missed'],
  ['aP', 'AUTO park'], ['aS', 'AUTO sources'], ['tM', 'TELEOP HIVE made'], ['tX', 'TELEOP HIVE missed'],
  ['iS', 'Intake sources'], ['fN', 'NECTAR into FLOWER'], ['fP', 'POLLEN into FLOWER'], ['gd', 'Into GARDEN'],
  ['pk', 'Park'], ['df', 'Defense (0-2)'], ['dr', 'Driver (1-7)'], ['br', 'Issues'], ['mn', 'Minor fouls'],
  ['mj', 'Major fouls'], ['cd', 'Card (0/1/2)'], ['nt', 'Notes'], ['id', 'Record ID'],
];
const SHIFT_COLS = [['ev', 'Event'], ['ps', 'Position'], ['sc', 'Scout'], ['mt', 'From match'], ['ts', 'Signed in'], ['id', 'Record ID']];
const POS_LABELS = { R1: 'Red 1', R2: 'Red 2', B1: 'Blue 1', B2: 'Blue 2' };
const PIT_COLS = [
  ['ev', 'Event'], ['tm', 'Team'], ['sc', 'Scout'], ['ts', 'Saved'], ['dt', 'Drivetrain'], ['ln', 'Launcher'],
  ['hv', 'Launches into HIVE'], ['fl', 'Places in FLOWER'], ['fb', 'Pulls POLLEN from FLOWER'], ['nc', 'Handles NECTAR'],
  ['cap', 'Max carried'], ['cy', 'Claimed TELEOP launches'], ['ast', 'AUTO start tiles'], ['aL', 'Claimed AUTO launches'],
  ['aLv', 'AUTO leave'], ['aPk', 'AUTO park'], ['aS', 'AUTO sources'], ['rl', 'Preferred role'], ['vs', 'Uses AprilTags'],
  ['nt', 'Notes'], ['id', 'Record ID'],
];

// ---------------------------------------------------------------- entry points

function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ensureSheet_(ss, 'Matches', MATCH_COLS.map(c => c[1]));
  ensureSheet_(ss, 'Pits', PIT_COLS.map(c => c[1]));
  ensureSheet_(ss, 'Scout log', SHIFT_COLS.map(c => c[1]));
  ensureSheet_(ss, '_records', REC_HEAD);
  ensureSheet_(ss, '_events', EV_HEAD);
  const first = ss.getSheetByName('Sheet1');
  if (first && first.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(first);
  if (TEAM_KEY === 'PUT-YOUR-TEAM-KEY-HERE') {
    Logger.log('Almost done: change TEAM_KEY at the top of the script to your own password, then Save and Deploy.');
  } else {
    Logger.log('Ready. Now Deploy > New deployment > Web app (Execute as: Me, Who has access: Anyone).');
  }
}

function doGet() {
  return json_({ ok: true, app: 'hive-scout-sync', message: 'Hive Scout sync is running. Enter this URL in the app.' });
}

function doPost(e) {
  let req;
  try {
    req = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ ok: false, error: 'Bad request' });
  }
  if (TEAM_KEY === 'PUT-YOUR-TEAM-KEY-HERE') return json_({ ok: false, error: 'Set TEAM_KEY in the Apps Script first.' });
  if (!req || req.key !== TEAM_KEY) return json_({ ok: false, error: 'Wrong team key' });
  if (req.action === 'league' || req.action === 'matches' || req.action === 'stage') {
    try {
      return json_(req.action === 'league' ? leagueData_(req) : req.action === 'stage' ? stageData_(req) : matchesData_(req));
    } catch (err) {
      return json_({ ok: false, error: String((err && err.message) || err) });
    }
  }
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) return json_({ ok: false, error: 'Sheet is busy, will retry' });
  try {
    return json_(sync_(req));
  } catch (err) {
    return json_({ ok: false, error: String((err && err.message) || err) });
  } finally {
    lock.releaseLock();
  }
}

// ---------------------------------------------------------------- sync

function sync_(req) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const R = ensureSheet_(ss, '_records', REC_HEAD);
  const E = ensureSheet_(ss, '_events', EV_HEAD);
  const props = PropertiesService.getScriptProperties();
  let seq = Number(props.getProperty('seq') || 0);
  const startSeq = seq;
  let since = Number(req.since) || 0;
  if (since > seq) since = 0; // the Sheet was reset: send everything again
  // --- league roster (shared by all iPads; newest wins)
  let league = null;
  try { league = JSON.parse(props.getProperty('league') || 'null'); } catch (err) { league = null; }
  if (req.league && Number(req.league.upd) > Number((league && league.upd) || 0)) {
    league = req.league;
    try {
      props.setProperty('league', JSON.stringify(league));
    } catch (err) { // property too large: keep numbers, drop names
      const slim = Object.assign({}, league, { teams: {} });
      Object.keys(league.teams || {}).forEach(t => { slim.teams[t] = ''; });
      props.setProperty('league', JSON.stringify(slim));
    }
  }
  const leagueOut = league && Number(league.upd) > (Number(req.leagueUpd) || 0) ? league : null;

  const nothingToWrite = !(req.records || []).length && !(req.deletes || []).length && !(req.events || []).length;
  if (nothingToWrite && since === seq) {
    return { ok: true, pushed: 0, deleted: 0, records: [], events: [], cursor: seq, more: false, league: leagueOut };
  }

  // --- records
  const rows = readRows_(R, REC_HEAD.length);
  const index = {};
  rows.forEach((row, i) => { index[String(row[0])] = i; });
  let pushed = 0, deleted = 0, readableDirty = false;
  const device = String(req.device || '').slice(0, 20);

  (req.records || []).forEach(r => {
    if (!r || typeof r.id !== 'string' || !r.id || (r.t !== 'm' && r.t !== 'p' && r.t !== 's')) return;
    const ts = Number(r.ts) || 0;
    const i = index[r.id];
    if (i !== undefined) {
      const ex = rows[i];
      if (isTrue_(ex[8])) return;                 // deleted wins
      if (Number(ex[2]) >= ts) return;            // we already have this version or newer
      rows[i] = recRow_(r, ++seq, device);
    } else {
      index[r.id] = rows.length;
      rows.push(recRow_(r, ++seq, device));
    }
    pushed++; readableDirty = true;
  });

  (req.deletes || []).forEach(d => {
    const id = d && String(d.id || '');
    if (!id) return;
    const i = index[id];
    if (i !== undefined) {
      if (isTrue_(rows[i][8])) return;
      const row = rows[i].slice();
      row[1] = ++seq; row[8] = true; row[9] = '';
      rows[i] = row;
    } else {
      index[id] = rows.length;
      rows.push([id, ++seq, Number(d.ts) || 0, '', '', '', '', device, true, '']);
    }
    deleted++; readableDirty = true;
  });

  if (seq !== startSeq) writeRows_(R, rows, REC_HEAD.length);

  // --- events
  const evRows = readRows_(E, EV_HEAD.length);
  const evIndex = {};
  evRows.forEach((row, i) => { evIndex[String(row[0])] = i; });
  let evChanged = false;
  (req.events || []).forEach(ev => {
    if (!ev || !ev.code) return;
    const code = String(ev.code);
    const upd = Number(ev.upd) || 0;
    const i = evIndex[code];
    const row = [code, 0, upd, String(ev.name || ''), JSON.stringify(ev)];
    if (i !== undefined) {
      if (Number(evRows[i][2]) >= upd) return;
      row[1] = ++seq; evRows[i] = row;
    } else {
      row[1] = ++seq; evIndex[code] = evRows.length; evRows.push(row);
    }
    evChanged = true;
  });
  if (evChanged) writeRows_(E, evRows, EV_HEAD.length);

  if (seq !== startSeq) props.setProperty('seq', String(seq));
  if (readableDirty) rebuildReadable_(ss, rows);

  // --- pull: everything changed since the device's cursor
  const changed = rows.filter(row => Number(row[1]) > since).sort((a, b) => Number(a[1]) - Number(b[1]));
  const page = changed.slice(0, MAX_PULL);
  const more = changed.length > MAX_PULL;
  const out = page.map(row => {
    if (isTrue_(row[8])) return { id: String(row[0]), deleted: true };
    try { return JSON.parse(row[9]); } catch (err) { return null; }
  }).filter(Boolean);
  const events = evRows.filter(row => Number(row[1]) > since).map(row => {
    try { return JSON.parse(row[4]); } catch (err) { return null; }
  }).filter(Boolean);
  const cursor = more ? Number(page[page.length - 1][1]) : seq;

  return { ok: true, pushed: pushed, deleted: deleted, records: out, events: events, cursor: cursor, more: more, total: rows.length, league: leagueOut };
}

function recRow_(r, seq, device) {
  return [r.id, seq, Number(r.ts) || 0, r.t, String(r.ev || ''), Number(r.tm) || '', r.t !== 'p' ? (Number(r.mt) || '') : '',
    device, false, JSON.stringify(r)];
}

function rebuildReadable_(ss, rows) {
  const matches = [], pits = [], shifts = [];
  rows.forEach(row => {
    if (isTrue_(row[8]) || !row[9]) return;
    let r;
    try { r = JSON.parse(row[9]); } catch (err) { return; }
    if (r.t === 'm') matches.push(r); else if (r.t === 'p') pits.push(r); else if (r.t === 's') shifts.push(r);
  });
  shifts.sort((a, b) => String(a.ev).localeCompare(String(b.ev)) || a.ts - b.ts);
  matches.sort((a, b) => String(a.ev).localeCompare(String(b.ev)) || a.mt - b.mt || a.tm - b.tm);
  pits.sort((a, b) => String(a.ev).localeCompare(String(b.ev)) || a.tm - b.tm);
  writeReadable_(ensureSheet_(ss, 'Matches', MATCH_COLS.map(c => c[1])), MATCH_COLS, matches);
  writeReadable_(ensureSheet_(ss, 'Pits', PIT_COLS.map(c => c[1])), PIT_COLS, pits);
  writeReadable_(ensureSheet_(ss, 'Scout log', SHIFT_COLS.map(c => c[1])), SHIFT_COLS, shifts);
}

function writeReadable_(sheet, cols, recs) {
  const values = recs.map(r => cols.map(([k]) => {
    if (k === 'ts') return r.ts ? new Date(r.ts * 1000) : '';
    if (k === 'ps') return POS_LABELS[r.ps] || r.ps || '';
    const v = r[k];
    if (v === undefined || v === null) return '';
    // keep text as text (stop Sheets turning "=..." into formulas or "1/2" into dates)
    return typeof v === 'string' && /^[=+\-@0-9]/.test(v) ? "'" + v : v;
  }));
  // Tabs made by older versions may have fewer columns or old titles: grow them and rewrite the header row.
  const have = sheet.getMaxColumns();
  if (cols.length > have) sheet.insertColumnsAfter(have, cols.length - have);
  sheet.getRange(1, 1, 1, cols.length).setValues([cols.map(c => c[1])]);
  const last = sheet.getLastRow();
  if (last > 1) sheet.getRange(2, 1, last - 1, cols.length).clearContent();
  if (values.length) {
    ensureRows_(sheet, values.length + 1);
    sheet.getRange(2, 1, values.length, cols.length).setValues(values);
  }
}

// ---------------------------------------------------------------- official FIRST data (league, rankings, meets)

function firstCreds_() {
  const p = PropertiesService.getScriptProperties();
  return { user: String(p.getProperty('FIRST_USER') || '').trim(), key: String(p.getProperty('FIRST_KEY') || '').trim() };
}

// GET from FIRST's FTC Events API, cached so repeated taps don't hammer FIRST.
function firstGet_(path, ttlSeconds) {
  const cache = CacheService.getScriptCache();
  const ck = ('first:' + path).slice(0, 240);
  const hit = ttlSeconds ? cache.get(ck) : null;
  if (hit) return JSON.parse(hit);
  const c = firstCreds_();
  const res = UrlFetchApp.fetch(FIRST_BASE + path, {
    headers: { Authorization: 'Basic ' + Utilities.base64Encode(c.user + ':' + c.key), Accept: 'application/json' },
    muteHttpExceptions: true,
  });
  const code = res.getResponseCode();
  if (code === 401) throw new Error('FIRST rejected the API username/key. Check FIRST_USER and FIRST_KEY in Project Settings > Script properties.');
  if (code === 404 || code === 204) return null;
  if (code >= 300) throw new Error('FIRST API error ' + code + ' for ' + path);
  const text = res.getContentText();
  if (ttlSeconds && text.length < 95000) {
    try { cache.put(ck, text, ttlSeconds); } catch (err) { /* too big to cache */ }
  }
  return text ? JSON.parse(text) : null;
}

function leagueData_(req) {
  const creds = firstCreds_();
  if (!creds.user || !creds.key) {
    return { ok: false, error: 'nokey', message: 'Add FIRST_USER and FIRST_KEY in Apps Script > Project Settings > Script properties.' };
  }
  const season = Number(req.season) || 2026;
  const team = Number(req.team) || 0;
  let region = String(req.region || '').trim();
  const wanted = String(req.league || '').trim();
  const out = { ok: true, kind: 'league', season: season, fetched: Date.now() };

  if (!region) {
    if (!team) return { ok: false, error: 'Enter your team number in the app first.' };
    const t = firstGet_('/' + season + '/teams?teamNumber=' + team, 21600);
    const info = t && t.teams && t.teams[0];
    if (!info) return { ok: false, error: 'FIRST has no ' + season + ' record for team ' + team + '.' };
    region = String(info.homeRegion || '');
    if (!region) return { ok: false, error: 'FIRST does not list a home region for team ' + team + '.' };
  }

  const ls = firstGet_('/' + season + '/leagues?regionCode=' + encodeURIComponent(region), 21600);
  const leagues = ((ls && ls.leagues) || []).map(l => ({
    code: String(l.code || l.leagueCode || ''), name: String(l.name || l.code || ''), parent: String(l.parentLeagueCode || ''),
  })).filter(l => l.code);
  out.leagues = leagues;
  const names = {};
  const members = lc => leagueMembers_(season, region, lc, names);
  let mine = null;
  if (wanted) {
    mine = leagues.filter(l => l.code === wanted)[0] || { code: wanted, name: wanted, parent: '' };
  } else {
    const parents = {};
    leagues.forEach(l => { if (l.parent) parents[l.parent] = true; });
    const ordered = leagues.slice().sort((a, b) => (parents[a.code] ? 1 : 0) - (parents[b.code] ? 1 : 0)); // most specific first
    for (let i = 0; i < ordered.length && !mine; i++) if (members(ordered[i].code).indexOf(team) >= 0) mine = ordered[i];
  }
  if (!mine) {
    out.ok = false;
    out.error = 'Could not tell which ' + region + ' league team ' + team + ' is in.';
    out.region = region;
    return out;
  }
  const mem = members(mine.code);
  const memNames = {};
  mem.forEach(n => { if (names[n]) memNames[n] = names[n]; });
  out.league = { region: region, code: mine.code, name: mine.name, members: mem, names: memNames };

  const today = new Date().toISOString().slice(0, 10);
  let live = false;
  out.meets = leagueEvents_(season, region, mine.code, team)
    .filter(e => String(e.dateStart || '').slice(0, 10) <= today)
    .map(e => {
      const finished = String(e.dateEnd || e.dateStart || '').slice(0, 10) < today;
      if (!finished) live = true;
      const r = firstGet_('/' + season + '/rankings/' + encodeURIComponent(e.code), finished ? 21600 : 240);
      return { code: e.code, name: e.name, date: String(e.dateStart || '').slice(0, 10), type: e.typeName, rankings: ((r && r.rankings) || []).map(slimRank_) };
    });
  // League standings change after every match on a meet day, so they are only cached briefly then.
  const rk = firstGet_('/' + season + '/leagues/rankings/' + encodeURIComponent(region) + '/' + encodeURIComponent(mine.code), live ? 240 : 900);
  out.rankings = ((rk && rk.rankings) || []).map(slimRank_);
  out.live = live;
  return out;
}

// League meets + league tournament for this league, plus any league-type event our team attended (cross-league meets).
function leagueEvents_(season, region, code, team) {
  const cache = CacheService.getScriptCache();
  const ck = ('levents:' + season + ':' + region + ':' + code + ':' + team).slice(0, 240);
  const hit = cache.get(ck);
  if (hit) return JSON.parse(hit);
  const slim = e => ({ code: String(e.code), name: String(e.name || e.code), dateStart: e.dateStart, dateEnd: e.dateEnd, typeName: String(e.typeName || e.type || '') });
  const byCode = {};
  const all = firstGet_('/' + season + '/events', 0);
  ((all && all.events) || []).forEach(e => {
    const lc = String(e.leagueCode || '');
    const rc = String(e.regionCode || '');
    if ((lc === code || lc === region + '/' + code) && (!rc || rc === region)) byCode[e.code] = slim(e);
  });
  if (team) {
    const mineEv = firstGet_('/' + season + '/events?teamNumber=' + team, 3600);
    ((mineEv && mineEv.events) || []).forEach(e => { if (/league/i.test(String(e.typeName || e.type || ''))) byCode[e.code] = slim(e); });
  }
  const list = Object.keys(byCode).map(k => byCode[k]).sort((a, b) => String(a.dateStart).localeCompare(String(b.dateStart)));
  try { cache.put(ck, JSON.stringify(list), 21600); } catch (err) { /* ignore */ }
  return list;
}

function leagueMembers_(season, region, lc, names) {
  const m = firstGet_('/' + season + '/leagues/members/' + encodeURIComponent(region) + '/' + encodeURIComponent(lc), 21600);
  return (((m && (m.members || m.teams)) || [])).map(x => {
    if (x && typeof x === 'object') {
      const n = Number(x.teamNumber);
      if (n && names && (x.nameShort || x.nameFull)) names[n] = String(x.nameShort || x.nameFull);
      return n;
    }
    return Number(x);
  }).filter(Boolean);
}

function homeRegion_(season, team) {
  const t = firstGet_('/' + season + '/teams?teamNumber=' + team, 21600);
  const info = t && t.teams && t.teams[0];
  return info ? String(info.homeRegion || '') : '';
}

// ---------------------------------------------------------------- season stages: region championship, then worlds

// After the league tournaments, the League tab follows the teams that advanced: first to the region
// championship, then to the FIRST Championship. FIRST's team list for each event is the advancement list.
function stageData_(req) {
  const creds = firstCreds_();
  if (!creds.user || !creds.key) {
    return { ok: false, error: 'nokey', message: 'Add FIRST_USER and FIRST_KEY in Apps Script > Project Settings > Script properties.' };
  }
  const season = Number(req.season) || 2026;
  const team = Number(req.team) || 0;
  let region = String(req.region || '').trim();
  if (!region) {
    if (!team) return { ok: false, error: 'Enter your team number in the app first.' };
    region = homeRegion_(season, team);
    if (!region) return { ok: false, error: 'FIRST does not list a home region for team ' + team + '.' };
  }
  const today = new Date().toISOString().slice(0, 10);
  const cal = stageEvents_(season, region);
  const detail = e => {
    const started = !!e.start && e.start <= today;
    const over = !!(e.end || e.start) && (e.end || e.start) < today;
    const out = { code: e.code, name: e.name, start: e.start, end: e.end, div: e.div, league: e.league };
    out.teams = eventTeams_(season, e.code, over ? 21600 : 1800);
    out.rankings = [];
    if (started) {
      const r = firstGet_('/' + season + '/rankings/' + encodeURIComponent(e.code), over ? 21600 : 240);
      out.rankings = ((r && r.rankings) || []).map(slimRank_);
    }
    return out;
  };
  const out = { ok: true, kind: 'stage', season: season, region: region, fetched: Date.now(), lt: cal.lt };
  out.champs = cal.champs.map(detail);
  out.worlds = cal.worlds.map(detail);
  // Which league each region-championship team plays in, so the app can show where they came from.
  const want = {};
  out.champs.forEach(c => c.teams.forEach(t => { want[t.n] = true; }));
  out.leagueOf = Object.keys(want).length ? leagueOf_(season, region, want) : {};
  return out;
}

// League tournaments and championships for this region, plus every FIRST Championship event (and its divisions).
function stageEvents_(season, region) {
  const cache = CacheService.getScriptCache();
  const ck = ('stage:' + season + ':' + region).slice(0, 240);
  const hit = cache.get(ck);
  if (hit) return JSON.parse(hit);
  const out = { lt: [], champs: [], worlds: [] };
  const all = firstGet_('/' + season + '/events', 0);
  ((all && all.events) || []).forEach(e => {
    const kind = String(e.typeName || '') + ' ' + String(e.type || '');
    const rc = String(e.regionCode || '');
    const slim = {
      code: String(e.code), name: String(e.name || e.code),
      start: String(e.dateStart || '').slice(0, 10), end: String(e.dateEnd || e.dateStart || '').slice(0, 10),
      league: String(e.leagueCode || '').split('/').pop(), div: String(e.divisionCode || ''),
    };
    if (/first\s*championship/i.test(kind)) out.worlds.push(slim);
    else if (rc && rc !== region) return;
    else if (/league\s*tournament/i.test(kind)) out.lt.push(slim);
    else if (/championship/i.test(kind)) out.champs.push(slim);
  });
  ['lt', 'champs', 'worlds'].forEach(k => out[k].sort((a, b) => String(a.start).localeCompare(String(b.start)) || a.code.localeCompare(b.code)));
  try { cache.put(ck, JSON.stringify(out), 21600); } catch (err) { /* ignore */ }
  return out;
}

// Every team registered for an event (FIRST pages long lists).
function eventTeams_(season, code, ttl) {
  const out = [];
  let page = 1, pages = 1;
  do {
    const j = firstGet_('/' + season + '/teams?eventCode=' + encodeURIComponent(code) + (page > 1 ? '&page=' + page : ''), ttl);
    if (!j) break;
    (j.teams || []).forEach(t => {
      const n = Number(t.teamNumber);
      if (n) out.push({ n: n, name: String(t.nameShort || t.nameFull || ''), home: String(t.homeRegion || '') });
    });
    pages = Number(j.pageTotal) || 1;
    page++;
  } while (page <= pages && page <= 20);
  return out;
}

function leagueOf_(season, region, want) {
  const ls = firstGet_('/' + season + '/leagues?regionCode=' + encodeURIComponent(region), 21600);
  const leagues = ((ls && ls.leagues) || []).map(l => ({ code: String(l.code || l.leagueCode || ''), parent: String(l.parentLeagueCode || '') })).filter(l => l.code);
  const parents = {};
  leagues.forEach(l => { if (l.parent) parents[l.parent] = true; });
  const out = {};
  leagues.filter(l => !parents[l.code]).forEach(l => {
    leagueMembers_(season, region, l.code).forEach(n => { if (want[n] && !out[n]) out[n] = l.code; });
  });
  return out;
}

// Qualification schedule (times) and results for one event, refreshed at most once a minute.
function matchesData_(req) {
  const creds = firstCreds_();
  if (!creds.user || !creds.key) {
    return { ok: false, error: 'nokey', message: 'Add FIRST_USER and FIRST_KEY in Apps Script > Project Settings > Script properties.' };
  }
  const season = Number(req.season) || 2026;
  const code = String(req.event || '').trim().toUpperCase();
  if (!code) return { ok: false, error: 'No event code.' };
  const sch = firstGet_('/' + season + '/schedule/' + encodeURIComponent(code) + '?tournamentLevel=qual', 60);
  const res = firstGet_('/' + season + '/matches/' + encodeURIComponent(code) + '?tournamentLevel=qual', 60);
  const byN = {};
  ((sch && sch.schedule) || []).forEach(m => {
    const n = Number(m.matchNumber);
    if (n) byN[n] = { n: n, time: m.startTime || null, red: sideTeams_(m.teams, 'red'), blue: sideTeams_(m.teams, 'blue') };
  });
  ((res && res.matches) || []).forEach(m => {
    const n = Number(m.matchNumber);
    if (!n) return;
    const x = byN[n] || (byN[n] = { n: n, time: null, red: sideTeams_(m.teams, 'red'), blue: sideTeams_(m.teams, 'blue') });
    x.actual = m.actualStartTime || null;
    if (m.scoreRedFinal !== null && m.scoreRedFinal !== undefined && m.scoreBlueFinal !== null && m.scoreBlueFinal !== undefined) {
      x.rs = Number(m.scoreRedFinal);
      x.bs = Number(m.scoreBlueFinal);
    }
  });
  const matches = Object.keys(byN).map(k => byN[k]).sort((a, b) => a.n - b.n);
  return { ok: true, kind: 'matches', event: code, fetched: Date.now(), matches: matches };
}

function sideTeams_(teams, color) {
  return (teams || [])
    .filter(t => String(t.station || '').toLowerCase().indexOf(color) === 0)
    .sort((a, b) => String(a.station).localeCompare(String(b.station)))
    .map(t => Number(t.teamNumber)).filter(Boolean);
}

function slimRank_(r) {
  return {
    rank: Number(r.rank) || 0, team: Number(r.teamNumber) || 0,
    rs: r.sortOrder1 === undefined || r.sortOrder1 === null ? null : Number(r.sortOrder1),
    w: Number(r.wins) || 0, l: Number(r.losses) || 0, t: Number(r.ties) || 0,
    played: Number(r.matchesPlayed) || 0, avg: r.qualAverage === undefined || r.qualAverage === null ? null : Number(r.qualAverage),
  };
}

// ---------------------------------------------------------------- helpers

function ensureSheet_(ss, name, header) {
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    const cols = sh.getMaxColumns();
    if (header.length > cols) sh.insertColumnsAfter(cols, header.length - cols); // new tabs only have 26 columns
    sh.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold');
    sh.setFrozenRows(1);
    if (name.charAt(0) === '_') {
      sh.getRange(1, 1, sh.getMaxRows(), header.length).setNumberFormat('@'); // store everything as plain text
      sh.hideSheet();
    }
  }
  return sh;
}

function readRows_(sheet, width) {
  const last = sheet.getLastRow();
  if (last < 2) return [];
  return sheet.getRange(2, 1, last - 1, width).getValues();
}

function writeRows_(sheet, rows, width) {
  if (!rows.length) return;
  ensureRows_(sheet, rows.length + 1);
  sheet.getRange(2, 1, rows.length, width).setValues(rows);
}

function ensureRows_(sheet, needed) {
  const max = sheet.getMaxRows();
  if (needed <= max) return;
  const add = needed - max + 200;
  sheet.insertRowsAfter(max, add);
  if (sheet.getName().charAt(0) === '_') sheet.getRange(max + 1, 1, add, sheet.getMaxColumns()).setNumberFormat('@');
}

function isTrue_(v) {
  return v === true || v === 'TRUE' || v === 'true' || v === 1;
}

function json_(obj) {
  obj.version = API_VERSION;
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
