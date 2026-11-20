// Self-healing slug recovery. Pure functions — the caller persists the
// mutated companies array via KV (companies live in KV so the daily worker
// can update them atomically without a git commit).

import { fetchCompany } from './fetcher.js';

const ATS_ORDER = ['greenhouse', 'lever', 'ashby'];

export function slugVariants(companyName) {
  const lower = (companyName || '').toLowerCase();
  const stripped = lower.replace(/[^a-z0-9]/g, '');
  const hyphenated = lower.replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
  const noArticles = lower.replace(/\b(the|a|an)\s+/g, '').replace(/[^a-z0-9]/g, '');
  const variants = new Set([
    stripped,
    hyphenated,
    stripped + 'hq',
    stripped + 'careers',
    noArticles,
  ]);
  variants.delete('');
  return [...variants];
}

async function probeSlug(ats, slug) {
  try {
    const result = await fetchCompany({ ats, slug, name: `probe:${ats}:${slug}` });
    return { ok: true, jobs: result.jobs.length };
  } catch (err) {
    return { ok: false, http_status: err.status || null, error: err.message };
  }
}

export async function recoverCompany(company, { log, delayMs } = {}) {
  const say = log || (m => console.log(m));
  const delay = Number.isFinite(delayMs) ? delayMs : 500;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const variants = slugVariants(company.name).filter(v => v !== company.slug);
  const attempts = [];
  let first = true;
  for (const variant of variants) {
    for (const ats of ATS_ORDER) {
      if (ats === company.ats && variant === company.slug) continue;
      if (!first) await sleep(delay);
      first = false;
      const r = await probeSlug(ats, variant);
      attempts.push({ ats, slug: variant, ...r });
      if (r.ok && r.jobs > 0) {
        say(`  recovery OK ${company.name}: ${ats}/${variant} (${r.jobs} jobs)`);
        return { recovered: true, new_ats: ats, new_slug: variant, jobs: r.jobs, attempts };
      }
    }
  }
  say(`  recovery MISS ${company.name}: tried ${attempts.length} variant×ATS combos`);
  return { recovered: false, attempts };
}

export function selectRecoveryCandidates(runResults, companiesByName, health) {
  const out = [];
  const existing = (health && health.companies) || {};
  for (const r of runResults) {
    if (r.status !== 'fail') continue;
    const h = existing[r.name] || {};
    const prevFails = h.consecutive_failures || 0;
    if (prevFails < 1) continue;
    if (h.persistent_failure) continue;
    const company = companiesByName.get(r.name);
    if (!company) continue;
    out.push(company);
  }
  return out;
}

export function recordRecoveryOutcome(health, companyName, outcome, todayDate) {
  health.companies = health.companies || {};
  const entry = health.companies[companyName] || {};
  if (outcome.recovered) {
    entry.recoveries = entry.recoveries || [];
    entry.recoveries.unshift({
      date: todayDate,
      old_ats: outcome.old_ats,
      old_slug: outcome.old_slug,
      new_ats: outcome.new_ats,
      new_slug: outcome.new_slug,
      jobs_found: outcome.jobs,
    });
    if (entry.recoveries.length > 30) entry.recoveries.length = 30;
    delete entry.persistent_failure;
  } else {
    entry.persistent_failure = {
      since: todayDate,
      ats: outcome.old_ats,
      slug: outcome.old_slug,
      http_status: outcome.last_http_status || null,
      variants_tried: (outcome.attempts || []).length,
      reason: outcome.last_http_status
        ? `HTTP ${outcome.last_http_status} since ${todayDate}; ${(outcome.attempts || []).length} variant×ATS combos tried, no success`
        : `fetch failing since ${todayDate}; ${(outcome.attempts || []).length} variant×ATS combos tried, no success`,
    };
  }
  health.companies[companyName] = entry;
}

export function clearPersistentFailureOnSuccess(health, companyName) {
  if (!health || !health.companies || !health.companies[companyName]) return;
  if (health.companies[companyName].persistent_failure) {
    delete health.companies[companyName].persistent_failure;
  }
}

// Mutate a companies array in-place to update one company's ats+slug.
// Returns the mutated array for convenience.
export function updateCompanySlug(companies, companyName, newAts, newSlug) {
  let touched = false;
  for (const c of companies) {
    if (c.name === companyName) {
      c.ats = newAts;
      c.slug = newSlug;
      touched = true;
      break;
    }
  }
  if (!touched) throw new Error(`no company named "${companyName}"`);
  return companies;
}

export { ATS_ORDER };
