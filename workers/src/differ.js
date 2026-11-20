// first_seen_date carry-forward across runs. Pure in-memory — receives
// previous state and previous snapshot as arguments; the caller (daily
// worker) persists the new state via KV and the new snapshot via R2.

export const RETENTION_DAYS = 14;

export function daysBefore(dateStr, n) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - n);
  return dt.toISOString().slice(0, 10);
}

function normalizeState(raw) {
  if (!raw) return { date: null, postings: {} };
  if (raw.postings && typeof raw.postings === 'object' && !Array.isArray(raw.postings)) {
    return { date: raw.date || null, postings: raw.postings };
  }
  if (Array.isArray(raw.job_ids)) {
    const postings = {};
    for (const id of raw.job_ids) {
      postings[id] = { first_seen_date: raw.date, status: 'active', closed_date: null };
    }
    return { date: raw.date || null, postings };
  }
  return { date: null, postings: {} };
}

function buildLookup(snapshot) {
  const map = new Map();
  if (!snapshot) return map;
  for (const p of (snapshot.postings || [])) map.set(p.id, p);
  for (const p of (snapshot.excluded || [])) map.set(p.id, p);
  for (const p of (snapshot.kept || [])) map.set(p.id, p);
  for (const p of (snapshot.closed_today || [])) map.set(p.id, p);
  return map;
}

// Pure diff. Does not read or write anything.
//
//   { kept, excluded }   — today's scored postings
//   prevStateRaw         — previous state object (from KV); null/undefined allowed
//   prevSnapshot         — previous snapshot object (from R2); null/undefined allowed
//   todayDate            — "YYYY-MM-DD" in ET
export function diff({ kept, excluded }, prevStateRaw, prevSnapshot, todayDate) {
  const prev = normalizeState(prevStateRaw);
  const prevPostings = prev.postings || {};
  const lookup = buildLookup(prevSnapshot);

  const todayIds = new Set();
  for (const p of [...kept, ...excluded]) todayIds.add(p.id);

  let newlyDiscovered = 0;
  for (const id of todayIds) {
    if (!prevPostings[id]) newlyDiscovered++;
  }

  const cutoff = daysBefore(todayDate, RETENTION_DAYS);

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
    if (!data) continue;

    const tagged = {
      ...data,
      first_seen_date: firstSeen,
      status: newStatus,
      closed_date: closedDate,
    };
    if (data.exclusion_reason) carryExcluded.push(tagged);
    else carryKept.push(tagged);
  }

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
    newly_discovered: newlyDiscovered,
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
