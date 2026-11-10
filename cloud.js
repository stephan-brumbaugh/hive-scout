// Automatic two-way sync with a Google Sheet (via the Apps Script web app in tools/hive-scout-sync.gs).
// Works quietly in the background whenever the iPad is online; everything still works offline.
import { state, persist, upsertRecord } from './store.js';

const BATCH = 250;          // records per upload request
const POLL_MS = 90 * 1000;  // check for other iPads' data this often while open and online

export const cloud = { busy: false, lastOk: 0, lastErr: '', lastPulled: 0, again: false, onChange: null };

function cfg() {
  const s = state.settings;
  return { url: String(s.cloudUrl || '').trim(), key: String(s.cloudKey || '').trim(), on: s.cloudOn !== false };
}

export function cloudConfigured() {
  const c = cfg();
  return !!(c.url && c.key && (/^https:\/\//i.test(c.url) || /^http:\/\/(localhost|127\.0\.0\.1)[:/]/i.test(c.url)));
}

export function cloudActive() {
  return cloudConfigured() && cfg().on;
}

function pendingRecords() {
  return Object.values(state.records).filter(r => state.cloudSent[r.id] !== r.ts);
}

function pendingEvents() {
  return Object.values(state.events).filter(e => state.cloudSentEv[e.code] !== e.upd);
}

export function cloudPending() {
  return pendingRecords().length + Object.keys(state.cloudDel).length;
}

export function isInCloud(r) {
  return cloudActive() && state.cloudSent[r.id] === r.ts;
}

// Call when the URL changes so everything is uploaded to the new Sheet.
export function resetCloudProgress() {
  state.cloudSent = {};
  state.cloudSentEv = {};
  state.settings.cloudCursor = 0;
  persist('cloudSent', 'cloudSentEv', 'settings');
}

function notify(changed) {
  if (cloud.onChange) {
    try { cloud.onChange(changed); } catch (e) { console.error(e); }
  }
}

async function post(body) {
  const c = cfg();
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 45000);
  let res;
  try {
    // No custom headers: a "simple" request, which Google Apps Script web apps accept from any website.
    res = await fetch(c.url, { method: 'POST', body: JSON.stringify(body), redirect: 'follow', signal: ctl.signal });
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? 'The Google Sheet took too long to answer.' : 'Could not reach the Google Sheet script.');
  } finally {
    clearTimeout(t);
  }
  const text = await res.text();
  let j;
  try { j = JSON.parse(text); } catch (e) {
    if (/<html|<!doctype/i.test(text)) {
      throw new Error('Google returned a sign-in or error page instead of data. Check the script is deployed as a Web app with "Who has access: Anyone". (Some school accounts don\'t allow that; a personal Google account does.)');
    }
    throw new Error('Unexpected reply from the Google Sheet script (HTTP ' + res.status + ').');
  }
  if (!j.ok) throw new Error(j.error || 'Sync failed');
  return j;
}

export async function syncNow(reason = '') {
  if (!cloudActive()) return { skipped: 'off' };
  if (navigator.onLine === false) return { skipped: 'offline' };
  if (cloud.busy) { cloud.again = true; return { skipped: 'busy' }; }
  cloud.busy = true;
  notify(0);
  let changed = 0;
  try {
    let evs = pendingEvents();
    for (let loop = 0; loop < 40; loop++) {
      const recs = pendingRecords().slice(0, BATCH).map(r => ({ ...r }));
      const delIds = Object.keys(state.cloudDel).slice(0, BATCH);
      const body = {
        key: cfg().key,
        action: 'sync',
        device: state.settings.deviceId,
        scout: state.settings.scoutName,
        since: Number(state.settings.cloudCursor) || 0,
        records: recs,
        deletes: delIds.map(id => ({ id, ts: state.cloudDel[id] })),
        events: evs,
      };
      const j = await post(body);

      // What we sent is now in the Sheet
      for (const r of recs) state.cloudSent[r.id] = r.ts;
      for (const id of delIds) delete state.cloudDel[id];
      for (const e of evs) state.cloudSentEv[e.code] = e.upd;
      evs = [];

      // Apply what other iPads sent
      for (const x of j.records || []) {
        if (!x || !x.id) continue;
        if (x.deleted) {
          if (state.records[x.id]) { delete state.records[x.id]; changed++; }
          delete state.cloudSent[x.id];
          delete state.sent[x.id];
          continue;
        }
        const res = upsertRecord(x);
        if (res === 'new' || res === 'updated') changed++;
        const cur = state.records[x.id];
        if (cur && cur.ts === x.ts) state.cloudSent[x.id] = x.ts;
      }
      for (const e of j.events || []) {
        if (!e || !e.code) continue;
        const cur = state.events[e.code];
        if (!cur || (Number(e.upd) || 0) > (Number(cur.upd) || 0)) {
          state.events[e.code] = e;
          changed++;
          if (!state.settings.activeEvent) state.settings.activeEvent = e.code;
        }
        state.cloudSentEv[e.code] = state.events[e.code].upd;
      }
      state.settings.cloudCursor = Number(j.cursor) || 0;
      persist('records', 'events', 'settings', 'cloudSent', 'cloudSentEv', 'cloudDel', 'sent');

      if (!j.more && !pendingRecords().length && !Object.keys(state.cloudDel).length) break;
    }
    cloud.lastOk = Date.now();
    cloud.lastErr = '';
    if (changed) cloud.lastPulled = changed;
  } catch (e) {
    cloud.lastErr = e.message || String(e);
  } finally {
    cloud.busy = false;
    notify(changed);
    if (cloud.again) { cloud.again = false; setTimeout(() => syncNow('again'), 800); }
  }
  return { changed, error: cloud.lastErr };
}

let soonTimer;
export function syncSoon(ms = 2500) {
  if (!cloudActive()) return;
  clearTimeout(soonTimer);
  soonTimer = setTimeout(() => syncNow('soon'), ms);
}

export function startCloud() {
  window.addEventListener('online', () => syncSoon(500));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) syncSoon(500); });
  setInterval(() => { if (!document.hidden) syncNow('poll'); }, POLL_MS);
  syncSoon(1200);
}
