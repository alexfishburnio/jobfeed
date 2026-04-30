// Phase 1.4 — feed.json grouped by first_seen_date.
//
// Reads the most recent daily snapshot (which already contains all currently
// tracked postings: active + closed_today + closed within 14d) and groups
// them by first_seen_date. Days older than RETENTION_DAYS from the snapshot
// date are pruned. Per-day postings are deduped via dedupePostings().

const fs = require('node:fs');
const path = require('node:path');
const { dedupePostings } = require('./dedupe');
const { RETENTION_DAYS, daysBefore } = require('./differ');

function listSnapshots(dataDir) {
  if (!fs.existsSync(dataDir)) return [];
  return fs.readdirSync(dataDir)
    .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort();
}

function dayCounts(dedPostings, dedExcluded) {
  const c = { active: 0, closed_today: 0, closed: 0, excluded: dedExcluded.length };
  for (const p of dedPostings) {
    if (p.status === 'active')        c.active++;
    else if (p.status === 'closed_today') c.closed_today++;
    else if (p.status === 'closed')   c.closed++;
  }
  return c;
}

function buildFeed(dataDir, retentionDays = RETENTION_DAYS) {
  const files = listSnapshots(dataDir);
  if (!files.length) return { generated_at: new Date().toISOString(), days: [] };

  const latest = files[files.length - 1];
  const snap = JSON.parse(fs.readFileSync(path.join(dataDir, latest), 'utf8'));
  const today = snap.date;
  const cutoff = daysBefore(today, retentionDays);

  const byDate = new Map();
  const bucket = (d) => {
    if (!byDate.has(d)) byDate.set(d, { postings: [], excluded: [] });
    return byDate.get(d);
  };
  for (const p of (snap.postings || [])) {
    const seen = p.first_seen_date;
    if (!seen || seen < cutoff) continue;
    bucket(seen).postings.push(p);
  }
  for (const p of (snap.excluded || [])) {
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

function writeFeed(publicDir, feed) {
  fs.mkdirSync(publicDir, { recursive: true });
  fs.writeFileSync(path.join(publicDir, 'feed.json'), JSON.stringify(feed, null, 2) + '\n');
}

module.exports = { buildFeed, writeFeed };
