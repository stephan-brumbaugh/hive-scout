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
 * Tabs it creates: Matches and Pits (readable copies you can sort/filter — they are rebuilt on every
 * change, so don't type in them), and _records / _events (the sync data the iPads use — don't edit).
 */

const TEAM_KEY = 'PUT-YOUR-TEAM-KEY-HERE';

const MAX_PULL = 600; // records returned per request

const REC_HEAD = ['id', 'seq', 'ts', 'type', 'event', 'team', 'match', 'device', 'deleted', 'json'];
const EV_HEAD = ['code', 'seq', 'upd', 'name', 'json'];

const MATCH_COLS = [
  ['ev', 'Event'], ['mt', 'Match'], ['tm', 'Team'], ['al', 'Alliance'], ['sc', 'Scout'], ['ts', 'Saved'],
  ['ns', 'No show'], ['st', 'Start tile'], ['lv', 'AUTO leave'], ['aM', 'AUTO HIVE made'], ['aX', 'AUTO HIVE missed'],
  ['aP', 'AUTO park'], ['aS', 'AUTO sources'], ['tM', 'TELEOP HIVE made'], ['tX', 'TELEOP HIVE missed'],
  ['iS', 'Intake sources'], ['fN', 'NECTAR into FLOWER'], ['fP', 'POLLEN into FLOWER'], ['gd', 'Into GARDEN'],
  ['pk', 'Park'], ['df', 'Defense (0-2)'], ['dr', 'Driver (1-5)'], ['br', 'Issues'], ['mn', 'Minor fouls'],
  ['mj', 'Major fouls'], ['cd', 'Card (0/1/2)'], ['nt', 'Notes'], ['id', 'Record ID'],
];
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
  return json_({ ok: true, app: 'hive-scout-sync', version: 1, message: 'Hive Scout sync is running. Enter this URL in the app.' });
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
  const nothingToWrite = !(req.records || []).length && !(req.deletes || []).length && !(req.events || []).length;
  if (nothingToWrite && since === seq) {
    return { ok: true, pushed: 0, deleted: 0, records: [], events: [], cursor: seq, more: false };
  }

  // --- records
  const rows = readRows_(R, REC_HEAD.length);
  const index = {};
  rows.forEach((row, i) => { index[String(row[0])] = i; });
  let pushed = 0, deleted = 0, readableDirty = false;
  const device = String(req.device || '').slice(0, 20);

  (req.records || []).forEach(r => {
    if (!r || typeof r.id !== 'string' || !r.id || (r.t !== 'm' && r.t !== 'p')) return;
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

  return { ok: true, pushed: pushed, deleted: deleted, records: out, events: events, cursor: cursor, more: more, total: rows.length };
}

function recRow_(r, seq, device) {
  return [r.id, seq, Number(r.ts) || 0, r.t, String(r.ev || ''), Number(r.tm) || '', r.t === 'm' ? (Number(r.mt) || '') : '',
    device, false, JSON.stringify(r)];
}

function rebuildReadable_(ss, rows) {
  const matches = [], pits = [];
  rows.forEach(row => {
    if (isTrue_(row[8]) || !row[9]) return;
    let r;
    try { r = JSON.parse(row[9]); } catch (err) { return; }
    if (r.t === 'm') matches.push(r); else if (r.t === 'p') pits.push(r);
  });
  matches.sort((a, b) => String(a.ev).localeCompare(String(b.ev)) || a.mt - b.mt || a.tm - b.tm);
  pits.sort((a, b) => String(a.ev).localeCompare(String(b.ev)) || a.tm - b.tm);
  writeReadable_(ensureSheet_(ss, 'Matches', MATCH_COLS.map(c => c[1])), MATCH_COLS, matches);
  writeReadable_(ensureSheet_(ss, 'Pits', PIT_COLS.map(c => c[1])), PIT_COLS, pits);
}

function writeReadable_(sheet, cols, recs) {
  const values = recs.map(r => cols.map(([k]) => {
    if (k === 'ts') return r.ts ? new Date(r.ts * 1000) : '';
    const v = r[k];
    if (v === undefined || v === null) return '';
    // keep text as text (stop Sheets turning "=..." into formulas or "1/2" into dates)
    return typeof v === 'string' && /^[=+\-@0-9]/.test(v) ? "'" + v : v;
  }));
  const last = sheet.getLastRow();
  if (last > 1) sheet.getRange(2, 1, last - 1, cols.length).clearContent();
  if (values.length) {
    ensureRows_(sheet, values.length + 1);
    sheet.getRange(2, 1, values.length, cols.length).setValues(values);
  }
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
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
