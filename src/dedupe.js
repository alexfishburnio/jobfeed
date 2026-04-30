// Collapses identical (company + title) postings into a single row for
// display purposes (email body + public feed.json). Daily snapshots and
// state.json continue to track individual job_ids for diff fidelity —
// dedupe is a pure read-side transform.
//
// Merge rules:
//   - Highest fit_score across the group becomes the base; other fields
//     (recommended_resume, mode, ats, apply_url) are taken from the base.
//   - locations/metros: union, dedup, ordered by metro priority.
//   - salary_min_base: min of all non-null mins
//   - salary_max_base: max of all non-null maxes
//   - status: 'new' if any sub-posting is new, else 'ongoing', else
//     whatever the base says (preserves 'closed_today' for closed groups).
//   - grouped_count + grouped_ids surfaced for downstream display.

const METRO_PRIORITY = [
  'sf', 'nyc', 'la', 'seattle', 'boston', 'austin', 'chicago',
  'denver', 'philly', 'dc', 'remote', 'other',
];

function metroOrder(m) {
  const i = METRO_PRIORITY.indexOf(m);
  return i >= 0 ? i : 999;
}

function dedupePostings(postings) {
  const groups = new Map();
  for (const p of postings) {
    const key = `${p.company || ''}${p.title || ''}`;
    let g = groups.get(key);
    if (!g) { g = []; groups.set(key, g); }
    g.push(p);
  }
  const out = [];
  for (const g of groups.values()) out.push(mergeGroup(g));
  return out;
}

function mergeGroup(group) {
  if (group.length === 1) {
    return { ...group[0], grouped_count: 1, grouped_ids: [group[0].id] };
  }

  // Same (company, title) → identical realism, so sort by priority is
  // equivalent to sort by fit. Use priority defensively.
  const sorted = [...group].sort((a, b) => (b.priority_score ?? b.fit_score ?? 0) - (a.priority_score ?? a.fit_score ?? 0));
  const base = sorted[0];

  const locations = [...new Set(group.flatMap(p => p.locations || []))];
  const metros = [...new Set(group.map(p => p.metro).filter(Boolean))]
    .sort((a, b) => metroOrder(a) - metroOrder(b));

  const mins = group.map(p => p.salary_min_base).filter(n => Number.isFinite(n));
  const maxs = group.map(p => p.salary_max_base).filter(n => Number.isFinite(n));

  const anyNew     = group.some(p => p.status === 'new');
  const anyOngoing = group.some(p => p.status === 'ongoing');
  const anyClosed  = group.some(p => p.status === 'closed_today');
  const status = anyNew ? 'new' : anyOngoing ? 'ongoing' : anyClosed ? 'closed_today' : (base.status || null);

  return {
    ...base,
    status,
    locations,
    metros,
    salary_min_base: mins.length ? Math.min(...mins) : null,
    salary_max_base: maxs.length ? Math.max(...maxs) : null,
    grouped_count: group.length,
    grouped_ids: group.map(p => p.id),
  };
}

module.exports = { dedupePostings };
