// Reads yesterday's job_ids from state.json + yesterday's snapshot to compute
// new / ongoing / closed_today flags. Stateless about disk paths — the caller
// passes them in.

const fs = require('node:fs');
const path = require('node:path');

function readJsonOrNull(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function loadState(statePath) {
  const s = readJsonOrNull(statePath);
  if (!s || !Array.isArray(s.job_ids)) return { date: null, job_ids: [] };
  return s;
}

function loadYesterdaySnapshot(dataDir, todayDate) {
  // Most recent snapshot file before today, by filename ISO order.
  if (!fs.existsSync(dataDir)) return null;
  const files = fs.readdirSync(dataDir)
    .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .filter(f => f.replace('.json', '') < todayDate)
    .sort();
  if (!files.length) return null;
  const newest = files[files.length - 1];
  return readJsonOrNull(path.join(dataDir, newest));
}

function diff({ kept, excluded }, statePath, dataDir, todayDate) {
  const prevState = loadState(statePath);
  const prev = new Set(prevState.job_ids);

  const todayIds = new Set();
  for (const p of kept) todayIds.add(p.id);
  for (const p of excluded) todayIds.add(p.id);

  const tag = arr => arr.map(p => ({
    ...p,
    status: prev.has(p.id) ? 'ongoing' : 'new',
  }));

  const taggedKept = tag(kept);
  const taggedExcluded = tag(excluded);

  // Closed-today = ids in yesterday but missing today. Pull full posting
  // detail from yesterday's snapshot so the email/feed has names + links.
  const closedIds = [...prev].filter(id => !todayIds.has(id));
  const yesterday = loadYesterdaySnapshot(dataDir, todayDate);
  const yesterdayById = new Map();
  if (yesterday) {
    for (const p of [...(yesterday.kept || []), ...(yesterday.excluded || [])]) {
      yesterdayById.set(p.id, p);
    }
  }
  const closedToday = closedIds
    .map(id => yesterdayById.get(id))
    .filter(Boolean)
    .map(p => ({ ...p, status: 'closed_today' }));

  return {
    kept: taggedKept,
    excluded: taggedExcluded,
    closed_today: closedToday,
    prev_date: prevState.date,
    prev_count: prev.size,
    today_count: todayIds.size,
    today_ids: [...todayIds],
  };
}

function writeSnapshot(dataDir, date, snapshot) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, `${date}.json`), JSON.stringify(snapshot, null, 2) + '\n');
}

function writeState(statePath, date, jobIds) {
  fs.writeFileSync(statePath, JSON.stringify({ date, job_ids: jobIds }, null, 2) + '\n');
}

module.exports = { diff, writeSnapshot, writeState, loadState, loadYesterdaySnapshot };
