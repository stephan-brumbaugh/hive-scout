import { hasLeague, inLeague, eventScope, inScope, saveLeague } from './store.js';
import { official, refreshOfficial, startOfficial, oprFor, rankFor, meetsFor, liveFor, refreshLive,
  refreshView, stageInfo, leagueView, leagueChoices, lview, setLview, viewLive, viewUpdated, viewSource,
  seasonMeetsFor, stageRanksFor, ourLeagueCode, divLabel, isOn, isOver, officialName } from './official.js';
import { state, persist, newId, upsertRecord, deleteRecord, isMine, unsentRecords, markSent, activeEvent,
  eventRecords, saveEvent, getPick, setPick, backupObject, mergeBackup, clearAll, storageWorks } from './store.js';
import { blankMatch, blankPit, toArr, fromArr, toCSV, LABELS, POSITIONS, posLabel } from './schema.js';
import { ftcscoutEvent, ftcscoutTeamEvents, ftcscoutSearch, firstApiEvent, manualEvent, normalizeEvent,
  teamsToText, scheduleToText, parseTeams } from './api.js';
import { encodeMessage, Assembler, drawQR, Scanner } from './qr.js';
import { observations, teamStats, eventContext, compatibility, tileXY, eventOrder, recencyWeights } from './analysis.js';
import { cloud, cloudConfigured, cloudActive, cloudPending, syncNow, syncSoon, startCloud, resetCloudProgress } from './cloud.js';

export const APP_VERSION = '1.5.0'; // keep in step with VERSION in sw.js
const S = () => state.settings;
const $ = (sel, root = document) => root.querySelector(sel);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const f1 = x => (x == null || isNaN(x) ? '–' : (Math.round(x * 10) / 10).toString());
const pct = x => (x == null || isNaN(x) ? '–' : Math.round(x * 100) + '%');
const now = () => Math.floor(Date.now() / 1000);

const ui = {
  tab: 'event',
  scoutMode: 'match',
  mf: null,
  pf: null,
  evSrc: 'ftcscout',
  found: [],
  busy: '',
  editEvent: false,
  sort: { k: 'est', d: -1 },
  lsort: { k: 'est', d: -1 },
  lfilter: '',
  leagueEdit: false,
  filter: '',
  hideDnp: false,
  qr: null,
  scanner: null,
  assembler: null,
  scanLog: [],
  facing: 'environment',
};

// ---------------------------------------------------------------- utilities

let toastTimer;
function toast(msg, kind = '') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast ' + kind;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), kind === 'err' ? 6000 : 2600);
}

function openModal(html, cls = '') {
  const m = $('#modal');
  m.className = 'modal ' + cls;
  m.innerHTML = `<div class="sheet">${html}</div>`;
  m.scrollTop = 0;
}
function closeModal() {
  const m = $('#modal');
  m.className = 'modal hidden';
  m.innerHTML = '';
  stopQR();
}

function friendlyError(e) {
  const msg = (e && e.message) || String(e);
  if (/Failed to fetch|Load failed|NetworkError|network connection/i.test(msg)) {
    return 'Could not reach the server. Check the internet connection (or the site may be blocking browser requests).';
  }
  return msg;
}

async function download(filename, text, mime) {
  const blob = new Blob([text], { type: mime });
  try {
    const file = new File([blob], filename, { type: mime });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: filename });
      return;
    }
  } catch (e) {
    if (e && e.name === 'AbortError') return;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 3000);
}

function teamName(t, ev = activeEvent()) {
  return (ev && ev.teams && ev.teams[t]) || '';
}

function beep() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    ui.audio = ui.audio || new Ctx();
    const o = ui.audio.createOscillator(), g = ui.audio.createGain();
    o.frequency.value = 880; g.gain.value = 0.08;
    o.connect(g); g.connect(ui.audio.destination);
    o.start(); o.stop(ui.audio.currentTime + 0.12);
  } catch (e) { /* ignore */ }
}

// ---------------------------------------------------------------- data helpers

function latestPits(records) {
  const out = {};
  for (const r of records) if (r.t === 'p' && (!out[r.tm] || r.ts > out[r.tm].ts)) out[r.tm] = r;
  return out;
}

// Teams at the active event, limited to our league at league meets / league tournaments.
function computeEvent() {
  const ev = activeEvent();
  const recs = ev ? eventRecords(ev.code) : [];
  const obs = observations(recs);
  const pits = latestPits(recs);
  const nums = [...new Set([...Object.keys((ev && ev.teams) || {}).map(Number), ...recs.map(r => r.tm)])].filter(Boolean);
  const shown = nums.filter(t => inScope(t, ev));
  const stats = shown.map(t => teamStats(t, obs, pits[t], S()));
  return { ev, recs, obs, pits, stats, hidden: nums.length - shown.length };
}

// Everything scouted this season, across every meet.
function computeSeason() {
  const season = Number(S().season) || 2026;
  const recs = Object.values(state.records).filter(r => { const e = state.events[r.ev]; return !e || !e.season || e.season === season; });
  const order = eventOrder(recs);
  return { recs, order, evW: recencyWeights(order), obs: observations(recs), pits: latestPits(recs) };
}

function seasonStats(team, sd, weighted) {
  return teamStats(Number(team), sd.obs, sd.pits[team], S(), { order: sd.order, evW: weighted ? sd.evW : null });
}

function ourStats(sd = computeSeason()) {
  const our = Number(S().ourTeam);
  if (!our) return null;
  return seasonStats(our, sd, true);
}

function eventName(code) {
  const e = state.events[code];
  if (e) return e.name || code;
  const m = (state.official.meets || []).find(x => x.code === code);
  return (m && m.name) || code;
}

function scheduleFor(mt) {
  const ev = activeEvent();
  return ev && ev.matches ? ev.matches.find(m => m.n === Number(mt)) : null;
}

function applySlot(mf) {
  const slot = S().slot;
  const m = scheduleFor(mf.mt);
  if (!slot || !m) return;
  const list = slot[0] === 'R' ? m.r : m.b;
  const t = list[Number(slot[1]) - 1];
  delete mf.skip;
  if (!t) return;
  mf.al = slot[0];
  if (inScope(t, activeEvent())) mf.tm = t;
  else { mf.tm = 0; mf.skip = t; } // another league's robot: nothing to scout this match
}

function newMatchForm(mt) {
  const mf = blankMatch();
  mf.ev = S().activeEvent;
  mf.mt = mt || 1;
  applySlot(mf);
  return mf;
}

function nextMatchNumber() {
  const mine = eventRecords().filter(r => r.t === 'm' && isMine(r));
  return mine.length ? Math.max(...mine.map(r => r.mt)) + 1 : 1;
}

// ---------------------------------------------------------------- header

function renderHeader() {
  const ev = activeEvent();
  $('#hdrEvent').textContent = ev ? `${ev.code}${S().ourTeam ? ' · ' + S().ourTeam : ''}` : 'Set up event';
  const n = unsentRecords().length;
  const u = $('#hdrUnsent');
  u.textContent = `${n} unsent`;
  u.classList.toggle('hidden', n === 0);
  const net = $('#hdrNet');
  net.className = 'net ' + (navigator.onLine ? 'on' : 'off');
  net.textContent = navigator.onLine ? 'Online' : 'Offline';
  const c = $('#hdrCloud');
  if (c) {
    const st = cloudStatus();
    c.classList.toggle('hidden', !cloudConfigured());
    c.className = 'pill cloud ' + st.cls + (cloudConfigured() ? '' : ' hidden');
    c.textContent = '☁ ' + st.short;
  }
  const box = $('#cloudStatus');
  if (box) box.innerHTML = cloudStatusHTML();
  document.querySelectorAll('.tabbar button').forEach(b => b.classList.toggle('active', b.dataset.tab === ui.tab));
}

