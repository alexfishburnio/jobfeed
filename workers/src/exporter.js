// Build feed.json from the latest daily snapshot. In the Worker, the daily
// handler passes the newly-written snapshot in directly; no filesystem.

import { dedupePostings } from './dedupe.js';
import { RETENTION_DAYS, daysBefore } from './differ.js';

function dayCounts(dedPostings, dedExcluded) {
  const c = { active: 0, closed_today: 0, closed: 0, excluded: dedExcluded.length };
  for (const p of dedPostings) {
    if (p.status === 'active')        c.active++;
    else if (p.status === 'closed_today') c.closed_today++;
    else if (p.status === 'closed')   c.closed++;
  }
  return c;
}

export function buildFeedFromSnapshot(snapshot, retentionDays = RETENTION_DAYS) {
  if (!snapshot) return { generated_at: new Date().toISOString(), days: [] };
  const today = snapshot.date;
  const cutoff = daysBefore(today, retentionDays);

  const byDate = new Map();
  const bucket = (d) => {
    if (!byDate.has(d)) byDate.set(d, { postings: [], excluded: [] });
    return byDate.get(d);
  };
  for (const p of (snapshot.postings || [])) {
    const seen = p.first_seen_date;
    if (!seen || seen < cutoff) continue;
    bucket(seen).postings.push(p);
  }
  for (const p of (snapshot.excluded || [])) {
    const seen = p.first_seen_date;
    if (!seen || seen < cutoff) continue;
    bucket(seen).excluded.push(p);
  }

  const days = [];
  for (const date of [...byDate.keys()].sort()) {
    const b = byDate.get(date);
    const dedPostings = dedupePostings(b.postings);
    const dedExcluded = dedupePostings(b.excluded);
    days.push({
      date,
      counts: dayCounts(dedPostings, dedExcluded),
      postings: dedPostings,
      excluded: dedExcluded,
    });
  }

  return { generated_at: new Date().toISOString(), days };
}
