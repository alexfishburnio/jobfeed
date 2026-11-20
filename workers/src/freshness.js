// Freshness check for the weekly digest: before composing the email, fetch
// each candidate company's current postings and compare against the week's
// pool. Roles whose job_id no longer appears in the fresh fetch are moved
// out of "Top picks" / "All new roles" and into "Closed this week".
//
// Fetch failures are tolerated — if a company's fresh fetch errors out,
// all its candidate roles are assumed still alive (optimistic) and the
// failure is recorded so the infrastructure section can surface it.

import { fetchCompany } from './fetcher.js';

const REQUEST_DELAY_MS = 1500;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Build the universe of unique ATS slugs represented by the candidate pool.
// Multiple candidate postings can share a (ats, slug) pair; fetch each once.
function companiesInPool(postings, allCompanies) {
  const byKey = new Map();
  for (const c of allCompanies) {
    byKey.set(`${c.ats}:${c.slug}`, c);
  }
  const needed = new Set();
  for (const p of postings) {
    // Posting IDs are `${ats}:${slug}:${jobId}` — parse them back out.
    const parts = (p.id || '').split(':');
    if (parts.length < 2) continue;
    needed.add(`${parts[0]}:${parts[1]}`);
  }
  const out = [];
  for (const key of needed) {
    const c = byKey.get(key);
    if (c) out.push(c);
  }
  return out;
}

// Extract the live job-id set from the raw ATS payload. Mirrors the
// id-stamping logic used during normal parsing — `${ats}:${slug}:${rawJobId}`.
function liveJobIds(company, jobs) {
  const ids = new Set();
  for (const j of jobs) {
    const rawId = company.ats === 'greenhouse' ? j.id
                : company.ats === 'lever'      ? j.id
                : company.ats === 'ashby'      ? j.id
                : null;
    if (rawId == null) continue;
    ids.add(`${company.ats}:${company.slug}:${rawId}`);
  }
  return ids;
}

// `candidates` is the deduped pool from the week. Returns:
//   { alive: [], closed: [], fetchFailures: [{ company, error }] }
// `log` is optional; defaults to stderr.
async function freshnessCheck(candidates, allCompanies, { log, delayMs } = {}) {
  const say = log || (m => process.stderr.write(m + '\n'));
  const delay = Number.isFinite(delayMs) ? delayMs : REQUEST_DELAY_MS;

  const companiesToFetch = companiesInPool(candidates, allCompanies);
  say(`freshness: fetching ${companiesToFetch.length} compan${companiesToFetch.length === 1 ? 'y' : 'ies'} across ${candidates.length} candidate role${candidates.length === 1 ? '' : 's'}`);

  const liveByKey = new Map();          // key -> Set<id> of live job ids
  const fetchFailures = [];              // [{ company, error }]

  let first = true;
  for (const c of companiesToFetch) {
    if (!first) await sleep(delay);
    first = false;
    try {
      const { jobs } = await fetchCompany(c);
      const ids = liveJobIds(c, jobs);
      liveByKey.set(`${c.ats}:${c.slug}`, ids);
      say(`  freshness ok ${c.ats}/${c.slug} — ${ids.size} live`);
    } catch (err) {
      fetchFailures.push({ company: c, error: err.message, http_status: err.status || null });
      say(`  freshness FAIL ${c.ats}/${c.slug} — ${err.message}`);
    }
  }

  // Group candidates by (ats, slug) carefully — for grouped postings the
  // row shows `grouped_ids: [id1, id2, ...]`. A grouped row is alive if ANY
  // of its grouped_ids is still live.
  const failedKeys = new Set(fetchFailures.map(f => `${f.company.ats}:${f.company.slug}`));
  const alive = [];
  const closed = [];
  for (const p of candidates) {
    const idParts = (p.id || '').split(':');
    const key = idParts.length >= 2 ? `${idParts[0]}:${idParts[1]}` : null;
    if (!key) {
      alive.push(p);
      continue;
    }
    if (failedKeys.has(key)) {
      // Optimistic fallback on fetch failure — keep the role alive.
      alive.push(p);
      continue;
    }
    const liveIds = liveByKey.get(key);
    if (!liveIds) {
      // Company not fetched (shouldn't happen); assume alive.
      alive.push(p);
      continue;
    }
    const groupIds = (p.grouped_ids && p.grouped_ids.length) ? p.grouped_ids : [p.id];
    const anyLive = groupIds.some(id => liveIds.has(id));
    if (anyLive) alive.push(p);
    else closed.push(p);
  }

  say(`freshness: alive=${alive.length} closed=${closed.length} fetch_failures=${fetchFailures.length}`);
  return { alive, closed, fetchFailures };
}

export { freshnessCheck, companiesInPool, liveJobIds };