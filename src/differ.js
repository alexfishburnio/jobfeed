// Phase 1.4 — first_seen_date carry-forward across runs.
//
// State schema:   { date, postings: { [id]: { first_seen_date, status, closed_date } } }
// Status values:  "active" (in today's fetched set)
//                 "closed_today" (was active yesterday, missing today)
//                 "closed" (was closed before today, still in 14d window)
//
// Daily snapshot stores all currently-tracked postings (active + closed_today
// + closed), each with status + first_seen_date. Postings whose
// first_seen_date is older than 14 days from today are pruned from state and
// never appear in the snapshot — but the historical snapshot files in data/
// stay on disk regardless.

const fs = require('node:fs');
const path = require('node:path');

const RETENTION_DAYS = 14;

function readJsonOrNull(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function loadState(statePath) {
  const s = readJsonOrNull(statePath);
  if (!s) return { date: null, postings: {} };
  // Phase 1.4 schema.
  if (s.postings && typeof s.postings === 'object' && !Array.isArray(s.postings)) {
    return { date: s.date || null, postings: s.postings };
  }
  // Pre-1.4 migration: { date, job_ids: [...] } — assume each id is currently
  // active and was first seen on the state's date.
  if (Array.isArray(s.job_ids)) {
    const postings = {};
    for (const id of s.job_ids) {
      postings[id] = { first_seen_date: s.date, status: 'active', closed_date: null };
    }
    return { date: s.date || null, postings };
  }
  return { date: null, postings: {} };
}

function loadPreviousSnapshot(dataDir, prevDate) {
  // Used to recover full posting fields (title, salary, etc.) for IDs that
  // dropped out of today's fetch but are still being tracked. Falls back to
  // the most recent snapshot file when no prevDate is known.
  if (!fs.existsSync(dataDir)) return null;
  if (prevDate) {
    const file = path.join(dataDir, `${prevDate}.json`);
    if (fs.existsSync(file)) return readJsonOrNull(file);
  }
  const files = fs.readdirSync(dataDir)
    .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort();
  if (!files.length) return null;
  return readJsonOrNull(path.join(dataDir, files[files.length - 1]));
}

function buildLookup(snapshot) {
  // id → posting fields (from previous snapshot, both new and old schema).
  const map = new Map();
  if (!snapshot) return map;
  for (const p of (snapshot.postings || [])) map.set(p.id, p);
  for (const p of (snapshot.excluded || [])) map.set(p.id, p);
  // Pre-1.4 schemas:
  for (const p of (snapshot.kept || [])) map.set(p.id, p);
  for (const p of (snapshot.closed_today || [])) map.set(p.id, p);
  return map;
}

function daysBefore(dateStr, n) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - n);
  return dt.toISOString().slice(0, 10);
}

function diff({ kept, excluded }, statePath, dataDir, todayDate) {
  const prev = loadState(statePath);
  const prevPostings = prev.postings || {};
  const prevSnapshot = loadPreviousSnapshot(dataDir, prev.date);
  const lookup = buildLookup(prevSnapshot);

  const todayIds = new Set();
  for (const p of [...kept, ...excluded]) todayIds.add(p.id);

  const cutoff = daysBefore(todayDate, RETENTION_DAYS);

  // Tag today's active postings — carry first_seen_date forward when known,
  // otherwise stamp today. A posting that was previously "closed" and now
  // reappears is treated as a new requisition (fresh first_seen_date).
  const tagActive = (p) => {
    const known = prevPostings[p.id];
    let firstSeen;
    if (known && (known.status === 'active' || known.status === 'closed_today')) {
      firstSeen = known.first_seen_date;
    } else {
      firstSeen = todayDate;
    }
    return { ...p, first_seen_date: firstSeen, status: 'active', closed_date: null };
  };
  const taggedKept = kept.map(tagActive);
  const taggedExcluded = excluded.map(tagActive);

  // Carry forward previously-tracked postings that aren't in today's fetch.
  // Status transitions: active → closed_today; closed_today → closed; closed → closed.
  const carryKept = [];
  const carryExcluded = [];
  for (const [id, info] of Object.entries(prevPostings)) {
    if (todayIds.has(id)) continue;

    const firstSeen = info.first_seen_date || prev.date || todayDate;
    if (firstSeen < cutoff) continue;

    let newStatus, closedDate;
    if (info.status === 'active') {
      newStatus = 'closed_today';
      closedDate = todayDate;
    } else if (info.status === 'closed_today') {
      newStatus = 'closed';
      closedDate = info.closed_date || prev.date || todayDate;
    } else {
      newStatus = 'closed';
      closedDate = info.closed_date || prev.date || todayDate;
    }

    const data = lookup.get(id);
    if (!data) continue;  // no posting fields available; can't render

    const tagged = {
      ...data,
      first_seen_date: firstSeen,
      status: newStatus,
      closed_date: closedDate,
      // Strip any stale carry-forward state fields that shouldn't survive.
    };
    if (data.exclusion_reason) carryExcluded.push(tagged);
    else carryKept.push(tagged);
  }

  // New state map — everything we're still tracking.
  const newStateMap = {};
  const recordState = (p) => {
    newStateMap[p.id] = {
      first_seen_date: p.first_seen_date,
      status: p.status,
      closed_date: p.closed_date || null,
    };
  };
  for (const p of [...taggedKept, ...taggedExcluded]) recordState(p);
  for (const p of [...carryKept, ...carryExcluded])  recordState(p);

  return {
    kept:     [...taggedKept,     ...carryKept],
    excluded: [...taggedExcluded, ...carryExcluded],
    state_map: newStateMap,
    prev_date: prev.date,
    prev_count: Object.keys(prevPostings).length,
    today_active_count: taggedKept.length + taggedExcluded.length,
    today_total_count: Object.keys(newStateMap).length,
    counts: {
      active_kept: taggedKept.length,
      active_excluded: taggedExcluded.length,
      closed_today_kept: carryKept.filter(p => p.status === 'closed_today').length,
      closed_today_excluded: carryExcluded.filter(p => p.status === 'closed_today').length,
      closed_kept: carryKept.filter(p => p.status === 'closed').length,
      closed_excluded: carryExcluded.filter(p => p.status === 'closed').length,
    },
  };
}

function writeSnapshot(dataDir, date, snapshot) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, `${date}.json`), JSON.stringify(snapshot, null, 2) + '\n');
}

function writeState(statePath, date, stateMap) {
  fs.writeFileSync(statePath, JSON.stringify({ date, postings: stateMap }, null, 2) + '\n');
}

module.exports = {
  diff, writeSnapshot, writeState,
  loadState, loadPreviousSnapshot,
  RETENTION_DAYS, daysBefore,
};
