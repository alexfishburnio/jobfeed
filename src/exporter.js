// Builds public/feed.json from the last N daily snapshots in data/.
// Older-than-N snapshots stay in data/ but drop out of the feed.
//
// Snapshots store raw individual postings; the feed presents the
// (company + title) deduplicated view — same view the email renders.

const fs = require('node:fs');
const path = require('node:path');
const { dedupePostings } = require('./dedupe');

function listSnapshots(dataDir) {
  if (!fs.existsSync(dataDir)) return [];
  return fs.readdirSync(dataDir)
    .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort();
}

function buildFeed(dataDir, retentionDays) {
  const all = listSnapshots(dataDir);
  const tail = all.slice(-retentionDays);
  const days = [];
  for (const f of tail) {
    const snap = JSON.parse(fs.readFileSync(path.join(dataDir, f), 'utf8'));
    const date = f.replace('.json', '');

    const dedKept     = dedupePostings(snap.kept || []);
    const dedExcluded = dedupePostings(snap.excluded || []);
    const dedClosed   = dedupePostings(snap.closed_today || []);

    const newKept     = dedKept.filter(p => p.status === 'new');
    const ongoingKept = dedKept.filter(p => p.status === 'ongoing');

    days.push({
      date,
      counts: {
        new: newKept.length,
        ongoing: ongoingKept.length,
        closed: dedClosed.length,
        excluded: dedExcluded.length,
      },
      new: newKept,
      ongoing: ongoingKept,
      closed: dedClosed,
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