function ago(t) {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return Math.round(s / 60) + ' min ago';
  return new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function cloudStatus() {
  const p = cloudPending();
  if (!cloudConfigured()) return { cls: 'off', short: 'Off', text: 'Not set up' };
  if (S().cloudOn === false) return { cls: 'off', short: 'Paused', text: `Paused · ${p} waiting to upload` };
  if (cloud.busy) return { cls: 'busy', short: 'Syncing', text: 'Syncing…' };
  if (navigator.onLine === false) return { cls: 'off', short: p ? `${p} waiting` : 'Offline', text: `Offline · ${p} waiting to upload when back online` };
  if (cloud.lastErr) return { cls: 'err', short: 'Problem', text: 'Last sync failed: ' + cloud.lastErr };
  if (p) return { cls: 'warn', short: `${p} waiting`, text: `${p} records waiting to upload` };
  if (cloud.lastOk) return { cls: 'ok', short: 'Synced', text: `All synced · ${ago(cloud.lastOk)}` };
  return { cls: 'warn', short: 'Waiting', text: 'Waiting for first sync…' };
}

function cloudStatusHTML() {
  const st = cloudStatus();
  return `<span class="pill ${st.cls}">${esc(st.short)}</span> ${esc(st.text)}${cloud.lastPulled ? ` <span class="muted small">· last download brought in ${cloud.lastPulled} change${cloud.lastPulled === 1 ? '' : 's'}</span>` : ''}`;
}

function cloudCfgForQR() {
  return cloudConfigured() ? { u: S().cloudUrl.trim(), k: S().cloudKey.trim() } : null;
}

function applyCloudConfig(c) {
  if (!c || !c.u || !c.k) return false;
  const same = S().cloudUrl.trim() === c.u && S().cloudKey.trim() === c.k;
  if (same) return false;
  if (cloudConfigured() && S().cloudUrl.trim() !== c.u &&
    !confirm('Switch this iPad\'s cloud backup to the Google Sheet used by the other iPad?')) return false;
  const urlChanged = S().cloudUrl.trim() !== c.u;
  state.settings.cloudUrl = c.u;
  state.settings.cloudKey = c.k;
  state.settings.cloudOn = true;
  persist('settings');
  if (urlChanged) resetCloudProgress();
  syncSoon(500);
  return true;
}

// Re-render after a field loses focus, but late enough that the tap which caused the blur
// still lands on the button the person actually tapped.
function renderSoon() {
  clearTimeout(ui.renderTimer);
  ui.renderTimer = setTimeout(render, 350);
}

function refreshCloudButtons() {
  const ok = cloudConfigured();
  document.querySelectorAll('[data-act="cloudSync"],[data-act="cloudToggle"],[data-act="shareCloud"]').forEach(b => { b.disabled = !ok; });
  renderHeader();
}

function render() {
  clearTimeout(ui.renderTimer);
  if (ui.scanner && ui.scanner.running) stopScanner();
  const fn = { event: viewEvent, scout: viewScout, sync: viewSync, teams: viewTeams, schedule: viewSchedule, league: viewLeague, partners: viewPartners }[ui.tab];
  const y = window.scrollY;
  $('#view').innerHTML = fn();
  window.scrollTo(0, y);
  renderHeader();
  if (ui.tab === 'sync') renderScanLog();
}

function go(tab) {
  if (ui.tab === 'sync' && tab !== 'sync') stopScanner();
  ui.tab = tab;
  if (tab === 'schedule') refreshLive(activeEvent());
  if (tab === 'league') refreshView();
  window.scrollTo(0, 0);
  render();
}

// ---------------------------------------------------------------- EVENT view

function viewEvent() {
  const s = S();
  const ev = activeEvent();
  const codes = Object.keys(state.events).sort();
  const recCount = Object.keys(state.records).length;
  return `
  ${!storageWorks() ? '<div class="banner err">This browser is blocking storage (Private Browsing?). Data will not be saved.</div>' : ''}
  <section class="card">
    <h2>This iPad</h2>
    <span class="flabel">Position this iPad scouts</span>
    ${positionPicker()}
    <div class="grid2">
      <label>Scout's name (who has this iPad now)<input data-set="scoutName" value="${esc(s.scoutName)}" placeholder="First and last name" autocomplete="off"></label>
      <label>Our team number<input data-set="ourTeam" data-type="int" value="${esc(s.ourTeam)}" inputmode="numeric" placeholder="e.g. 12345"></label>
    </div>
    <p class="muted small">Device ID <b>${esc(s.deviceId)}</b> · ${recCount} records stored on this iPad · App version <b>${APP_VERSION}</b></p>
  </section>

  <section class="card">
    <h2>Event</h2>
    ${codes.length ? `
    <label>Active event
      <select data-change="pickEvent">
        ${codes.map(c => `<option value="${esc(c)}" ${c === s.activeEvent ? 'selected' : ''}>${esc(c)} — ${esc(state.events[c].name)}</option>`).join('')}
      </select>
    </label>` : '<p class="muted">No event loaded yet. Download one below, enter it by hand, or receive it from another iPad by QR (Sync tab).</p>'}
    ${ev ? `
      <div class="evsum">
        <div><b>${esc(ev.name)}</b><span class="muted small"> · ${esc(ev.code)} · season ${ev.season} · from ${esc(ev.src)} ${ev.upd ? '· ' + new Date(ev.upd).toLocaleString() : ''}</span></div>
        <div class="stats"><span><b>${Object.keys(ev.teams).length}</b> teams</span><span><b>${ev.matches.length}</b> qualification matches</span>${ev.type ? `<span>${esc(ev.type)}</span>` : ''}</div>
        ${scopeControl(ev)}
        <div class="btnrow">
          <button data-act="editEvent">Edit teams &amp; schedule</button>
          <button data-act="sendEvent">Share event by QR</button>
          ${ev.src === 'FTCScout' ? `<button data-act="refreshEvent">Refresh from FTCScout</button>` : ''}
          <button class="ghost danger" data-act="deleteEvent">Remove event</button>
        </div>
      </div>` : ''}
  </section>

  <section class="card">
    <h2>${ui.editEvent && ev ? 'Edit ' + esc(ev.code) : 'Load an event'}</h2>
    ${ui.editEvent && ev ? manualPanel(ev) : `
    <div class="seg">
      ${[['ftcscout', 'FTCScout'], ['first', 'FIRST API'], ['manual', 'Manual'], ['file', 'File']].map(([k, l]) =>
        `<button data-act="evSrc" data-v="${k}" class="${ui.evSrc === k ? 'on' : ''}">${l}</button>`).join('')}
    </div>
    ${ui.evSrc === 'ftcscout' ? scoutPanel() : ui.evSrc === 'first' ? firstPanel() : ui.evSrc === 'manual' ? manualPanel(null) : filePanel()}`}
  </section>

  ${ev ? `<section class="card">
    ${(() => {
      const all = Object.keys(ev.teams).map(Number).sort((a, b) => a - b);
      const shown = all.filter(t => inScope(t, ev));
      return `<h2>Teams at ${esc(ev.code)} (${shown.length})</h2>
      ${shown.length < all.length ? `<p class="muted small">${all.length - shown.length} teams from other leagues are hidden at this event.</p>` : ''}
      <div class="chips">${shown.map(t =>
        `<button class="chip ${t === Number(s.ourTeam) ? 'ours' : ''}" data-act="team" data-team="${t}"><b>${t}</b> ${esc(ev.teams[t])}</button>`).join('')}</div>`;
    })()}
  </section>` : ''}

  ${leagueCard(ev)}

  <section class="card">
    <h2>Game &amp; scoring settings</h2>
    <p class="muted small">These drive the ranking-point projections. Defaults match the BIOBUZZ manual for regular events; change them if your event announces different thresholds.</p>
    <div class="grid4">
      <label>Season<input data-set="season" data-type="int" value="${s.season}" inputmode="numeric"></label>
      <label>SWARM RP (pts)<input data-set="swarmT" data-type="int" value="${s.swarmT}" inputmode="numeric"></label>
      <label>POLLINATOR 1 (tips)<input data-set="pol1" data-type="int" value="${s.pol1}" inputmode="numeric"></label>
      <label>POLLINATOR 2 (tips)<input data-set="pol2" data-type="int" value="${s.pol2}" inputmode="numeric"></label>
      <label>Launches for 1st tip<input data-set="firstTip" data-type="int" value="${s.firstTip}" inputmode="numeric"></label>
      <label>Launches per later tip<input data-set="perTip" data-type="int" value="${s.perTip}" inputmode="numeric"></label>
      <label>Field symmetry
        <select data-set="symmetry">
          <option value="mirror" ${s.symmetry === 'mirror' ? 'selected' : ''}>Mirror</option>
          <option value="rotate" ${s.symmetry === 'rotate' ? 'selected' : ''}>Rotated 180°</option>
        </select></label>
      <label>QR speed (ms)<input data-set="qrSpeed" data-type="int" value="${s.qrSpeed}" inputmode="numeric"></label>
    </div>
    <p class="muted small">Field symmetry tells the app how a blue starting tile lines up with a red one when it compares AUTO paths. Check Figure 9-2 in the manual and pick the one that matches.</p>
  </section>`;
}

function positionPicker() {
  const cur = S().slot || '';
  return `<div class="seg pospick">${POSITIONS.map(([p, l]) =>
    `<button data-act="setPosition" data-v="${p}" class="${p[0] === 'R' ? 'red' : 'blue'} ${cur === p ? 'on' : ''}">${l}</button>`).join('')}
    <button data-act="setPosition" data-v="" class="${!cur ? 'on' : ''}">Pit / any</button></div>`;
}

function scoutBar() {
  const p = S().slot;
  return `<div class="scoutbar ${p ? (p[0] === 'R' ? 'isred' : 'isblue') : ''}">
    <span class="pos">${p ? esc(posLabel(p)) : 'Any position'}</span>
    <span class="who">Scout: <b>${esc(S().scoutName)}</b></span>
    <button data-act="newScout">New scout</button>
  </div>`;
}

// Station of a team in a scheduled match: 'R1'…'B2', or ''.
function stationOf(mt, tm) {
  const m = scheduleFor(mt);
  if (!m) return '';
  const r = m.r.indexOf(Number(tm)), b = m.b.indexOf(Number(tm));
  return r >= 0 ? 'R' + (r + 1) : b >= 0 ? 'B' + (b + 1) : '';
}

// Record who is holding this iPad and which position, from which match on.
function logShift() {
  const ev = S().activeEvent;
  if (!ev || !S().scoutName) return;
  const mine = eventRecords(ev, 's').filter(isMine).sort((a, b) => a.ts - b.ts);
  const last = mine[mine.length - 1];
  const ps = S().slot || '';
  const sc = S().scoutName.trim();
  if (last && last.ps === ps && last.sc === sc) return;
  const mt = ui.mf && ui.mf.ev === ev && !ui.mf.id ? Number(ui.mf.mt) || 1 : nextMatchNumber();
  const rec = { t: 's', id: newId(), ev, ps, sc, mt, ts: now() };
  state.records[rec.id] = rec;
  persist('records');
  syncSoon();
}

function scopeControl(ev) {
  if (!hasLeague()) return '';
  const scope = eventScope(ev);
  const all = Object.keys(ev.teams || {}).length;
  const hidden = Object.keys(ev.teams || {}).filter(t => !inScope(t, ev)).length;
  const why = ev.scope ? 'set by hand' : ev.type ? `automatic: ${esc(ev.type)}` : 'automatic';
  return `<div class="scope">
    <span class="flabel">Teams shown at this event</span>
    <div class="seg">
      <button data-act="scope" data-v="league" class="${scope === 'league' ? 'on' : ''}">Our league only</button>
      <button data-act="scope" data-v="all" class="${scope === 'all' ? 'on' : ''}">Everyone</button>
    </div>
    <span class="muted small">${why} · ${scope === 'league' ? `${hidden} of ${all} teams hidden` : 'all teams shown'}. League meets and the league tournament show only ${esc(state.league.name || 'your league')}; state and other championships show everyone.</span>
  </div>`;
}

function firstStatusText() {
  const e = state.official.firstErr;
  if (!e) return '';
  if (e === 'nokey') return 'FIRST data needs your FTC Events API key in the Google Sheet script (README section 6).';
  if (e === 'nocloud') return 'FIRST data comes through the Google Sheet backup. Set that up on the Sync tab first.';
  return 'FIRST: ' + e;
}

function leagueCard(ev) {
  const L = state.league;
  const n = L ? Object.keys(L.teams || {}).length : 0;
  const srcLabel = { FIRST: 'FIRST', meets: 'teams at our meets', manual: 'edited by hand' }[L && L.src] || '';
  const fs = firstStatusText();
  return `<section class="card">
    <h2>Our league</h2>
    ${L ? `<p><b>${esc(L.name || 'Our league')}</b> · ${n} teams · from ${esc(srcLabel)}${L.upd ? ' · ' + new Date(L.upd).toLocaleDateString() : ''}</p>` :
      `<p class="muted">Set your league so league meets show only league teams, and the League tab can follow every league team across the season.</p>`}
    <div class="btnrow">
      <button data-act="leagueFromFirst">${L && L.src === 'FIRST' ? 'Refresh from FIRST' : 'Get roster from FIRST'}</button>
      ${ev ? `<button data-act="leagueAddEvent">Add all ${esc(ev.code)} teams</button>` : ''}
      <button data-act="leagueEdit">${L ? 'Edit list' : 'Type the list'}</button>
      ${L ? '<button class="ghost danger" data-act="leagueClear">Clear</button>' : ''}
    </div>
    ${official.busy ? `<p class="busy">${esc(official.progress || 'Working…')}</p>` : fs ? `<p class="muted small">${esc(fs)}</p>` : ''}
    ${ui.leagueEdit ? `
      <label>League name<input id="lgName" value="${esc((L && L.name) || '')}" placeholder="e.g. West League"></label>
      <label>Teams (one per line, number then name)<textarea id="lgTeams" rows="10">${esc(L ? teamsToText(L.teams) : '')}</textarea></label>
      <div class="btnrow"><button class="primary" data-act="leagueSave">Save league</button><button class="ghost" data-act="leagueCancel">Cancel</button></div>` : ''}
  </section>`;
}

function scoutPanel() {
  const s = S();
  return `
    <p class="muted small">FTCScout is a free public site that mirrors FIRST's official data. No account needed.</p>
    <div class="row">
      <button data-act="findMine">Find my team's events</button>
    </div>
    <div class="row">
      <input id="evSearch" data-ui="qSearch" value="${esc(ui.qSearch || '')}" placeholder="Search by event name or city" autocomplete="off">
      <button data-act="searchEv">Search</button>
    </div>
    <div class="row">
      <input id="evCode" data-ui="qCode" value="${esc(ui.qCode || '')}" placeholder="Event code, e.g. USTXHOQ1" autocapitalize="characters" autocomplete="off">
      <button class="primary" data-act="dlScout">Download</button>
    </div>
    ${ui.busy ? `<p class="busy">${esc(ui.busy)}</p>` : ''}
    ${ui.found.length ? `<div class="list">${ui.found.map(e =>
      `<button class="listitem" data-act="dlScout" data-code="${esc(e.code)}"><b>${esc(e.code)}</b> ${esc(e.name)} <span class="muted small">${esc(e.start ? String(e.start).slice(0, 10) : '')}</span></button>`).join('')}</div>` : ''}`;
}

function firstPanel() {
  const s = S();
  return `
    <p class="muted small">FIRST's official FTC Events API needs a free username and authorization key (register at ftc-events.firstinspires.org/services/API).
    FIRST's servers usually block requests made directly from a browser. If the download fails, use FTCScout, or run
    <code>tools/ftc_event_download.py</code> on a laptop and import the file it makes.</p>
    <div class="grid2">
      <label>API username<input data-set="ftcUser" value="${esc(s.ftcUser)}" autocomplete="off" autocapitalize="off"></label>
      <label>Authorization key<input data-set="ftcKey" type="password" value="${esc(s.ftcKey)}" autocomplete="off"></label>
    </div>
    <label>API base URL (or your proxy)<input data-set="ftcBase" value="${esc(s.ftcBase)}" autocapitalize="off"></label>
    <div class="row">
      <input id="evCodeFirst" data-ui="qCode" value="${esc(ui.qCode || '')}" placeholder="Event code" autocapitalize="characters" autocomplete="off">
      <button class="primary" data-act="dlFirst">Download</button>
    </div>
    ${ui.busy ? `<p class="busy">${esc(ui.busy)}</p>` : ''}`;
}

function manualPanel(ev) {
  return `
    <p class="muted small">Type or paste. Teams: one per line, number then name (name optional). Schedule: one match per line —
    <code>match red1 red2 blue1 blue2</code>, e.g. <code>1 12345 23456 34567 45678</code>. The schedule is optional.</p>
    <div class="grid2">
      <label>Event code<input id="mCode" value="${esc(ev ? ev.code : '')}" ${ev ? 'readonly' : ''} placeholder="e.g. MYQUAL1" autocapitalize="characters"></label>
      <label>Event name<input id="mName" value="${esc(ev ? ev.name : '')}" placeholder="Optional"></label>
    </div>
    <div class="grid2">
      <label>Teams<textarea id="mTeams" rows="10" placeholder="12345 Robo Bees&#10;23456 Pollinators">${esc(ev ? teamsToText(ev.teams) : '')}</textarea></label>
      <label>Qualification schedule<textarea id="mSched" rows="10" placeholder="1 12345 23456 34567 45678">${esc(ev ? scheduleToText(ev.matches) : '')}</textarea></label>
    </div>
    <div class="btnrow">
      <button class="primary" data-act="saveManual">Save event</button>
      ${ev ? '<button class="ghost" data-act="cancelEdit">Cancel</button>' : ''}
    </div>`;
}

function filePanel() {
  return `
    <p class="muted small">Import an event file (from <code>tools/ftc_event_download.py</code> or another Hive Scout) or a full backup.
    To copy an event from another iPad without internet, open <b>Share event by QR</b> on that iPad and scan it from the Sync tab here.</p>
    <div class="btnrow">
      <button data-act="importFile">Choose file…</button>
      <button data-act="tab" data-tab="sync">Scan event QR</button>
    </div>`;
}

// ---------------------------------------------------------------- SCOUT view

function counter(form, k, label, big = false) {
  const v = ui[form][k] || 0;
  return `<div class="counter ${big ? 'big' : ''}">
    <span class="clabel">${label}</span>
    <div class="cctl">
      <button data-act="inc" data-form="${form}" data-k="${k}" data-d="-1" aria-label="minus">−</button>
      <output>${v}</output>
      <button data-act="inc" data-form="${form}" data-k="${k}" data-d="1" aria-label="plus">+</button>
    </div></div>`;
}

function toggle(form, k, label) {
  const on = !!ui[form][k];
  return `<button class="toggle ${on ? 'on' : ''}" data-act="tog" data-form="${form}" data-k="${k}">${on ? '✓ ' : ''}${label}</button>`;
}

function choice(form, k, options, cls = '') {
  const cur = ui[form][k];
  return `<div class="seg ${cls}">${options.map(([v, l]) =>
    `<button data-act="set" data-form="${form}" data-k="${k}" data-v="${esc(v)}" class="${String(cur) === String(v) ? 'on' : ''}">${l}</button>`).join('')}</div>`;
}

function flags(form, k, map) {
  const cur = ui[form][k] || '';
  return `<div class="flags">${Object.entries(map).map(([c, l]) =>
    `<button data-act="flag" data-form="${form}" data-k="${k}" data-v="${c}" class="toggle ${cur.includes(c) ? 'on' : ''}">${cur.includes(c) ? '✓ ' : ''}${l}</button>`).join('')}</div>`;
}

// 6x6 field as seen from the audience; row 1 is nearest the audience.
function tileGrid(form, k, alliance, multi) {
  const cur = String(ui[form][k] || '');
  const sel = multi ? cur.split(',').filter(Boolean) : [cur];
  let html = `<div class="field ${multi ? 'redonly' : ''}">`;
  for (let r = 6; r >= 1; r--) {
    for (let c = 0; c < 6; c++) {
      const id = 'ABCDEF'[c] + r;
      const side = c < 3 ? 'R' : 'B';
      const enabled = multi ? side === 'R' : (!alliance || alliance === side);
      html += `<button class="tile ${side === 'R' ? 'red' : 'blue'} ${sel.includes(id) ? 'on' : ''}" ${enabled ? '' : 'disabled'}
        data-act="tile" data-form="${form}" data-k="${k}" data-v="${id}" data-multi="${multi ? 1 : 0}">${id}</button>`;
    }
  }
  html += `</div><div class="audience">▲ HIVE in center · AUDIENCE side ▼</div>`;
  return html;
}

function viewScout() {
  const ev = activeEvent();
  if (!ev) {
    return `<section class="card"><h2>No event yet</h2><p>Load or create an event on the Event tab first. A quick manual event with just a code is enough to start scouting.</p>
      <button class="primary" data-act="tab" data-tab="event">Go to Event</button></section>`;
  }
  if (!S().scoutName || ui.newScout) {
    return `<section class="card"><h2>Who is scouting${S().slot ? ' ' + posLabel(S().slot) : ''} on this iPad?</h2>
      <label>Scout's name<input id="newScoutName" value="" placeholder="First and last name" autocomplete="off" autocapitalize="words"></label>
      ${S().slot ? '' : `<span class="flabel">Position</span>${positionPicker()}`}
      <div class="btnrow"><button class="primary" data-act="startScout">Start scouting</button>
      ${ui.newScout && S().scoutName ? `<button class="ghost" data-act="cancelNewScout">Cancel (keep ${esc(S().scoutName)})</button>` : ''}</div>
      <p class="muted small">Every record saved from now on is marked with this name and position, so you can see who covered each match.</p></section>`;
  }
  return `
    ${scoutBar()}
    <div class="seg wide">
      <button data-act="scoutMode" data-v="match" class="${ui.scoutMode === 'match' ? 'on' : ''}">Match scouting</button>
      <button data-act="scoutMode" data-v="pit" class="${ui.scoutMode === 'pit' ? 'on' : ''}">Pit scouting</button>
    </div>
    ${ui.scoutMode === 'match' ? matchForm(ev) : pitForm(ev)}
    ${recentList()}`;
}

function matchForm(ev) {
  if (!ui.mf || ui.mf.ev !== ev.code) ui.mf = newMatchForm(nextMatchNumber());
  const mf = ui.mf;
  const sched = scheduleFor(mf.mt);
  const slots = sched ? [['R1', sched.r[0]], ['R2', sched.r[1]], ['B1', sched.b[0]], ['B2', sched.b[1]]] : [];
  return `
  <section class="card matchhead ${mf.al === 'R' ? 'isred' : mf.al === 'B' ? 'isblue' : ''}">
    <div class="mrow">
      <div class="stepper">
        <button data-act="mt" data-d="-1">−</button>
        <label>Match<input data-mf="mt" data-type="int" value="${mf.mt}" inputmode="numeric"></label>
        <button data-act="mt" data-d="1">+</button>
      </div>
      ${mf.id ? `<span class="pill warn">Editing saved record</span>` : ''}
    </div>
    ${slots.length ? `<div class="slots">${slots.map(([sl, t]) => {
      const other = t && !inScope(t, ev);
      const mine = S().slot === sl;
      return `<button class="slot ${sl[0] === 'R' ? 'red' : 'blue'} ${mf.tm === t && mf.al === sl[0] ? 'on' : ''} ${other ? 'other' : ''} ${other && mine ? 'mine' : ''}" data-act="slot" data-v="${sl}" data-team="${t || ''}">
        <span>${sl[0] === 'R' ? 'Red' : 'Blue'} ${sl[1]}</span><b>${t || '—'}</b><small>${other ? 'Other league' : esc(teamName(t))}</small></button>`;
    }).join('')}</div>
      ${mf.skip && !mf.tm ? `<div class="banner warn skip">Your robot this match (${mf.skip}) isn't in ${esc((state.league && state.league.name) || 'your league')}. Nothing to scout. <button class="primary" data-act="mt" data-d="1">Next match →</button></div>` : ''}
      <p class="muted small">${S().slot ? `This iPad scouts <b>${posLabel(S().slot)}</b>, so the team fills in automatically each match.` : 'Tap the robot position you are scouting, or set this iPad\'s position on the Event tab.'}</p>` :
      `<p class="muted small">No schedule for match ${mf.mt}. Enter the team and alliance.</p>`}
    <div class="grid2">
      <label>Team<input data-mf="tm" data-type="int" value="${mf.tm || ''}" inputmode="numeric" placeholder="Team #"></label>
      <div><span class="flabel">Alliance</span>${choice('mf', 'al', [['R', 'Red'], ['B', 'Blue']], 'alli')}</div>
    </div>
    ${mf.tm ? `<div class="teamline"><b>${mf.tm}</b> ${esc(teamName(mf.tm))}</div>` : ''}
    ${toggle('mf', 'ns', 'No show')}
  </section>

  <section class="card">
    <h2><span class="tag">0:30</span> AUTO</h2>
    <div class="split">
      <div>
        <span class="flabel">Starting tile ${mf.al ? '' : '(pick alliance first)'}</span>
        ${tileGrid('mf', 'st', mf.al, false)}
      </div>
      <div class="stack">
        <div class="flags">${toggle('mf', 'lv', 'LEAVE (+3)')}${toggle('mf', 'aP', 'PARK in LOADING ZONE (+5)')}</div>
        ${counter('mf', 'aM', 'Launched into HIVE CELL', true)}
        ${counter('mf', 'aX', 'Missed launches')}
        <span class="flabel">Picked up pieces from</span>
        ${flags('mf', 'aS', LABELS.aS)}
      </div>
    </div>
  </section>

  <section class="card">
    <h2><span class="tag">2:00</span> TELEOP</h2>
    <div class="grid2">
      ${counter('mf', 'tM', 'Launched into HIVE CELL', true)}
      ${counter('mf', 'tX', 'Missed launches', true)}
    </div>
    <span class="flabel">Picks up from</span>
    ${flags('mf', 'iS', LABELS.iS)}
  </section>

  <section class="card">
    <h2><span class="tag">1:00</span> ENDGAME</h2>
    <div class="grid3">
      ${counter('mf', 'fN', 'NECTAR into FLOWER')}
      ${counter('mf', 'fP', 'POLLEN into FLOWER')}
      ${counter('mf', 'gd', 'Into GARDEN')}
    </div>
    <div class="flags">${toggle('mf', 'pk', 'PARKED in LOADING ZONE at end (+5)')}</div>
  </section>

  <section class="card">
    <h2>Overall</h2>
    <div class="grid2">
      <div><span class="flabel">Defense played</span>${choice('mf', 'df', LABELS.df.map((l, i) => [i, l]))}</div>
      <div><span class="flabel">Driver skill</span>${choice('mf', 'dr', [1, 2, 3, 4, 5, 6, 7].map(n => [n, String(n)]), 'scale')}</div>
    </div>
    <span class="flabel">Problems</span>
    ${flags('mf', 'br', LABELS.br)}
    <div class="grid3">
      ${counter('mf', 'mn', 'MINOR fouls (5)')}
      ${counter('mf', 'mj', 'MAJOR fouls (20)')}
      <div><span class="flabel">Card</span>${choice('mf', 'cd', LABELS.cd.map((l, i) => [i, l]))}</div>
    </div>
    <label>Notes<textarea data-mf="nt" rows="2" maxlength="200" placeholder="Short notes (shared by QR, 200 characters max)">${esc(mf.nt)}</textarea></label>
  </section>

  <div class="savebar">
    <button class="ghost" data-act="resetMatch">Clear</button>
    <button class="primary big" data-act="saveMatch">Save match ${mf.mt}${mf.tm ? ' · ' + mf.tm : ''}</button>
  </div>`;
}

function pitForm(ev) {
  if (!ui.pf || ui.pf.ev !== ev.code) { ui.pf = blankPit(); ui.pf.ev = ev.code; }
  const pf = ui.pf;
  const pits = latestPits(eventRecords(ev.code));
  const teams = Object.keys(ev.teams).map(Number).filter(t => inScope(t, ev)).sort((a, b) => a - b);
  return `
  <section class="card">
    <h2>Team</h2>
    <div class="chips">${teams.map(t => `<button class="chip ${pf.tm === t ? 'on' : ''} ${pits[t] ? 'done' : ''}" data-act="pitTeam" data-team="${t}">${pits[t] ? '✓ ' : ''}<b>${t}</b></button>`).join('')}</div>
    <label>Or type a team number<input data-pf="tm" data-type="int" value="${pf.tm || ''}" inputmode="numeric"></label>
    ${pf.tm ? `<div class="teamline"><b>${pf.tm}</b> ${esc(teamName(pf.tm))}${pf.id ? ' <span class="pill warn">Editing saved pit entry</span>' : ''}</div>` : ''}
  </section>
  <section class="card">
    <h2>Robot</h2>
    <div class="grid2">
      <div><span class="flabel">Drivetrain</span>${choice('pf', 'dt', Object.entries(LABELS.dt))}</div>
      <div><span class="flabel">Launcher</span>${choice('pf', 'ln', Object.entries(LABELS.ln))}</div>
    </div>
    <span class="flabel">Can it…</span>
    <div class="flags">
      ${toggle('pf', 'hv', 'Launch into HIVE')}${toggle('pf', 'fl', 'Place in FLOWER (top)')}
      ${toggle('pf', 'fb', 'Pull POLLEN from FLOWER bottom')}${toggle('pf', 'nc', 'Handle NECTAR')}${toggle('pf', 'vs', 'Use AprilTags')}
    </div>
    <div class="grid2">
      <div><span class="flabel">Most pieces it carries (rule max 4)</span>${choice('pf', 'cap', [[1, '1'], [2, '2'], [3, '3'], [4, '4']])}</div>
      ${counter('pf', 'cy', 'HIVE launches per match (their estimate)')}
    </div>
    <span class="flabel">Preferred role</span>
    ${choice('pf', 'rl', Object.entries(LABELS.rl))}
  </section>
  <section class="card">
    <h2>AUTO</h2>
    <div class="split">
      <div>
        <span class="flabel">Starting tiles they can use (drawn on the red side; blue is matched automatically)</span>
        ${tileGrid('pf', 'ast', '', true)}
      </div>
      <div class="stack">
        ${counter('pf', 'aL', 'HIVE launches in AUTO', true)}
        <div class="flags">${toggle('pf', 'aLv', 'Leaves')}${toggle('pf', 'aPk', 'Parks in LOADING ZONE')}</div>
        <span class="flabel">AUTO picks up from</span>
        ${flags('pf', 'aS', LABELS.aS)}
      </div>
    </div>
  </section>
  <section class="card">
    <label>Notes<textarea data-pf="nt" rows="3" maxlength="300" placeholder="Strengths, worries, AUTO paths…">${esc(pf.nt)}</textarea></label>
  </section>
  <div class="savebar">
    <button class="ghost" data-act="resetPit">Clear</button>
    <button class="primary big" data-act="savePit">Save pit entry${pf.tm ? ' · ' + pf.tm : ''}</button>
  </div>`;
}

function recentList() {
  const mine = eventRecords().filter(r => isMine(r) && r.t === (ui.scoutMode === 'pit' ? 'p' : 'm'))
    .sort((a, b) => b.ts - a.ts).slice(0, 12);
  if (!mine.length) return '';
  return `<section class="card"><h2>Saved on this iPad</h2><div class="list">${mine.map(r => `
    <div class="listitem rec">
      <span>${r.t === 'm' ? `Match <b>${r.mt}</b> · ` : 'Pit · '}<b>${r.tm}</b> ${esc(teamName(r.tm))}
        ${r.t === 'm' ? `<span class="dot ${r.al === 'R' ? 'red' : 'blue'}"></span>` : ''}
        ${state.sent[r.id] ? '<span class="pill ok">sent</span>' : '<span class="pill warn">unsent</span>'}</span>
      <span class="btnrow tight"><button data-act="editRec" data-id="${esc(r.id)}">Edit</button><button class="ghost danger" data-act="delRec" data-id="${esc(r.id)}">Delete</button></span>
    </div>`).join('')}</div></section>`;
}

// ---------------------------------------------------------------- SYNC view

function viewSync() {
  const ev = activeEvent();
  const unsent = unsentRecords().length;
  const evCount = ev ? eventRecords(ev.code).length : 0;
  const s = S();
  return `
  <section class="card">
    <h2>Cloud backup · Google Sheet</h2>
    <p class="muted small">When this iPad is online it uploads new scouting by itself and downloads everyone else's. With no internet it keeps working and catches up later. QR codes are only needed when nobody has internet.</p>
    <div class="grid2">
      <label>Web app URL<input data-set="cloudUrl" value="${esc(s.cloudUrl)}" placeholder="https://script.google.com/macros/s/…/exec" autocapitalize="off" autocomplete="off" spellcheck="false"></label>
      <label>Team key<input data-set="cloudKey" value="${esc(s.cloudKey)}" placeholder="TEAM_KEY from the script" autocapitalize="off" autocomplete="off" spellcheck="false"></label>
    </div>
    <div id="cloudStatus" class="cloudstatus">${cloudStatusHTML()}</div>
    <div class="btnrow">
      <button class="primary" data-act="cloudSync" ${cloudConfigured() ? '' : 'disabled'}>Sync now</button>
      <button data-act="cloudToggle" ${cloudConfigured() ? '' : 'disabled'}>${s.cloudOn === false ? 'Resume auto sync' : 'Pause auto sync'}</button>
      <button data-act="shareCloud" ${cloudConfigured() ? '' : 'disabled'}>Share cloud setup by QR</button>
    </div>
    <p class="muted small">To set up another iPad, scan <b>Share cloud setup by QR</b> from it. <b>Share event by QR</b> includes the cloud setup too.</p>
  </section>
  <section class="card">
    <h2>Send from this iPad</h2>
    <p class="muted small">Shows a QR code (or a short animated series) for another iPad or laptop to scan. Keep this screen bright and hold steady.</p>
    <div class="btnrow">
      <button class="primary" data-act="sendUnsent" ${unsent ? '' : 'disabled'}>Send my unsent records (${unsent})</button>
      <button data-act="sendAll" ${evCount ? '' : 'disabled'}>Send all ${ev ? esc(ev.code) : ''} data (${evCount})</button>
      <button data-act="sendEvent" ${ev ? '' : 'disabled'}>Send event setup</button>
    </div>
  </section>
  <section class="card">
    <h2>Receive (scan)</h2>
    <p class="muted small">Point this camera at the other screen. Records merge automatically; scanning the same code twice is harmless.</p>
    <div class="btnrow">
      <button class="primary" data-act="scanStart" id="scanStartBtn">${ui.scanner && ui.scanner.running ? 'Scanning…' : 'Start camera'}</button>
      <button data-act="scanFlip">Switch camera</button>
      <button class="ghost" data-act="scanStop">Stop</button>
    </div>
    <div class="scanwrap ${ui.scanner && ui.scanner.running ? '' : 'hidden'}" id="scanWrap">
      <video id="scanVideo" playsinline muted></video>
      <div class="scanframe"></div>
    </div>
    <div id="scanStatus" class="scanstatus"></div>
    <div id="scanLog" class="list"></div>
  </section>
  <section class="card">
    <h2>Backup &amp; export</h2>
    <p class="muted small">Make a backup at the end of each day. iPadOS can clear website data that hasn't been used for a while. Save backups to Files or AirDrop them to a laptop.</p>
    <div class="btnrow">
      <button data-act="exportBackup">Save backup (.json)</button>
      <button data-act="importFile">Import backup or event file</button>
      <button data-act="exportCSV" data-type="m" ${evCount ? '' : 'disabled'}>Match data CSV</button>
      <button data-act="exportCSV" data-type="p" ${evCount ? '' : 'disabled'}>Pit data CSV</button>
    </div>
    <div class="btnrow"><button class="ghost danger" data-act="clearAll">Erase everything on this iPad</button></div>
  </section>`;
}

function renderScanLog() {
  const el = $('#scanLog');
  if (!el) return;
  el.innerHTML = ui.scanLog.slice(-10).reverse().map(l => `<div class="listitem ${l.kind}">${esc(l.text)}</div>`).join('');
}

function logScan(text, kind = 'ok') {
  ui.scanLog.push({ text: new Date().toLocaleTimeString() + ' — ' + text, kind });
  renderScanLog();
}

async function handleMessage(obj) {
  if (obj.k === 'rec') {
    let n = 0, u = 0, same = 0;
    const all = [...(obj.m || []).map(a => fromArr(a, 'm')), ...(obj.p || []).map(a => fromArr(a, 'p')), ...(obj.s || []).map(a => fromArr(a, 's'))];
    for (const r of all) {
      const res = upsertRecord(r);
      if (res === 'new') n++; else if (res === 'updated') u++; else same++;
    }
    persist('records');
    logScan(`${all.length} records from ${obj.sc || 'device ' + (obj.dv || '?')}: ${n} new, ${u} updated, ${same} already had`);
    toast(`Received ${all.length} records (${n} new)`, 'ok');
    syncSoon();
  } else if (obj.k === 'evt') {
    const ev = normalizeEvent(obj.d);
    saveEvent(ev);
    ui.mf = null; ui.pf = null;
    const cloudSet = applyCloudConfig(obj.c);
    if (obj.l && obj.l.teams && (!state.league || (obj.l.upd || 0) > (state.league.upd || 0))) saveLeague(obj.l);
    logScan(`Event ${ev.code} loaded: ${Object.keys(ev.teams).length} teams, ${ev.matches.length} matches${cloudSet ? ' · cloud backup set up' : ''}`);
    toast(`Event ${ev.code} loaded${cloudSet ? ' · cloud backup on' : ''}`, 'ok');
    syncSoon();
  } else if (obj.k === 'cfg') {
    const cloudSet = applyCloudConfig(obj.c);
    logScan(cloudSet ? 'Cloud backup set up' : 'Cloud backup was already set up');
    toast(cloudSet ? 'Cloud backup is on' : 'Cloud backup already set up', 'ok');
  } else {
    logScan('Unknown QR content', 'err');
  }
  beep();
  const wrap = $('#scanWrap');
  if (wrap) { wrap.classList.add('flash'); setTimeout(() => wrap.classList.remove('flash'), 500); }
  renderHeader();
}

async function onScanText(text) {
  if (!ui.assembler) ui.assembler = new Assembler(handleMessage);
  try {
    const res = await ui.assembler.push(text);
    const st = $('#scanStatus');
    if (res.status === 'foreign') { if (st) st.textContent = 'That QR code is not from Hive Scout.'; return; }
    if (res.status === 'partial' && st) {
      st.innerHTML = `Receiving: ${res.have} of ${res.n} parts <span class="parts">${res.chunks.map(c => `<i class="${c ? 'got' : ''}"></i>`).join('')}</span>`;
    } else if (res.status === 'complete' && st) {
      st.textContent = 'Complete ✓ Ready for the next code.';
    } else if (res.status === 'dup' && st) {
      st.textContent = 'Already received this one ✓';
    }
  } catch (e) {
    logScan('Could not read: ' + friendlyError(e), 'err');
  }
}

async function startScanner() {
  const video = $('#scanVideo');
  if (!video) return;
  $('#scanWrap').classList.remove('hidden');
  if (!ui.scanner) ui.scanner = new Scanner(video, onScanText);
  ui.scanner.video = video;
  try {
    await ui.scanner.start(ui.facing);
    const b = $('#scanStartBtn'); if (b) b.textContent = 'Scanning…';
  } catch (e) {
    $('#scanWrap').classList.add('hidden');
    const msg = e && e.name === 'NotAllowedError'
      ? 'Camera permission was denied. Allow camera access for this site in Settings › Safari › Camera (or the site settings), then try again.'
      : friendlyError(e);
    logScan(msg, 'err');
    toast(msg, 'err');
  }
}

function stopScanner() {
  if (ui.scanner) ui.scanner.stop();
  const w = $('#scanWrap'); if (w) w.classList.add('hidden');
  const b = $('#scanStartBtn'); if (b) b.textContent = 'Start camera';
}

// ---- QR display

async function showQR(title, obj, markIds) {
  let frames;
  try { frames = await encodeMessage(obj); } catch (e) { toast('Could not build QR: ' + e.message, 'err'); return; }
  ui.qr = { frames, i: 0, playing: frames.length > 1, markIds: markIds || [], title };
  openModal(`
    <div class="qrview">
      <div class="qrhead"><b>${esc(title)}</b><span id="qrPart"></span></div>
      <div class="qrbox"><canvas id="qrCanvas"></canvas></div>
      <div class="btnrow center">
        ${frames.length > 1 ? `<button data-act="qrPrev">◀</button><button data-act="qrPlay" id="qrPlayBtn">Pause</button><button data-act="qrNext">▶</button>` : ''}
      </div>
      <p class="muted small center">${frames.length > 1 ? 'The code cycles through all parts. The receiving iPad can pick them up in any order.' : 'Scan with the Sync tab on the receiving iPad.'}</p>
      <div class="btnrow center">
        ${markIds && markIds.length ? `<button class="primary" data-act="qrMarkSent">Received ✓ Mark ${markIds.length} as sent</button>` : ''}
        <button class="ghost" data-act="closeModal">Close</button>
      </div>
    </div>`, 'full');
  drawFrame();
  if (ui.qr.playing) ui.qr.timer = setInterval(() => { ui.qr.i = (ui.qr.i + 1) % ui.qr.frames.length; drawFrame(); }, Math.max(300, S().qrSpeed || 900));
}

function drawFrame() {
  const q = ui.qr;
  const c = $('#qrCanvas');
  if (!q || !c) return;
  const dpr = window.devicePixelRatio || 1;
  const cssMax = Math.max(220, Math.min(window.innerWidth - 40, window.innerHeight - 260, 760));
  const { size } = drawQR(c, q.frames[q.i], cssMax * dpr);
  c.style.width = c.style.height = Math.round(size / dpr) + 'px';
  const p = $('#qrPart');
  if (p) p.textContent = q.frames.length > 1 ? `Part ${q.i + 1} of ${q.frames.length}` : '';
}

function stopQR() {
  if (ui.qr && ui.qr.timer) clearInterval(ui.qr.timer);
  ui.qr = null;
}

function recMessage(recs) {
  return {
    k: 'rec', dv: S().deviceId, sc: S().scoutName,
    m: recs.filter(r => r.t === 'm').map(toArr),
    p: recs.filter(r => r.t === 'p').map(toArr),
    s: recs.filter(r => r.t === 's').map(toArr),
  };
}

// ---------------------------------------------------------------- TEAMS view

const TEAM_COLS = [
  ['team', 'Team'], ['n', 'Matches'], ['est', 'Est pts'], ['estAuto', 'AUTO pts'], ['made', 'HIVE/match'],
  ['acc', 'Accuracy'], ['flower', 'FLOWER/match'], ['park', 'Park'], ['foulPts', 'Foul pts'], ['broke', 'Breakdowns'],
];

const f2 = x => (x == null || isNaN(x) ? '–' : (Math.round(x * 100) / 100).toString());

function gapHTML(g) {
  if (g == null || isNaN(g)) return '–';
  const cls = Math.abs(g) < 5 ? 'even' : g > 0 ? 'up' : 'down';
  return `<span class="gap ${cls}">${g > 0 ? '+' : ''}${f1(g)}</span>`;
}

function trendHTML(t) {
  if (t == null || isNaN(t)) return '';
  if (Math.abs(t) < 3) return '<span class="trend flat" title="About the same as earlier meets">→</span>';
  return t > 0 ? `<span class="trend up" title="Up ${f1(t)} pts vs earlier meets">▲</span>` : `<span class="trend down" title="Down ${f1(-t)} pts vs earlier meets">▼</span>`;
}

function hiddenNote(n) {
  return n ? `<p class="muted small">${n} teams from other leagues are hidden at this event (change this on the Event tab).</p>` : '';
}

// ---------------------------------------------------------------- MEET view (this event)

function meetSwitch() {
  const v = ui.meetView || 'stats';
  return `<div class="seg wide">
    <button data-act="meetView" data-v="stats" class="${v === 'stats' ? 'on' : ''}">Team stats</button>
    <button data-act="meetView" data-v="coverage" class="${v === 'coverage' ? 'on' : ''}">Scouting coverage</button>
  </div>`;
}

// Which robot positions were scouted in each match, by whom, and who was responsible for any that were missed.
function viewCoverage(ev) {
  const recs = eventRecords(ev.code);
  const mrecs = recs.filter(r => r.t === 'm');
  const shifts = recs.filter(r => r.t === 's').sort((a, b) => a.ts - b.ts);
  const live = liveFor(ev.code);
  const L = (live && live.m) || {};
  const playedOfficial = Object.values(L).filter(x => x.rs !== null && x.rs !== undefined).map(x => x.n);
  const lastPlayed = Math.max(0, ...playedOfficial, ...mrecs.map(r => Number(r.mt) || 0));
  const matches = (ev.matches || []).slice().sort((a, b) => a.n - b.n);
  if (!matches.length) return `<section class="card"><h2>Scouting coverage</h2><p class="muted">Coverage needs the match schedule for ${esc(ev.code)}.</p></section>`;

  const legacyPos = sc => { const m = /^(red|blue)\s*([12])$/i.exec(String(sc || '').trim()); return m ? m[1][0].toUpperCase() + m[2] : ''; };
  const posOf = r => stationOf(r.mt, r.tm) || r.ps || legacyPos(r.sc);
  const by = {};
  for (const r of mrecs) (by[r.mt + '|' + r.tm] = by[r.mt + '|' + r.tm] || []).push(r);
  const responsible = (p, n) => {
    const sh = shifts.filter(x => x.ps === p && (Number(x.mt) || 0) <= n);
    if (sh.length) return { name: sh[sh.length - 1].sc, sure: true };
    const at = mrecs.filter(r => posOf(r) === p).sort((a, b) => a.mt - b.mt);
    const before = at.filter(r => r.mt < n).pop(), after = at.find(r => r.mt > n);
    if (before && after && before.sc !== after.sc) return { name: `${before.sc} or ${after.sc}`, sure: false };
    const r = before || after;
    return { name: r ? r.sc : '', sure: false };
  };

  const pos = POSITIONS.map(([p, label]) => ({ p, label, need: 0, got: 0, missing: [], scouts: new Set() }));
  const missingBy = {};
  const rows = matches.map(m => {
    const cells = POSITIONS.map(([p], i) => {
      const t = (p[0] === 'R' ? m.r : m.b)[Number(p[1]) - 1];
      const P = pos[i];
      if (!t) return { cls: 'none', html: '–' };
      const list = by[m.n + '|' + t] || [];
      if (!inScope(t, ev)) return { cls: 'skip', html: `<b>${t}</b><small>other league</small>` };
      if (list.length) {
        if (m.n <= lastPlayed) { P.need++; P.got++; }
        list.forEach(r => P.scouts.add(r.sc));
        return { cls: 'ok', html: `<b>${t}</b><small>${list.map(r => esc(r.sc)).join(', ')}</small>` };
      }
      if (m.n > lastPlayed) return { cls: 'later', html: `<b>${t}</b><small>not played yet</small>` };
      P.need++;
      const who = responsible(p, m.n);
      P.missing.push({ n: m.n, who });
      const key = who.name || 'No scout signed in';
      (missingBy[key] = missingBy[key] || []).push(`Q${m.n} ${posLabel(p)}`);
      return { cls: 'miss', html: `<b>${t}</b><small>missing${who.name ? ' · ' + esc(who.name) + (who.sure ? '' : '?') : ''}</small>` };
    });
    return { m, cells };
  });
  const shown = ui.covMissingOnly ? rows.filter(r => r.cells.some(c => c.cls === 'miss')) : rows;
  const totalNeed = pos.reduce((a, x) => a + x.need, 0), totalGot = pos.reduce((a, x) => a + x.got, 0);

  return `
  <section class="card">
    <h2>Scouting coverage · ${esc(ev.name)}</h2>
    <p class="muted small">${lastPlayed ? `Through Q${lastPlayed}: <b>${totalGot} of ${totalNeed}</b> robot-matches scouted (${totalNeed ? Math.round(100 * totalGot / totalNeed) : 0}%).` : 'No matches played yet.'}
      Other-league robots at league events aren't counted.</p>
    <div class="covsum">${pos.map(x => `<div class="covpos ${x.p[0] === 'R' ? 'red' : 'blue'}">
      <b>${x.label}</b> <span>${x.got}/${x.need}</span>
      <small>${x.scouts.size ? 'Scouts: ' + [...x.scouts].map(esc).join(', ') : 'No records yet'}</small>
      ${x.missing.length ? `<small class="miss">Missed: ${x.missing.map(mm => `Q${mm.n}`).join(', ')}</small>` : ''}
    </div>`).join('')}</div>
    ${Object.keys(missingBy).length ? `<h3>Missed matches by scout</h3><ul class="notes">${Object.entries(missingBy).map(([who, list]) =>
      `<li><b>${esc(who)}</b>: ${list.length} missed: ${esc(list.join(', '))}</li>`).join('')}</ul>
      <p class="muted small">The name comes from who was signed in to that position's iPad at the time. A "?" means nobody signed in, so it's a best guess from the scouts before and after the gap.</p>` : ''}
    <label class="check"><input type="checkbox" data-change="covMissingOnly" ${ui.covMissingOnly ? 'checked' : ''}> Show only matches with a missed robot</label>
    <div class="tablewrap"><table class="tbl cov">
      <thead><tr><th>Match</th>${POSITIONS.map(([p, l]) => `<th class="${p[0] === 'R' ? 'red' : 'blue'}">${l}</th>`).join('')}</tr></thead>
      <tbody>${shown.map(r => `<tr><td class="mn">Q${r.m.n}</td>${r.cells.map(c => `<td class="cv ${c.cls}">${c.html}</td>`).join('')}</tr>`).join('')}</tbody>
    </table></div>
    ${shifts.length ? `<h3>Scout sign-ins</h3><div class="tablewrap"><table class="tbl small">
      <thead><tr><th>Position</th><th>Scout</th><th>From match</th><th>Time</th></tr></thead>
      <tbody>${shifts.map(x => `<tr><td>${esc(posLabel(x.ps) || 'Any')}</td><td>${esc(x.sc)}</td><td>Q${x.mt}</td><td>${new Date(x.ts * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</td></tr>`).join('')}</tbody></table></div>` : ''}
  </section>`;
}

function viewTeams() {
  const { ev, stats, hidden } = computeEvent();
  if (!ev) return `<section class="card"><p>Load an event first.</p></section>`;
  if ((ui.meetView || 'stats') === 'coverage') return meetSwitch() + viewCoverage(ev);
  const showOpr = S().show.opr && Object.keys(state.official.opr || {}).length > 0;
  const q = ui.filter.trim().toLowerCase();
  let rows = stats.filter(s => !q || String(s.team).includes(q) || teamName(s.team).toLowerCase().includes(q));
  for (const r of rows) { const o = oprFor(r.team); r.opr = o ? o.tot : null; }
  const { k, d } = ui.sort;
  rows.sort((a, b) => {
    const av = a[k] == null ? -1 : a[k], bv = b[k] == null ? -1 : b[k];
    return (av - bv) * d || a.team - b.team;
  });
  const cols = showOpr ? [...TEAM_COLS, ['opr', 'OPR']] : TEAM_COLS;
  const our = Number(S().ourTeam);
  return `
  ${meetSwitch()}
  <section class="card">
    <h2>This meet · ${esc(ev.name)}</h2>
    ${hiddenNote(hidden)}
    <div class="row"><input id="teamFilter" data-change="filter" value="${esc(ui.filter)}" placeholder="Filter by number or name" autocomplete="off">
      <span class="muted small">${stats.filter(s => s.n).length} of ${stats.length} teams scouted</span></div>
    <div class="tablewrap"><table class="tbl">
      <thead><tr>${cols.map(([key, l]) => `<th data-act="sort" data-k="${key}" class="${k === key ? 'sorted' : ''}">${l}${k === key ? (d < 0 ? ' ▼' : ' ▲') : ''}</th>`).join('')}<th>Pit</th></tr></thead>
      <tbody>${rows.map(s => `
        <tr data-act="team" data-team="${s.team}" class="${s.team === our ? 'ours' : ''} ${getPick(s.team)}">
          <td><b>${s.team}</b> <span class="tname">${esc(teamName(s.team))}</span> ${flagIcon(s.team)}</td>
          <td>${s.n || (s.claimed ? 'pit' : '–')}</td>
          <td><b>${s.n || s.claimed ? f1(s.est) : '–'}</b></td>
          <td>${s.n || s.claimed ? f1(s.estAuto) : '–'}</td>
          <td>${s.n || s.claimed ? f1(s.made) : '–'}</td>
          <td>${s.n ? pct(s.acc) : '–'}</td>
          <td>${s.n || s.claimed ? f1(s.flower) : '–'}</td>
          <td>${s.n ? pct(s.park) : '–'}</td>
          <td>${s.n ? f1(s.foulPts) : '–'}</td>
          <td>${s.n ? pct(s.broke) : '–'}</td>
          ${showOpr ? `<td>${f1(s.opr)}</td>` : ''}
          <td>${s.pit ? '✓' : ''}</td>
        </tr>`).join('')}</tbody>
    </table></div>
    <p class="muted small">Est pts = this robot's share: LEAVE/PARK + launches × ${f1(20 / Math.max(1, S().perTip))} (20 pts per tip ÷ ${S().perTip} launches) + FLOWER pieces × 2 + GARDEN. Averages combine all scouts. The League tab shows each team's whole season.</p>
  </section>`;
}

function flagIcon(t) {
  const p = getPick(t);
  return p === 'pick' ? '<span class="flag pick">★</span>' : p === 'maybe' ? '<span class="flag maybe">?</span>' : p === 'dnp' ? '<span class="flag dnp">✕</span>' : '';
}

function officialBlock(t, season) {
  const o = oprFor(t), r = rankFor(t);
  const cr = stageRanksFor(t);
  if (!o && !r && !cr.length) return '';
  const has = season.n || season.claimed;
  const row = (label, mine, theirs) => `<tr><td>${label}</td><td>${has ? f1(mine) : '–'}</td><td>${f1(theirs)}</td><td>${has && theirs != null ? gapHTML(mine - theirs) : '–'}</td></tr>`;
  return `<h3>Scouted vs official</h3>
    ${o ? `<div class="tablewrap"><table class="tbl small cmp">
      <thead><tr><th>Points per match</th><th>Our scouts</th><th>FTCScout OPR</th><th>Gap</th></tr></thead>
      <tbody>
        ${row('Total', season.est, o.tot)}
        ${o.auto != null ? row('AUTO', season.estAuto, o.auto) : ''}
        ${o.dc != null ? row('TELEOP (HIVE launches)', season.estTele, o.dc) : ''}
        ${o.eg != null ? row('Endgame (FLOWER, GARDEN, PARK)', season.estEnd, o.eg) : ''}
      </tbody></table></div>` : ''}
    ${r ? `<p class="small">League rank <b>#${r.rank}</b> · ranking score ${f2(r.rs)} · record ${r.w}-${r.l}-${r.t} · ${r.played} matches${r.avg != null ? ` · avg ${f1(r.avg)}` : ''}</p>` : ''}
    ${cr.map(c => `<p class="small">${esc(c.name)}: rank <b>#${c.rank}</b> of ${c.of} · ranking score ${f2(c.rs)} · record ${c.w}-${c.l}-${c.t}</p>`).join('')}
    <p class="muted small">OPR is FTCScout's estimate of the points a team adds per match, worked out from official scores. FTCScout may split TELEOP and endgame differently than our scouting does. A big gap means a second look: your scouts may be missing something, or the robot has changed.</p>`;
}

function teamModal(t) {
  t = Number(t);
  const { ev, stats: evStats, obs } = computeEvent();
  const sd = computeSeason();
  const season = seasonStats(t, sd, false);
  const seasonW = seasonStats(t, sd, true);
  const us = ourStats(sd);
  const isOurs = t === Number(S().ourTeam);
  const cands = evStats.filter(x => x.team !== Number(S().ourTeam)).map(x => seasonStats(x.team, sd, true));
  const c = !isOurs && us && (us.n || us.claimed) && (seasonW.n || seasonW.claimed)
    ? compatibility(us, seasonW, eventContext(cands.length ? cands : [seasonW]), S()) : null;
  const here = obs.filter(o => o.tm === t);
  const p = season.pit;
  const pick = getPick(t);
  const name = teamName(t, ev) || (state.league && state.league.teams && state.league.teams[t]) || officialName(t) || '';
  const meets = meetsFor(t);
  const seasonNotes = sd.obs.filter(o => o.tm === t && o.nt);
  openModal(`
    <div class="mhead"><h2>${t} <span class="muted">${esc(name)}</span></h2><button class="ghost" data-act="closeModal">Close</button></div>
    ${!isOurs ? `<div class="seg picks">
      <button data-act="pick" data-team="${t}" data-v="pick" class="${pick === 'pick' ? 'on' : ''}">★ Want</button>
      <button data-act="pick" data-team="${t}" data-v="maybe" class="${pick === 'maybe' ? 'on' : ''}">? Maybe</button>
      <button data-act="pick" data-team="${t}" data-v="dnp" class="${pick === 'dnp' ? 'on' : ''}">✕ Avoid</button>
      <button data-act="pick" data-team="${t}" data-v="" class="${!pick ? 'on' : ''}">No flag</button>
    </div>` : '<p class="pill ok">This is your team</p>'}
    <h3>Season · ${season.n ? `${season.n} matches at ${season.meets} meet${season.meets === 1 ? '' : 's'}` : season.claimed ? 'pit survey only' : 'not scouted yet'}</h3>
    <div class="kpis">
      <div><b>${f1(season.est)}</b><span>est pts / match</span></div>
      <div><b>${season.lastEst != null ? f1(season.lastEst) : '–'} ${trendHTML(season.trend)}</b><span>last meet</span></div>
      <div><b>${f1(season.estAuto)}</b><span>AUTO pts</span></div>
      <div><b>${f1(season.made)}</b><span>HIVE/match</span></div>
      <div><b>${pct(season.acc)}</b><span>accuracy</span></div>
      <div><b>${f1(season.flower)}</b><span>FLOWER/match</span></div>
      <div><b>${pct(season.park)}</b><span>park</span></div>
      <div><b>${f1(season.foulPts)}</b><span>foul pts</span></div>
    </div>
    ${officialBlock(t, season)}
    ${(season.byEvent && season.byEvent.length) || meets.length ? `<h3>Meet by meet</h3><div class="tablewrap"><table class="tbl small">
      <thead><tr><th>Meet</th><th>Scouted</th><th>Est pts</th><th>HIVE</th><th>FLOWER</th><th>Park</th><th>Official rank</th></tr></thead>
      <tbody>${(() => {
        const codes = [...new Set([...meets.map(m => m.code), ...((season.byEvent || []).map(b => b.ev))])];
        const order = c2 => { const m = meets.find(x => x.code === c2); const i = sd.order.indexOf(c2); return m && m.date ? m.date : i >= 0 ? '9' + String(i).padStart(3, '0') : '9999'; };
        return codes.sort((a, b) => order(a).localeCompare(order(b))).map(code => {
          const b = (season.byEvent || []).find(x => x.ev === code);
          const m = meets.find(x => x.code === code);
          return `<tr><td>${esc(eventName(code))}</td><td>${b ? b.n : '–'}</td><td>${b ? f1(b.est) : '–'}</td><td>${b ? f1(b.made) : '–'}</td><td>${b ? f1(b.flower) : '–'}</td><td>${b ? pct(b.park) : '–'}</td>
            <td>${m ? `#${m.rank}${m.of ? ` of ${m.of}` : ''} · ${m.w}-${m.l}-${m.t}` : '–'}</td></tr>`;
        }).join('');
      })()}</tbody></table></div>` : ''}
    ${c ? `<h3>Fit with ${esc(S().ourTeam)}: <span class="score">${Math.round(c.score)}</span></h3>${partsBars(c)}
      ${c.odds ? `<p class="small">Together: ~${f1(c.odds.tips)} tips/match · SWARM ${pct(c.odds.pS)} · POLLINATOR 1 ${pct(c.odds.p4)} · POLLINATOR 2 ${pct(c.odds.p7)} · ≈${f1(c.odds.expRP)} bonus RP/match</p>` : ''}
      <ul class="notes">${c.notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
    ${p ? `<h3>Pit</h3><div class="pitgrid">
      <span>Drivetrain</span><b>${esc(LABELS.dt[p.dt] || '–')}</b>
      <span>Launcher</span><b>${esc(LABELS.ln[p.ln] || '–')}</b>
      <span>Role</span><b>${esc(LABELS.rl[p.rl] || '–')}</b>
      <span>Can</span><b>${[p.hv && 'HIVE', p.fl && 'FLOWER', p.fb && 'pull POLLEN', p.nc && 'NECTAR', p.vs && 'AprilTags'].filter(Boolean).join(', ') || '–'}</b>
      <span>Carries</span><b>${p.cap || '–'}</b>
      <span>AUTO</span><b>${p.aL} launches${p.aLv ? ', leaves' : ''}${p.aPk ? ', parks' : ''}${p.ast ? ' · starts ' + esc(p.ast) : ''}</b>
      <span>Notes</span><b>${esc(p.nt || '–')}</b>
      <span>Surveyed</span><b>${esc(eventName(p.ev))}</b>
    </div>` : ''}
    ${here.length ? `<h3>This meet · ${esc(ev.code)}</h3><div class="tablewrap"><table class="tbl small">
      <thead><tr><th>Match</th><th>Start</th><th>AUTO</th><th>TELEOP</th><th>FLOWER</th><th>Park</th><th>Fouls</th><th>Issues</th></tr></thead>
      <tbody>${here.map(o => `<tr><td><span class="dot ${o.al === 'R' ? 'red' : 'blue'}"></span>${o.mt}${o.scouts > 1 ? ` <small>(${o.scouts})</small>` : ''}</td>
        <td>${esc(o.st || '–')}</td><td>${f1(o.aM)}${o.lv >= 0.5 ? ' L' : ''}${o.aP >= 0.5 ? ' P' : ''}</td><td>${f1(o.tM)}/${f1(o.tM + o.tX)}</td>
        <td>${f1(o.fN)}N ${f1(o.fP)}P</td><td>${o.pk >= 0.5 ? '✓' : ''}</td><td>${o.mn || o.mj ? f1(o.mn) + '/' + f1(o.mj) : ''}${o.cd ? ' ' + LABELS.cd[o.cd] : ''}</td>
        <td>${o.ns >= 0.5 ? 'no show ' : ''}${[...(o.br || '')].map(x => LABELS.br[x]).join(', ')}</td></tr>`).join('')}</tbody></table></div>` : ''}
    ${seasonNotes.length ? `<h3>Scout notes</h3><ul class="notes">${seasonNotes.slice().reverse().map(o => `<li><b>${esc(o.ev)} M${o.mt}:</b> ${esc(o.nt)}</li>`).join('')}</ul>` : ''}
  `);
}

function partsBars(c) {
  const parts = [['role', 'Roles'], ['auto', 'AUTO'], ['rp', 'RP odds'], ['rel', 'Reliable']];
  return `<div class="bars">${parts.map(([k, l]) => `<div class="bar"><span>${l}</span><i><em style="width:${Math.round(c.parts[k] * 100)}%"></em></i><b>${Math.round(c.parts[k] * 100)}</b></div>`).join('')}</div>`;
}

// ---------------------------------------------------------------- SCHEDULE view (watch list)

// Distinct colours for watched teams (none are pure red or blue, which mean alliances here).
const TEAM_COLORS = ['#7c3aed', '#0f9d8a', '#e8590c', '#d6336c', '#5c940d', '#0b7285', '#a35200', '#5f3dc4', '#c2255c', '#2b8a3e'];

function watchList() {
  const s = S();
  const our = Number(s.ourTeam);
  const list = [];
  if (s.watchOurs !== false && our) list.push(our);
  for (const t of (s.watch || []).map(Number)) if (t && !list.includes(t)) list.push(t);
  return list;
}

function fmtTime(v) {
  if (!v) return '';
  const str = String(v);
  if (/(Z|[+-]\d\d:?\d\d)$/.test(str)) {
    const d = new Date(str);
    if (!isNaN(d)) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
  const m = str.match(/T(\d\d):(\d\d)/);
  if (!m) return '';
  let h = Number(m[1]);
  const ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${m[2]} ${ap}`; // FIRST gives local event time without a time zone
}

function fmtDay(v) {
  if (!v) return '';
  const m = String(v).match(/^(\d{4})-(\d\d)-(\d\d)/);
  if (!m) return '';
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).toLocaleDateString([], { weekday: 'short' });
}

function viewSchedule() {
  const ev = activeEvent();
  if (!ev) return `<section class="card"><p>Load an event first (Event tab).</p></section>`;
  const s = S();
  const our = Number(s.ourTeam);
  const watch = (s.watch || []).map(Number);
  const list = watchList();
  const color = {};
  list.forEach((t, i) => { color[t] = TEAM_COLORS[i % TEAM_COLORS.length]; });
  const W = new Set(list);
  const live = liveFor(ev.code);
  const L = (live && live.m) || {};
  const matches = (ev.matches || []).map(m => {
    const x = L[m.n] || {};
    return { n: m.n, r: m.r, b: m.b, time: x.time || null, actual: x.actual || null, rs: x.rs ?? null, bs: x.bs ?? null };
  });
  const played = m => m.rs !== null && m.bs !== null;
  const lastScouted = Math.max(0, ...eventRecords(ev.code, 'm').map(r => Number(r.mt) || 0));
  const haveResults = matches.some(played);
  const done = m => (haveResults ? played(m) : m.n <= lastScouted);
  const rows = matches.filter(m => [...m.r, ...m.b].some(t => W.has(t)));
  const nextN = (rows.find(m => !done(m)) || {}).n;
  const shown = ui.schedUpcoming ? rows.filter(m => !done(m)) : rows;
  const days = new Set(matches.map(m => String(m.time || '').slice(0, 10)).filter(Boolean));
  const when = m => (m.time ? `${days.size > 1 ? fmtDay(m.time) + ' ' : ''}${fmtTime(m.time)}` : '');

  const pos = (m, t) => (m.r.includes(t) ? `Red ${m.r.indexOf(t) + 1}` : m.b.includes(t) ? `Blue ${m.b.indexOf(t) + 1}` : '');
  const sideOf = (m, t) => (m.r.includes(t) ? 'R' : m.b.includes(t) ? 'B' : '');
  const result = (m, t) => {
    if (!played(m)) return '';
    const mine = sideOf(m, t) === 'R' ? m.rs : m.bs, theirs = sideOf(m, t) === 'R' ? m.bs : m.rs;
    return mine > theirs ? 'W' : mine < theirs ? 'L' : 'T';
  };
  const record = t => {
    const r = { W: 0, L: 0, T: 0 };
    for (const m of matches) if (sideOf(m, t) && played(m)) r[result(m, t)]++;
    return r;
  };
  const cell = t => {
    const w = W.has(t);
    const cls = ['st', w ? 'w' : '', !inScope(t, ev) ? 'other' : ''].join(' ');
    return `<button class="${cls}" ${w ? `style="--tc:${color[t]}"` : ''} data-act="team" data-team="${t}" title="${esc(teamName(t))}">${t}</button>`;
  };
  const tags = m => [...m.r, ...m.b].filter(t => W.has(t)).map(t => {
    const res = result(m, t);
    return `<span class="tres" style="--tc:${color[t]}"><i></i><b>${t}</b> ${pos(m, t)}${res ? ` <span class="wl ${res}">${res}</span>` : ''}</span>`;
  }).join('');
  const relation = (m, t) => (!our || t === our || !sideOf(m, our) ? '' : sideOf(m, t) === sideOf(m, our) ? 'with' : 'vs');

  const legend = list.map(t => {
    const ms = matches.filter(m => sideOf(m, t));
    const rec = record(t);
    const nxt = ms.find(m => !done(m));
    const at = t in (ev.teams || {}) || ms.length > 0;
    return `<div class="tcard" style="--tc:${color[t]}">
      <div class="tcard-h"><i></i><b>${t}</b> <span class="tname">${esc(teamName(t))}</span>${t === our ? ' <span class="pill">us</span>' : ''}</div>
      ${!at ? `<div class="muted small">Not at ${esc(ev.code)}</div>` : `
      <div class="small">${haveResults ? `Record here <b>${rec.W}-${rec.L}-${rec.T}</b> · ` : ''}${nxt ? `Next <b>Q${nxt.n}</b>${nxt.time ? ' at <b>' + when(nxt) + '</b>' : ''} · ${pos(nxt, t)}` : ms.length ? 'All matches done' : 'Not on the schedule yet'}</div>
      <div class="ms">${ms.map(m => { const r = result(m, t); const rel = relation(m, t); return `<span class="${sideOf(m, t) === 'R' ? 'r' : 'b'} ${done(m) ? 'done' : ''}" title="${pos(m, t)}${rel === 'with' ? ' · with us' : rel === 'vs' ? ' · against us' : ''}">Q${m.n}${r ? ` <small class="wl ${r}">${r}</small>` : ''}</span>`; }).join('')}</div>`}
    </div>`;
  }).join('');

  const pickable = Object.keys(ev.teams || {}).map(Number).filter(t => t !== our && inScope(t, ev)).sort((a, b) => a - b);
  const o = state.official;
  const liveStatus = official.liveBusy ? 'Updating…' : live ? `Times${haveResults ? ' & results' : ''} from ${esc(live.src)} · updated ${ago(live.at)}` : o.liveErr ? esc(o.liveErr) : 'Times and results not loaded yet';

  return `
  <section class="card">
    <h2>Teams I'm watching</h2>
    <div class="chips watchchips">
      ${our ? `<label class="check chip ${s.watchOurs !== false ? 'on wchip' : ''}" ${s.watchOurs !== false ? `style="--tc:${color[our]}"` : ''}><input type="checkbox" data-change="watchOurs" ${s.watchOurs !== false ? 'checked' : ''}> <b>${our}</b>&nbsp;(our team)</label>` : ''}
      ${watch.filter(t => t !== our).map(t => `<button class="chip wchip" style="--tc:${color[t]}" data-act="watchToggle" data-team="${t}" title="Stop watching"><b>${t}</b> ${esc(teamName(t))}<span class="x">✕</span></button>`).join('')}
      ${!watch.length && !our ? '<span class="muted">No teams yet. Add some below.</span>' : ''}
    </div>
    <div class="row">
      <input id="watchInput" data-ui="watchInput" value="${esc(ui.watchInput || '')}" placeholder="Add team numbers, e.g. 12345, 23456" inputmode="numeric" autocomplete="off">
      <button class="primary" data-act="watchAdd">Add</button>
      <button data-act="watchPick">${ui.watchPick ? 'Done picking' : `Pick from ${esc(ev.code)}`}</button>
      ${watch.length ? '<button class="ghost danger" data-act="watchClear">Clear</button>' : ''}
    </div>
    ${ui.watchPick ? `<div class="chips">${pickable.map(t => `<button class="chip ${watch.includes(t) ? 'on' : ''}" data-act="watchToggle" data-team="${t}"><b>${t}</b> ${esc(teamName(t))}</button>`).join('')}</div>` : ''}
  </section>

  ${list.length ? `<section class="card">
    <h2>Schedule · ${esc(ev.name)}</h2>
    <div class="row sched-bar">
      <button data-act="refreshLive" ${official.liveBusy ? 'disabled' : ''}>Update times &amp; results</button>
      <span class="muted small">${liveStatus}</span>
    </div>
    ${!matches.length ? `<p class="banner warn">There's no match schedule for ${esc(ev.code)} yet. It's usually posted shortly before qualification matches start. Tap <b>Update times &amp; results</b> once it's out, or type it in with <b>Edit teams &amp; schedule</b> on the Event tab.</p>` : `
    <div class="tcards">${legend}</div>
    <label class="check"><input type="checkbox" data-change="schedUpcoming" ${ui.schedUpcoming ? 'checked' : ''}> Hide finished matches</label>
    ${shown.length ? `<div class="tablewrap"><table class="tbl sched">
      <thead><tr><th>Match</th><th>Time</th><th>Red</th><th>Blue</th><th>Score</th><th>Our teams</th></tr></thead>
      <tbody>${shown.map(m => `<tr class="${done(m) ? 'done' : ''} ${m.n === nextN ? 'next' : ''}">
        <td class="mn">Q${m.n}${m.n === nextN ? ' <span class="pill ok">next</span>' : ''}</td>
        <td class="tm">${when(m) || '–'}</td>
        <td class="side red">${m.r.map(cell).join('')}</td>
        <td class="side blue">${m.b.map(cell).join('')}</td>
        <td class="scorecell">${played(m) ? `<span class="${m.rs > m.bs ? 'win' : ''} r">${m.rs}</span>–<span class="${m.bs > m.rs ? 'win' : ''} b">${m.bs}</span>` : ''}</td>
        <td>${tags(m)}</td>
      </tr>`).join('')}</tbody></table></div>` : `<p class="muted">${rows.length ? 'All of these matches are finished.' : 'None of these teams are on the schedule.'}</p>`}
    <p class="muted small">Each watched team keeps its own colour. W/L/T and scores come from official results. Tap any team number for its stats.</p>`}
  </section>` : ''}`;
}

// ---------------------------------------------------------------- LEAGUE view (whole season)

const fmtDate = d => (d ? new Date(d + 'T12:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '');
const fmtRange = e => (!e || !e.start ? '' : e.end && e.end !== e.start ? `${fmtDate(e.start)}–${fmtDate(e.end)}` : fmtDate(e.start));
function evWhen(e) { return !e ? '' : isOn(e) ? 'happening today' : isOver(e) ? `finished ${fmtRange(e)}` : e.start ? fmtRange(e) : 'date not posted'; }

function meetsIn(meets, team) {
  const out = [];
  for (const m of meets || []) {
    const r = (m.rankings || []).find(x => x.team === Number(team));
    if (r) out.push({ code: m.code, name: m.name, date: m.date, ...r, of: (m.rankings || []).length });
  }
  return out;
}

function leagueErrText(e) {
  if (!e) return '';
  if (e === 'nokey') return 'Other leagues need your FTC Events API key in the Google Sheet script (README section 6).';
  if (e === 'nocloud') return 'Other leagues come from FIRST through the Google Sheet backup. Set that up on the Sync tab first.';
  return e;
}

function viewLeague() {
  const info = stageInfo();
  const body = info.stage === 'region' ? regionStage(info) : info.stage === 'worlds' ? worldsStage(info) : leagueStage(info);
  return `<section class="card leaguecard">${stageBar(info)}${body}</section>`;
}

function stageBar(info) {
  const b = (v, label) => `<button data-act="lstage" data-v="${v}" class="${info.stage === v ? 'on' : ''}">${label}${info.auto === v ? ' <small>· now</small>' : ''}</button>`;
  return `<div class="stagebar">
    <div class="seg stages">${b('league', 'League')}${b('region', 'Region')}${b('worlds', 'Worlds')}</div>
    <p class="muted small">${info.manual
      ? `Showing ${{ league: 'the league', region: 'the region championship', worlds: 'worlds' }[info.stage]} because you picked it. <button class="linkbtn" data-act="lstage" data-v="auto">Follow the season automatically</button>`
      : esc(autoWhy(info))}</p>
  </div>`;
}

function autoWhy(info) {
  const lt = info.lts[0], c = info.champ;
  if (info.auto === 'worlds') return `${c && isOver(c) ? c.name + ' is finished, so this' : 'This'} shows only the teams at the FIRST Championship. It switched on its own.`;
  if (info.auto === 'region') return `${info.ltDone ? 'The League Tournament is finished, so this' : 'This'} shows only the teams that advanced to ${c.name}. It switched on its own.`;
  if (info.ltDone) return 'The League Tournament is finished. This switches to the region championship on its own as soon as FIRST posts who advanced.';
  return `League season. After the League Tournament${lt && lt.start ? ` (${fmtRange(lt)})` : ''} this switches on its own to only the teams that advanced to the region championship, then to worlds.`;
}

function updateLine(info, err) {
  const at = viewUpdated(info);
  const live = viewLive(info);
  const src = viewSource(info);
  const busy = official.viewBusy || official.busy;
  const o = state.official;
  const offline = navigator.onLine === false;
  return `<div class="updline">
    <span class="small ${busy ? 'busy' : 'muted'}">${busy ? esc(official.viewProgress || official.progress || 'Updating…')
      : `${at ? `Updated ${ago(at)}${src ? ' from ' + esc(src) : ''}` : 'Not downloaded yet'} · ${offline ? 'offline, showing the last download' : `checks for new results every ${live ? '5 minutes (event today)' : '30 minutes'} while this tab is open`}`}</span>
    <button data-act="refreshView" ${busy || offline ? 'disabled' : ''}>Update now</button>
  </div>
  ${err ? `<p class="banner warn">${esc(err)}</p>` : ''}
  ${o.scoutErr && S().show.opr && !busy ? `<p class="muted small">FTCScout OPR: ${esc(o.scoutErr)}</p>` : ''}`;
}

function leagueStage(info) {
  const lv = leagueView();
  const choices = leagueChoices();
  const picker = choices.length > 1 ? `<label class="inline lpick">League
      <select data-change="lleague">${choices.map(l => `<option value="${esc(l.ours ? '' : l.code)}" ${(lv.ours ? l.ours : l.code === lv.code) ? 'selected' : ''}>${esc(l.name)}${l.ours ? ' (ours)' : l.parent ? ' (whole region)' : ''}</option>`).join('')}</select></label>` : '';
  if (lv.ours && !Object.keys(lv.teams).length) {
    return `${picker}<h2>League</h2>
      <p>Tell the app who is in your league, and this tab will follow every league team across all your meets, next to FIRST's league rankings and FTCScout's numbers.</p>
      <button class="primary" data-act="tab" data-tab="event">Set up our league (Event tab)</button>
      ${updateLine(info, '')}`;
  }
  const rows = Object.keys(lv.teams).map(Number).filter(Boolean).map(t => ({ t, name: lv.teams[t] || teamName(t), r: lv.rankings[t] || null, m: meetsIn(lv.meets, t) }));
  const nMeets = (lv.meets || []).length;
  const err = lv.ours ? firstStatusText() : leagueErrText(lv.err);
  return `${picker}
    <h2>${esc(lv.name || 'Our league')} · season</h2>
    <p class="muted small">${rows.length} teams · ${nMeets} meet${nMeets === 1 ? '' : 's'} so far${lv.ours ? '' : ' · not our league'}</p>
    ${updateLine(info, err)}
    ${seasonTable(rows, { rankLabel: 'League rank', meetsLabel: 'Meet results' })}
    <p class="muted small">Scouted, Season est and Last meet are what your scouts recorded (every scout and every meet combined). ▲▼ compares the last meet with earlier meets. OPR comes from FTCScout; league rank, ranking score (RS), W-L-T and meet results come from FIRST when its key is set up (FTCScout otherwise). Tap a team for meet-by-meet detail.</p>`;
}

function stageErr(info) {
  const c = info.cal || {};
  if (c.err && !c.at) return c.err;
  if (c.note === 'old') return 'Championship lists are coming from FTCScout, which only knows the events our own team is in. Update the Google Sheet script (README section 7) to get the full lists from FIRST.';
  return c.err || '';
}

function findEventUI(kind) {
  const res = ui.lfindRes || [];
  const picked = lview()[kind];
  return `<div class="findev">
    <p class="small">${kind === 'champ' ? 'Find the region championship' : 'Find the FIRST Championship'} on FTCScout:</p>
    <div class="row"><input id="lfindText" placeholder="${kind === 'champ' ? 'e.g. Kansas Missouri Championship' : 'e.g. FIRST Championship'}" value="${esc(ui.lfindText || '')}" autocomplete="off">
      <button data-act="lfindGo" data-v="${kind}">Search</button></div>
    ${ui.lfindBusy ? '<p class="busy">Searching…</p>' : ''}
    ${res.length ? `<div class="list">${res.map(e => `<button class="listitem" data-act="lpick" data-v="${kind}" data-code="${esc(e.code)}"><b>${esc(e.code)}</b> ${esc(e.name)} <span class="muted small">${esc(String(e.start || '').slice(0, 10))}</span></button>`).join('')}</div>` : ''}
    ${picked ? `<button class="ghost" data-act="lpick" data-v="${kind}" data-code="">Use the automatic choice again</button>` : ''}
  </div>`;
}

function regionStage(info) {
  const c = info.champ;
  const our = Number(S().ourTeam);
  if (!c) {
    return `<h2>Region championship</h2>
      <p>${state.official.stage ? 'No region championship found for your region yet.' : 'The championship list hasn\'t been downloaded yet.'} Once FIRST posts it, this shows only the teams that advanced from the league tournaments.</p>
      ${updateLine(info, stageErr(info))}${findEventUI('champ')}`;
  }
  const picker = info.champs.length > 1 ? `<label class="inline lpick">Championship
      <select data-change="lchamp">${info.champs.map(x => `<option value="${esc(x.code)}" ${x.code === c.code ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></label>` : '';
  const ranks = {};
  for (const r of c.rankings || []) ranks[r.team] = r;
  const lo = (info.cal && info.cal.leagueOf) || {};
  const names = Object.fromEntries(leagueChoices().map(l => [l.code, l.name]));
  const ourCode = ourLeagueCode();
  const rows = (c.teams || []).map(x => {
    const from = lo[x.n] || (state.league && state.league.teams && x.n in state.league.teams ? ourCode || 'ours' : '');
    return { t: x.n, name: x.name || teamName(x.n), from, fromTitle: names[from] || '', r: ranks[x.n] || null, m: seasonMeetsFor(x.n) };
  });
  const fromOurs = rows.filter(r => state.league && state.league.teams && r.t in state.league.teams).length;
  const weIn = rows.some(r => r.t === our);
  return `${picker}
    <h2>${esc(c.name)}</h2>
    <p class="muted small">${rows.length} team${rows.length === 1 ? '' : 's'} advanced · ${esc(evWhen(c))}${hasLeague() ? ` · ${fromOurs} from ${esc(state.league.name || 'our league')}` : ''}${our ? weIn ? ` · ${our} is in` : ` · ${our} is not on the list` : ''}</p>
    ${updateLine(info, stageErr(info))}
    ${seasonTable(rows, { rankLabel: 'Champ rank', from: 'League', meetsLabel: 'Season results' })}
    <p class="muted small">Only teams on FIRST's team list for this championship are shown; teams that didn't advance are left out. The list fills in as each league tournament finishes. Champ rank, RS and W-L-T appear once matches start. Season results are each team's earlier events (FTCScout).</p>
    <button class="linkbtn" data-act="lfind" data-v="champ">Not the right championship?</button>
    ${ui.lfind === 'champ' ? findEventUI('champ') : ''}`;
}

function worldsStage(info) {
  const f = info.fam;
  const our = Number(S().ourTeam);
  if (!f || !info.wTeams.length) {
    return `<h2>FIRST Championship</h2>
      <p>${f ? `FIRST hasn't posted who is going to ${esc(f.parent.name)} yet.` : state.official.stage ? 'No FIRST Championship found yet.' : 'The championship list hasn\'t been downloaded yet.'} Once it does, this shows only the teams that advanced to worlds.</p>
      ${updateLine(info, stageErr(info))}${findEventUI('worlds')}`;
  }
  const divs = f.divs.filter(d => (d.teams || []).length);
  const mine = info.wTeams.find(t => t.n === our);
  const divSel = divs.length ? `<div class="seg divs">
      <button data-act="ldiv" data-v="all" class="${!info.div ? 'on' : ''}">All divisions</button>
      ${divs.map(d => `<button data-act="ldiv" data-v="${esc(d.code)}" class="${info.div === d.code ? 'on' : ''}">${esc(divLabel(d, f.parent))}${mine && mine.div === d.code ? ' ★' : ''}</button>`).join('')}
    </div>` : '';
  const shown = info.wTeams.filter(t => !info.div || t.div === info.div);
  const rows = shown.map(x => ({ t: x.n, name: x.name || teamName(x.n), from: x.home, div: x.divName, r: x.r, m: seasonMeetsFor(x.n) }));
  const curDiv = info.div ? divs.find(d => d.code === info.div) : null;
  const when = curDiv || f.divs.find(d => d.start) || f.parent;
  return `<h2>${esc(f.parent.name)}${curDiv ? ' · ' + esc(divLabel(curDiv, f.parent)) : ''}</h2>
    <p class="muted small">${info.wTeams.length} teams at worlds${curDiv ? ` · ${rows.length} in this division` : ''} · ${esc(evWhen(when))}${our ? mine ? ` · ${our} is in${mine.divName ? ' ' + esc(mine.divName) : ''}` : ` · ${our} is not on the list` : ''}</p>
    ${divSel}
    ${updateLine(info, stageErr(info))}
    ${seasonTable(rows, { rankLabel: divs.length ? 'Div rank' : 'Rank', from: 'From', div: !curDiv && divs.length > 0, meetsLabel: 'Season results' })}
    <p class="muted small">Only teams on FIRST's team list for worlds are shown. Div rank, RS and W-L-T are from each team's own division once matches start. "From" is the team's home region. Season results are each team's earlier events (FTCScout)${shown.length > 80 ? '; with all divisions shown they load 80 teams at a time' : ''}.</p>
    <button class="linkbtn" data-act="lfind" data-v="worlds">Not the right event?</button>
    ${ui.lfind === 'worlds' ? findEventUI('worlds') : ''}`;
}

// One season table for every League tab view. rows: [{ t, name, from?, div?, r: rank|null, m: [meet results] }]
function seasonTable(input, opts = {}) {
  const sd = computeSeason();
  const sh = S().show;
  const our = Number(S().ourTeam);
  const q = (ui.lfilter || '').trim().toLowerCase();
  let rows = input.map(x => {
    const st = seasonStats(x.t, sd, false);
    const op = oprFor(x.t), r = x.r;
    const has = st.n > 0;
    return {
      ...x, st, op,
      v: {
        team: x.t, from: x.from || null, div: x.div || null, n: st.n, est: has || st.claimed ? st.est : null, last: has ? st.lastEst : null, trend: has ? st.trend : null,
        made: has ? st.made : null, flower: has ? st.flower : null, park: has ? st.park : null, foul: has ? st.foulPts : null, broke: has ? st.broke : null,
        opr: op ? op.tot : null, oprAuto: op ? op.auto : null, gap: op && has ? st.est - op.tot : null,
        rank: r ? r.rank : null, rs: r ? r.rs : null, wins: r ? r.w : null,
      },
    };
  });
  if (q) rows = rows.filter(x => String(x.t).includes(q) || String(x.name || '').toLowerCase().includes(q) || String(x.from || '').toLowerCase().includes(q));
  const { k, d } = ui.lsort;
  rows.sort((a, b) => {
    const av = a.v[k], bv = b.v[k];
    if (av == null && bv == null) return a.t - b.t;
    if (av == null) return 1;
    if (bv == null) return -1;
    const c = typeof av === 'string' ? String(av).localeCompare(String(bv)) : av - bv;
    return c * d || a.t - b.t;
  });
  const th = (key, label, title = '') => `<th data-act="lsort" data-k="${key}" class="${k === key ? 'sorted' : ''}" ${title ? `title="${esc(title)}"` : ''}>${label}${k === key ? (d < 0 ? ' ▼' : ' ▲') : ''}</th>`;
  const nScouted = rows.filter(x => x.st.n).length;
  return `
    <div class="official-bar">
      <span class="flabel">Official data</span>
      <div class="flags">
        <button class="toggle ${sh.opr ? 'on' : ''}" data-act="show" data-k="opr">${sh.opr ? '✓ ' : ''}FTCScout OPR</button>
        <button class="toggle ${sh.rank ? 'on' : ''}" data-act="show" data-k="rank">${sh.rank ? '✓ ' : ''}Rankings</button>
        <button class="toggle ${sh.meets ? 'on' : ''}" data-act="show" data-k="meets">${sh.meets ? '✓ ' : ''}${esc(opts.meetsLabel || 'Meet results')}</button>
      </div>
    </div>
    <div class="row"><input data-ui="lfilter" data-change="lfilter" value="${esc(ui.lfilter || '')}" placeholder="Filter by number or name" autocomplete="off"></div>
    <p class="muted small">${rows.length} team${rows.length === 1 ? '' : 's'} · ${nScouted} with our scouting data</p>
    <div class="tablewrap"><table class="tbl league">
      <thead><tr>
        ${th('team', 'Team')}${opts.div ? th('div', 'Division') : ''}${opts.from ? th('from', esc(opts.from)) : ''}${th('n', 'Scouted')}${th('est', 'Season est', 'Average points per match our scouts saw, all meets')}${th('last', 'Last meet', 'Average at the most recent meet we scouted them, with trend vs earlier meets')}
        ${th('made', 'HIVE/m')}${th('flower', 'FLOWER/m')}${th('park', 'Park')}${th('foul', 'Foul pts')}${th('broke', 'Breakdowns')}
        ${sh.opr ? `${th('opr', 'OPR', 'FTCScout: points added per match, from official scores')}${th('oprAuto', 'AUTO OPR')}${th('gap', 'Scouts − OPR', 'Positive: our scouts saw more than OPR. Negative: less.')}` : ''}
        ${sh.rank ? `${th('rank', esc(opts.rankLabel || 'Rank'))}${th('rs', 'RS', 'Ranking score')}${th('wins', 'W-L-T')}` : ''}
        ${sh.meets ? `<th>${esc(opts.meetsLabel || 'Meet results')}</th>` : ''}
      </tr></thead>
      <tbody>${rows.map(x => {
        const st = x.st, v = x.v;
        return `<tr data-act="team" data-team="${x.t}" class="${x.t === our ? 'ours' : ''} ${getPick(x.t)}">
          <td><b>${x.t}</b> <span class="tname">${esc(x.name || '')}</span> ${flagIcon(x.t)}</td>
          ${opts.div ? `<td>${esc(x.div || '–')}</td>` : ''}
          ${opts.from ? `<td ${x.fromTitle ? `title="${esc(x.fromTitle)}"` : ''}>${esc(x.from || '–')}</td>` : ''}
          <td>${st.n ? `${st.n} <small class="muted">(${st.meets})</small>` : st.claimed ? 'pit' : '–'}</td>
          <td><b>${f1(v.est)}</b></td>
          <td>${v.last != null ? f1(v.last) : '–'} ${trendHTML(v.trend)}</td>
          <td>${f1(v.made)}</td><td>${f1(v.flower)}</td><td>${v.park != null ? pct(v.park) : '–'}</td><td>${f1(v.foul)}</td><td>${v.broke != null ? pct(v.broke) : '–'}</td>
          ${sh.opr ? `<td>${f1(v.opr)}</td><td>${f1(v.oprAuto)}</td><td>${gapHTML(v.gap)}</td>` : ''}
          ${sh.rank ? `<td>${x.r ? '#' + x.r.rank : '–'}</td><td>${x.r ? f2(x.r.rs) : '–'}</td><td>${x.r ? `${x.r.w}-${x.r.l}-${x.r.t}` : '–'}</td>` : ''}
          ${sh.meets ? `<td class="mres">${x.m && x.m.length ? x.m.map(m => `<span class="mr" title="${esc(m.name)}">#${m.rank} <small>${m.w}-${m.l}-${m.t}</small></span>`).join('') : '–'}</td>` : ''}
        </tr>`;
      }).join('')}</tbody>
    </table></div>`;
}

// ---------------------------------------------------------------- PARTNERS view

function viewPartners() {
  const s = S();
  const our = Number(s.ourTeam);
  if (!our) {
    return `<section class="card"><h2>Which team are you?</h2>
      <label>Our team number<input data-set="ourTeam" data-type="int" inputmode="numeric" placeholder="e.g. 12345"></label>
      <button class="primary" data-act="rerender">Continue</button></section>`;
  }
  const { ev, stats: evStats, hidden } = computeEvent();
  if (!ev) return `<section class="card"><p>Load an event first.</p></section>`;
  const sd = computeSeason();
  const us = ourStats(sd);
  const cands = evStats.filter(x => x.team !== our).map(x => seasonStats(x.team, sd, true));
  const ctx = eventContext(cands);
  const usHas = us && (us.n || us.claimed);
  let list = cands.map(t => ({ t, c: compatibility(us, t, ctx, s) }));
  if (ui.hideDnp) list = list.filter(x => getPick(x.t.team) !== 'dnp');
  list.sort((a, b) => b.c.score - a.c.score);
  const withData = list.filter(x => x.c.conf !== 'none');
  const noData = list.filter(x => x.c.conf === 'none');
  const w = s.weights;
  return `
  <section class="card">
    <h2>Your robot · ${our}</h2>
    ${usHas ? `<div class="kpis">
        <div><b>${us.n || 'pit'}</b><span>matches this season</span></div>
        <div><b>${f1(us.est)}</b><span>est pts</span></div>
        <div><b>${f1(us.made)}</b><span>HIVE/match</span></div>
        <div><b>${f1(us.flower)}</b><span>FLOWER/match</span></div>
        <div><b>${pct(us.leave)}</b><span>leave</span></div>
        <div><b>${pct(us.park)}</b><span>park</span></div>
      </div>` :
      `<p class="banner warn">No data for team ${our} yet. Scout your own matches like any other team, or fill in a pit entry for ${our}, so the app knows what kind of partner you need.</p>`}
    <p class="muted small">Ranks the ${cands.length} teams at ${esc(ev.code)}${hidden ? ' in your league' : ''} using each team's whole season of scouting, with their latest meet counting most. Alliance selection happens at the League Tournament; at regular meets partners are assigned at random.</p>
  </section>
  <section class="card">
    <h2>What matters most</h2>
    <div class="weights">
      ${[['role', 'Complementary roles'], ['auto', 'AUTO doesn\'t collide'], ['rp', 'Ranking-point odds'], ['rel', 'Reliability & clean play']].map(([k, l]) =>
        `<label>${l}<input type="range" min="0" max="50" step="5" value="${w[k]}" data-w="${k}"><output id="w_${k}">${w[k]}</output></label>`).join('')}
    </div>
    <label class="check"><input type="checkbox" data-change="hideDnp" ${ui.hideDnp ? 'checked' : ''}> Hide teams flagged ✕ Avoid</label>
  </section>
  <section class="plist">
    ${withData.map((x, i) => partnerCard(x, i + 1)).join('') || '<div class="card"><p class="muted">No scouting data for other teams yet.</p></div>'}
  </section>
  ${noData.length ? `<section class="card"><h2>Not scouted yet (${noData.length})</h2><div class="chips">${noData.map(x =>
    `<button class="chip" data-act="team" data-team="${x.t.team}"><b>${x.t.team}</b> ${esc(teamName(x.t.team))}${oprFor(x.t.team) ? ` <small class="muted">OPR ${f1(oprFor(x.t.team).tot)}</small>` : ''}</button>`).join('')}</div></section>` : ''}`;
}

function partnerCard({ t, c }, rank) {
  const confTxt = { good: 'solid data', some: 'some data', low: '1 match', pit: 'pit only' }[c.conf] || '';
  const op = oprFor(t.team), r = rankFor(t.team);
  return `<button class="card pcard ${getPick(t.team)}" data-act="team" data-team="${t.team}">
    <div class="prank">${rank}</div>
    <div class="pmain">
      <div class="ptitle"><b>${t.team}</b> ${esc(teamName(t.team))} ${flagIcon(t.team)}<span class="pill ${c.conf}">${confTxt}${t.n ? ' · n=' + t.n : ''}</span>
        ${op ? `<span class="pill">OPR ${f1(op.tot)}</span>` : ''}${r ? `<span class="pill">League #${r.rank}</span>` : ''}</div>
      ${partsBars(c)}
      <div class="small muted">${c.odds ? `Together ≈ ${f1(c.odds.tips)} tips · SWARM ${pct(c.odds.pS)} · 4 tips ${pct(c.odds.p4)} · 7 tips ${pct(c.odds.p7)}` : ''}
        ${c.notes.length ? '<br>' + c.notes.slice(0, 3).map(esc).join(' · ') : ''}</div>
    </div>
    <div class="pscore">${Math.round(c.score)}</div>
  </button>`;
}

// ---------------------------------------------------------------- actions

const actions = {
  tab: el => { closeModal(); go(el.dataset.tab); },
  rerender: () => render(),
  closeModal: () => closeModal(),
  applyUpdate: () => {
    if (ui.waitingSW) ui.waitingSW.postMessage('skipWaiting');
    else location.reload();
  },

  // Event
  evSrc: el => { ui.evSrc = el.dataset.v; ui.found = []; render(); },
  findMine: async () => {
    if (!S().ourTeam) return toast('Enter your team number above first.', 'err');
    ui.busy = 'Looking up events…'; render();
    try {
      ui.found = await ftcscoutTeamEvents(S().season, S().ourTeam);
      ui.busy = ui.found.length ? '' : `No ${S().season} events found for team ${S().ourTeam} on FTCScout.`;
    } catch (e) { ui.busy = ''; toast(friendlyError(e), 'err'); }
    render();
  },
  searchEv: async () => {
    const q = ($('#evSearch') || {}).value || '';
    if (!q.trim()) return toast('Type part of an event name or city.');
    ui.busy = 'Searching…'; render();
    try {
      ui.found = await ftcscoutSearch(S().season, q.trim());
      ui.busy = ui.found.length ? '' : 'No events matched.';
    } catch (e) { ui.busy = ''; toast(friendlyError(e), 'err'); }
    render();
  },
  dlScout: async el => {
    const code = (el.dataset.code || ($('#evCode') || {}).value || '').trim();
    if (!code) return toast('Enter an event code.');
    ui.busy = `Downloading ${code.toUpperCase()} from FTCScout…`; render();
    try {
      const ev = await ftcscoutEvent(S().season, code);
      saveEvent(ev);
      ui.found = []; ui.busy = ''; ui.mf = null; ui.pf = null;
      toast(`${ev.code}: ${Object.keys(ev.teams).length} teams, ${ev.matches.length} matches`, 'ok');
    } catch (e) { ui.busy = ''; toast(friendlyError(e), 'err'); }
    render();
  },
  refreshEvent: async () => {
    const ev = activeEvent();
    if (!ev) return;
    ui.busy = 'Refreshing…';
    try {
      const fresh = await ftcscoutEvent(ev.season || S().season, ev.code);
      saveEvent(fresh);
      toast(`Updated: ${Object.keys(fresh.teams).length} teams, ${fresh.matches.length} matches`, 'ok');
    } catch (e) { toast(friendlyError(e), 'err'); }
    ui.busy = ''; render();
  },
  dlFirst: async () => {
    const code = (($('#evCodeFirst') || {}).value || '').trim();
    if (!code) return toast('Enter an event code.');
    ui.busy = 'Contacting FIRST…'; render();
    try {
      const ev = await firstApiEvent(S(), code);
      saveEvent(ev);
      ui.mf = null; ui.pf = null;
      toast(`${ev.code}: ${Object.keys(ev.teams).length} teams, ${ev.matches.length} matches`, 'ok');
    } catch (e) { toast(friendlyError(e), 'err'); }
    ui.busy = ''; render();
  },
  saveManual: () => {
    try {
      const ev = manualEvent($('#mCode').value, $('#mName').value, S().season, $('#mTeams').value, $('#mSched').value);
      const prev = state.events[ev.code];
      if (prev && ui.editEvent) { ev.src = prev.src === 'Manual' ? 'Manual' : prev.src + ' + edits'; ev.season = prev.season; }
      saveEvent(ev);
      ui.editEvent = false; ui.mf = null; ui.pf = null;
      toast(`Saved ${ev.code}: ${Object.keys(ev.teams).length} teams, ${ev.matches.length} matches`, 'ok');
      render();
    } catch (e) { toast(e.message, 'err'); }
  },
  editEvent: () => { ui.editEvent = true; render(); },
  cancelEdit: () => { ui.editEvent = false; render(); },
  deleteEvent: () => {
    const ev = activeEvent();
    if (!ev) return;
    const n = eventRecords(ev.code).length;
    if (!confirm(`Remove event ${ev.code} from this iPad?${n ? ` Its ${n} scouting records stay saved (they come back if you load the event again).` : ''}`)) return;
    delete state.events[ev.code];
    state.settings.activeEvent = Object.keys(state.events)[0] || '';
    persist('events', 'settings');
    ui.mf = null; ui.pf = null;
    render();
  },
  sendEvent: () => {
    const ev = activeEvent();
    if (!ev) return;
    showQR(`Event ${ev.code}`, { k: 'evt', d: ev, c: cloudCfgForQR(), l: hasLeague() ? state.league : null });
  },
  team: el => teamModal(Number(el.dataset.team)),
  setPosition: el => {
    state.settings.slot = el.dataset.v;
    persist('settings');
    if (ui.mf && !ui.mf.id) applySlot(ui.mf);
    logShift();
    render();
  },
  newScout: () => { ui.newScout = true; render(); setTimeout(() => { const i = $('#newScoutName'); if (i) i.focus(); }, 50); },
  cancelNewScout: () => { ui.newScout = false; render(); },
  startScout: () => {
    const name = (($('#newScoutName') || {}).value || '').trim();
    if (!name) return toast("Enter the scout's name.", 'err');
    state.settings.scoutName = name;
    persist('settings');
    ui.newScout = false;
    logShift();
    toast(`${name} is scouting${S().slot ? ' ' + posLabel(S().slot) : ''}`, 'ok');
    render();
  },
  meetView: el => { ui.meetView = el.dataset.v; render(); },
  watchToggle: el => {
    const t = Number(el.dataset.team);
    const list = (S().watch || []).map(Number);
    state.settings.watch = list.includes(t) ? list.filter(x => x !== t) : [...list, t];
    persist('settings');
    render();
  },
  watchAdd: () => {
    const nums = String(ui.watchInput || ($('#watchInput') || {}).value || '').match(/\d{1,6}/g) || [];
    if (!nums.length) return toast('Type one or more team numbers.', 'err');
    const list = (S().watch || []).map(Number);
    const add = nums.map(Number).filter(t => t && !list.includes(t));
    state.settings.watch = [...list, ...add];
    persist('settings');
    ui.watchInput = '';
    toast(add.length ? `Watching ${add.join(', ')}` : 'Already watching those teams', 'ok');
    render();
  },
  watchPick: () => { ui.watchPick = !ui.watchPick; render(); },
  refreshLive: async () => {
    if (!navigator.onLine) return toast('This iPad is offline. Showing the last download.', 'err');
    const p = refreshLive(activeEvent(), { force: true });
    render();
    await p;
    if (state.official.liveErr) toast(state.official.liveErr, 'err');
    render();
  },
  watchClear: () => {
    if (!confirm('Stop watching all teams?')) return;
    state.settings.watch = [];
    persist('settings');
    render();
  },
  scope: el => {
    const ev = activeEvent();
    if (!ev) return;
    ev.scope = el.dataset.v;
    ev.upd = Date.now();
    persist('events');
    syncSoon();
    ui.mf = null; ui.pf = null;
    render();
  },
  leagueFromFirst: async () => {
    if (!cloudConfigured()) return toast('FIRST data comes through the Google Sheet backup. Set it up on the Sync tab first.', 'err');
    if (!Number(S().ourTeam)) return toast('Enter your team number first.', 'err');
    if (!navigator.onLine) return toast('This iPad is offline.', 'err');
    const p = refreshOfficial({ force: true, replaceRoster: true });
    render();
    await p;
    const e = state.official.firstErr;
    if (e) toast(firstStatusText(), 'err');
    else toast(`League roster: ${Object.keys((state.league && state.league.teams) || {}).length} teams from FIRST`, 'ok');
    syncSoon();
    render();
  },
  leagueAddEvent: () => {
    const ev = activeEvent();
    if (!ev) return;
    const L = state.league || { name: '', teams: {}, src: 'meets' };
    const before = Object.keys(L.teams).length;
    const teams = { ...L.teams };
    for (const [t, n] of Object.entries(ev.teams)) teams[t] = teams[t] || n || '';
    saveLeague({ ...L, teams, src: L.src === 'FIRST' ? 'manual' : (L.src || 'meets'), upd: Date.now() });
    toast(`Added ${Object.keys(teams).length - before} teams to the league list`, 'ok');
    syncSoon();
    render();
  },
  leagueEdit: () => { ui.leagueEdit = true; render(); },
  leagueCancel: () => { ui.leagueEdit = false; render(); },
  leagueSave: () => {
    const teams = parseTeams($('#lgTeams').value);
    if (!Object.keys(teams).length) return toast('Add at least one team number.', 'err');
    const L = state.league || {};
    saveLeague({ ...L, name: $('#lgName').value.trim() || L.name || 'Our league', teams, src: 'manual', upd: Date.now() });
    ui.leagueEdit = false;
    toast(`League saved: ${Object.keys(teams).length} teams`, 'ok');
    syncSoon();
    render();
  },
  leagueClear: () => {
    if (!confirm('Clear the league list? All events will show every team until you set it again.')) return;
    saveLeague({ name: '', teams: {}, src: 'manual', upd: Date.now() });
    syncSoon();
    render();
  },
  show: el => {
    const k = el.dataset.k;
    state.settings.show = { ...S().show, [k]: !S().show[k] };
    persist('settings');
    render();
  },
  refreshOfficial: async () => {
    if (!navigator.onLine) return toast('This iPad is offline. Showing the last download.', 'err');
    const p = refreshOfficial({ force: true });
    render();
    await p;
    render();
  },
  refreshView: async () => {
    if (!navigator.onLine) return toast('This iPad is offline. Showing the last download.', 'err');
    const p = refreshView({ force: true });
    render();
    await p;
    render();
  },
  lstage: el => {
    setLview({ stage: el.dataset.v });
    ui.lfind = null;
    render();
    refreshView();
  },
  ldiv: el => {
    setLview({ div: el.dataset.v });
    render();
    refreshView();
  },
  lfind: el => { ui.lfind = ui.lfind === el.dataset.v ? null : el.dataset.v; ui.lfindRes = []; render(); },
  lfindGo: async el => {
    const q = (($('#lfindText') || {}).value || '').trim();
    ui.lfindText = q;
    if (!q) return toast('Type part of the event name.');
    ui.lfind = el.dataset.v;
    ui.lfindBusy = true; render();
    try {
      ui.lfindRes = await ftcscoutSearch(S().season, q);
      if (!ui.lfindRes.length) toast('No events matched.');
    } catch (e) { toast(friendlyError(e), 'err'); }
    ui.lfindBusy = false;
    render();
  },
  lpick: async el => {
    const kind = el.dataset.v;
    setLview({ [kind]: el.dataset.code || '', stage: el.dataset.code ? (kind === 'champ' ? 'region' : 'worlds') : lview().stage });
    ui.lfind = null; ui.lfindRes = [];
    const p = refreshView({ force: true });
    render();
    await p;
    render();
  },
  lsort: el => {
    const k = el.dataset.k;
    const asc = ['team', 'rank', 'foul', 'broke'];
    ui.lsort = ui.lsort.k === k ? { k, d: -ui.lsort.d } : { k, d: asc.includes(k) ? 1 : -1 };
    render();
  },
  pick: el => { setPick(Number(el.dataset.team), el.dataset.v); teamModal(Number(el.dataset.team)); render(); },

  // Scout
  scoutMode: el => { ui.scoutMode = el.dataset.v; render(); },
  mt: el => {
    ui.mf.mt = Math.max(1, (Number(ui.mf.mt) || 1) + Number(el.dataset.d));
    if (!ui.mf.id) applySlot(ui.mf);
    render();
  },
  slot: el => {
    const sl = el.dataset.v;
    if (S().slot && S().slot !== sl && !confirm(`This iPad is set to scout ${posLabel(S().slot)}. Switch it to ${posLabel(sl)}?`)) return;
    const changed = S().slot !== sl;
    state.settings.slot = sl; persist('settings');
    if (changed) logShift();
    ui.mf.al = sl[0];
    const t = Number(el.dataset.team) || 0;
    if (t && !inScope(t, activeEvent())) { ui.mf.tm = 0; ui.mf.skip = t; }
    else { delete ui.mf.skip; if (t) ui.mf.tm = t; }
    if (ui.mf.st) { const p = tileXY(ui.mf.st); if (p && (p.c < 3 ? 'R' : 'B') !== ui.mf.al) ui.mf.st = ''; }
    render();
  },
  inc: el => {
    const f = ui[el.dataset.form], k = el.dataset.k;
    f[k] = Math.max(0, Math.min(99, (Number(f[k]) || 0) + Number(el.dataset.d)));
    const out = el.parentElement.querySelector('output');
    if (out) out.textContent = f[k]; else render();
  },
  tog: el => {
    const f = ui[el.dataset.form], k = el.dataset.k;
    f[k] = f[k] ? 0 : 1;
    render();
  },
  set: el => {
    const f = ui[el.dataset.form], k = el.dataset.k, v = el.dataset.v;
    f[k] = /^\d+$/.test(v) && k !== 'al' ? Number(v) : v;
    if (k === 'al' && f.st) { const p = tileXY(f.st); if (p && (p.c < 3 ? 'R' : 'B') !== v) f.st = ''; }
    render();
  },
  flag: el => {
    const f = ui[el.dataset.form], k = el.dataset.k, c = el.dataset.v;
    let cur = f[k] || '';
    if (cur.includes(c)) cur = cur.replace(c, '');
    else if (k === 'aS' && c === 'P') cur = 'P';
    else cur = (k === 'aS' ? cur.replace('P', '') : cur) + c;
    f[k] = [...cur].sort().join('');
    render();
  },
  tile: el => {
    const f = ui[el.dataset.form], k = el.dataset.k, v = el.dataset.v;
    if (el.dataset.multi === '1') {
      const set = new Set(String(f[k] || '').split(',').filter(Boolean));
      if (set.has(v)) set.delete(v); else set.add(v);
      f[k] = [...set].sort().join(',');
    } else {
      f[k] = f[k] === v ? '' : v;
      if (!f.al) f.al = tileXY(v).c < 3 ? 'R' : 'B';
    }
    render();
  },
  resetMatch: () => { if (confirm('Clear this form?')) { ui.mf = newMatchForm(ui.mf.mt); render(); } },
  saveMatch: () => {
    const mf = ui.mf;
    if (!mf.mt || !mf.tm) return toast('Enter the match number and team.', 'err');
    if (mf.al !== 'R' && mf.al !== 'B') return toast('Pick Red or Blue alliance.', 'err');
    const ev = S().activeEvent;
    if (!mf.id) {
      const dup = eventRecords(ev, 'm').find(r => isMine(r) && r.mt === mf.mt && r.tm === mf.tm);
      if (dup) {
        if (!confirm(`You already saved team ${mf.tm} in match ${mf.mt}. Replace it?`)) return;
        mf.id = dup.id;
      }
    }
    if (!inScope(mf.tm, activeEvent()) && !confirm(`Team ${mf.tm} isn't in your league, so it's hidden at this event. Save anyway?`)) return;
    const rec = { ...mf, t: 'm', ev, sc: mf.id && mf.sc ? mf.sc : S().scoutName, ts: now(), id: mf.id || newId() };
    rec.ps = stationOf(rec.mt, rec.tm) || mf.ps || S().slot || '';
    delete rec.skip;
    state.records[rec.id] = rec;
    delete state.sent[rec.id];
    persist('records', 'sent');
    syncSoon();
    toast(`Saved match ${rec.mt} · ${rec.tm}`, 'ok');
    ui.mf = newMatchForm(rec.mt + 1);
    window.scrollTo(0, 0);
    render();
  },
  pitTeam: el => {
    const t = Number(el.dataset.team);
    const ev = S().activeEvent;
    const existing = eventRecords(ev, 'p').filter(r => r.tm === t).sort((a, b) => b.ts - a.ts)[0];
    if (existing && isMine(existing)) ui.pf = { ...existing };
    else if (existing) ui.pf = { ...existing, id: '', sc: '' };
    else { ui.pf = blankPit(); ui.pf.ev = ev; ui.pf.tm = t; }
    render();
  },
  resetPit: () => { if (confirm('Clear this form?')) { ui.pf = blankPit(); ui.pf.ev = S().activeEvent; render(); } },
  savePit: () => {
    const pf = ui.pf;
    if (!pf.tm) return toast('Pick a team.', 'err');
    const ev = S().activeEvent;
    if (!pf.id) {
      const dup = eventRecords(ev, 'p').find(r => isMine(r) && r.tm === pf.tm);
      if (dup) pf.id = dup.id;
    }
    const rec = { ...pf, t: 'p', ev, sc: S().scoutName, ts: now(), id: pf.id || newId() };
    state.records[rec.id] = rec;
    delete state.sent[rec.id];
    persist('records', 'sent');
    syncSoon();
    toast(`Saved pit entry for ${rec.tm}`, 'ok');
    ui.pf = blankPit(); ui.pf.ev = ev;
    window.scrollTo(0, 0);
    render();
  },
  editRec: el => {
    const r = state.records[el.dataset.id];
    if (!r) return;
    if (r.t === 'm') { ui.mf = { ...r }; ui.scoutMode = 'match'; } else { ui.pf = { ...r }; ui.scoutMode = 'pit'; }
    window.scrollTo(0, 0);
    render();
  },
  delRec: el => {
    const r = state.records[el.dataset.id];
    if (!r || !confirm(`Delete this ${r.t === 'm' ? 'match' : 'pit'} record for ${r.tm}? This only deletes it on this iPad.`)) return;
    deleteRecord(r.id);
    syncSoon();
    render();
  },

  // Sync
  sendUnsent: () => {
    const recs = [...unsentRecords(), ...eventRecords(undefined, 's').filter(r => isMine(r) && !state.sent[r.id])];
    if (!recs.length) return toast('Nothing new to send.');
    showQR(`${recs.length} records from ${S().scoutName || S().deviceId}`, recMessage(recs), recs.map(r => r.id));
  },
  sendAll: () => {
    const recs = eventRecords();
    if (!recs.length) return toast('No records for this event.');
    showQR(`All ${recs.length} records · ${S().activeEvent}`, recMessage(recs), recs.filter(isMine).map(r => r.id));
  },
  qrPrev: () => { const q = ui.qr; if (!q) return; q.i = (q.i - 1 + q.frames.length) % q.frames.length; drawFrame(); },
  qrNext: () => { const q = ui.qr; if (!q) return; q.i = (q.i + 1) % q.frames.length; drawFrame(); },
  qrPlay: () => {
    const q = ui.qr; if (!q) return;
    if (q.timer) { clearInterval(q.timer); q.timer = null; $('#qrPlayBtn').textContent = 'Play'; }
    else { q.timer = setInterval(() => { q.i = (q.i + 1) % q.frames.length; drawFrame(); }, Math.max(300, S().qrSpeed || 900)); $('#qrPlayBtn').textContent = 'Pause'; }
  },
  qrMarkSent: () => {
    const ids = (ui.qr && ui.qr.markIds) || [];
    markSent(ids);
    closeModal();
    toast(`Marked ${ids.length} records as sent`, 'ok');
    render();
  },
  cloudSync: async () => {
    if (!navigator.onLine) return toast('This iPad is offline. It will sync when it reconnects.');
    const res = await syncNow('manual');
    if (res && res.error) toast(res.error, 'err');
    else if (res && !res.skipped) toast(res.changed ? `Synced · ${res.changed} changes downloaded` : 'Synced ✓', 'ok');
  },
  cloudToggle: () => {
    state.settings.cloudOn = S().cloudOn === false;
    persist('settings');
    if (state.settings.cloudOn) syncSoon(300);
    render();
  },
  shareCloud: () => {
    const c = cloudCfgForQR();
    if (!c) return toast('Enter the web app URL and team key first.', 'err');
    showQR('Cloud backup setup', { k: 'cfg', c });
  },
  scanStart: () => startScanner(),
  scanStop: () => stopScanner(),
  scanFlip: () => { ui.facing = ui.facing === 'environment' ? 'user' : 'environment'; if (ui.scanner && ui.scanner.running) startScanner(); else toast(`Will use the ${ui.facing === 'user' ? 'front' : 'back'} camera`); },
  exportBackup: () => {
    const d = new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-');
    download(`hive-scout-backup-${S().deviceId}-${d}.json`, JSON.stringify(backupObject()), 'application/json');
  },
  exportCSV: el => {
    const type = el.dataset.type;
    const recs = eventRecords(S().activeEvent, type).sort((a, b) => (a.mt || 0) - (b.mt || 0) || a.tm - b.tm);
    download(`hive-scout-${S().activeEvent}-${type === 'm' ? 'matches' : 'pit'}.csv`, toCSV(recs, type), 'text/csv');
  },
  importFile: () => $('#fileInput').click(),
  clearAll: () => {
    if (!confirm('Erase ALL events, scouting records and settings on this iPad?')) return;
    if (!confirm('Really erase? Make a backup first if you are not sure.')) return;
    clearAll();
    location.reload();
  },
  sort: el => {
    const k = el.dataset.k;
    ui.sort = ui.sort.k === k ? { k, d: -ui.sort.d } : { k, d: k === 'team' || k === 'foulPts' || k === 'broke' ? 1 : -1 };
    render();
  },
};

// ---------------------------------------------------------------- events

document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const fn = actions[el.dataset.act];
  if (fn) { e.preventDefault(); fn(el, e); }
});

$('#modal').addEventListener('click', e => { if (e.target.id === 'modal') closeModal(); });

document.addEventListener('input', e => {
  const el = e.target;
  const intType = el.dataset.type === 'int';
  const val = intType ? (el.value === '' ? '' : Number(el.value.replace(/\D/g, '')) || 0) : el.value;
  if (el.dataset.set) {
    if (intType && val === '' && el.dataset.set !== 'ourTeam') return;
    state.settings[el.dataset.set] = val;
    persist('settings');
    if (el.dataset.set === 'ourTeam') renderHeader();
    if (el.dataset.set === 'cloudUrl') ui.cloudUrlChanged = true;
    if (el.dataset.set === 'cloudUrl' || el.dataset.set === 'cloudKey') refreshCloudButtons();
  } else if (el.dataset.mf && ui.mf) {
    ui.mf[el.dataset.mf] = intType ? (Number(val) || 0) : val;
  } else if (el.dataset.pf && ui.pf) {
    ui.pf[el.dataset.pf] = intType ? (Number(val) || 0) : val;
  } else if (el.dataset.ui) {
    ui[el.dataset.ui] = el.value;
  } else if (el.dataset.w) {
    state.settings.weights[el.dataset.w] = Number(el.value);
    persist('settings');
    const o = $('#w_' + el.dataset.w); if (o) o.textContent = el.value;
  }
});

document.addEventListener('change', async e => {
  const el = e.target;
  if (el.id === 'fileInput') {
    const file = el.files && el.files[0];
    el.value = '';
    if (!file) return;
    try {
      const obj = JSON.parse(await file.text());
      if (obj.hsBackup) {
        const { n, u } = mergeBackup(obj);
        toast(`Backup merged: ${n} new, ${u} updated records`, 'ok');
      } else {
        const ev = normalizeEvent(obj.hsEvent ? obj : obj);
        saveEvent(ev);
        toast(`Event ${ev.code} imported`, 'ok');
      }
      ui.mf = null; ui.pf = null;
      render();
    } catch (err) { toast('Could not import: ' + err.message, 'err'); }
    return;
  }
  if (el.dataset.change === 'pickEvent') {
    state.settings.activeEvent = el.value; persist('settings');
    ui.mf = null; ui.pf = null; ui.editEvent = false;
    render();
  } else if (el.dataset.change === 'filter') {
    ui.filter = el.value; renderSoon();
  } else if (el.dataset.change === 'lfilter') {
    ui.lfilter = el.value; renderSoon();
  } else if (el.dataset.change === 'lleague') {
    setLview({ league: el.value });
    render();
    refreshView().then(render);
  } else if (el.dataset.change === 'lchamp') {
    setLview({ champ: el.value });
    render();
    refreshView().then(render);
  } else if (el.dataset.change === 'watchOurs') {
    state.settings.watchOurs = el.checked; persist('settings'); render();
  } else if (el.dataset.change === 'covMissingOnly') {
    ui.covMissingOnly = el.checked; render();
  } else if (el.dataset.change === 'schedUpcoming') {
    ui.schedUpcoming = el.checked; render();
  } else if (el.dataset.change === 'hideDnp') {
    ui.hideDnp = el.checked; render();
  } else if (el.dataset.w) {
    render();
  } else if (el.dataset.mf === 'mt' && ui.mf) {
    ui.mf.mt = Math.max(1, Number(el.value) || 1);
    if (!ui.mf.id) applySlot(ui.mf);
    renderSoon();
  } else if (el.dataset.mf === 'tm' || el.dataset.pf === 'tm') {
    renderSoon();
  } else if (el.dataset.set === 'scoutName') {
    logShift();
  } else if (el.dataset.set === 'cloudUrl' || el.dataset.set === 'cloudKey') {
    if (ui.cloudUrlChanged) { ui.cloudUrlChanged = false; resetCloudProgress(); }
    cloud.lastErr = '';
    refreshCloudButtons();
    syncSoon(300);
  } else if (el.dataset.set === 'season' || el.dataset.set === 'symmetry' || el.dataset.set === 'ourTeam') {
    renderSoon();
  }
});

document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.id === 'evCode') actions.dlScout(e.target);
  if (e.key === 'Enter' && e.target.id === 'evSearch') actions.searchEv();
  if (e.key === 'Enter' && e.target.id === 'watchInput') actions.watchAdd();
  if (e.key === 'Escape') closeModal();
});

window.addEventListener('online', renderHeader);
window.addEventListener('offline', renderHeader);
window.addEventListener('resize', () => { if (ui.qr) drawFrame(); });
document.addEventListener('visibilitychange', () => { if (document.hidden) stopScanner(); });

// ---------------------------------------------------------------- service worker (offline)

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
  navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' }).then(reg => {
    if (!reg) return;
    const watch = w => w && w.addEventListener('statechange', () => {
      if (w.state === 'installed' && navigator.serviceWorker.controller) {
        ui.waitingSW = w;
        $('#updateBar').classList.remove('hidden');
      }
    });
    if (reg.waiting && navigator.serviceWorker.controller) { ui.waitingSW = reg.waiting; $('#updateBar').classList.remove('hidden'); }
    reg.addEventListener('updatefound', () => watch(reg.installing));
  }).catch(err => console.warn('Service worker failed', err));
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (!reloaded && ui.waitingSW) { reloaded = true; location.reload(); } });
}

if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

// Cloud sync: refresh the header, and redraw read-only screens when other iPads' data arrives
cloud.onChange = changed => {
  renderHeader();
  if (!changed) return;
  const typing = document.activeElement && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
  const modalOpen = !$('#modal').classList.contains('hidden');
  if (['teams', 'schedule', 'league', 'partners', 'event'].includes(ui.tab) && !typing && !modalOpen) render();
};
official.onChange = () => {
  const typing = document.activeElement && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
  const modalOpen = !$('#modal').classList.contains('hidden');
  if (['teams', 'league', 'partners', 'event'].includes(ui.tab) && !typing && !modalOpen) render();
};
setInterval(renderHeader, 30000);
// Keep match times and results fresh while someone is looking at the Schedule tab.
setInterval(() => { if (ui.tab === 'schedule' && !document.hidden) refreshLive(activeEvent()); }, 60000);
// …and keep the League tab current (it only downloads what is out of date: every 5 min on event days, 30 min otherwise).
setInterval(() => { if (ui.tab === 'league' && !document.hidden) refreshView(); }, 60000);
document.addEventListener('visibilitychange', () => { if (!document.hidden && ui.tab === 'league') refreshView(); });
window.addEventListener('online', () => { if (ui.tab === 'league') setTimeout(() => refreshView(), 2000); });

// First run: start on Scout if everything is set up
if (activeEvent() && S().scoutName) ui.tab = 'scout';
render();
startCloud();
startOfficial();

// Exposed for automated tests
window.__hs = { state, ui, actions, render, onScanText, cloud, syncNow };
