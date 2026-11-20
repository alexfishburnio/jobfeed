// Self-healing slug recovery.
//
// Triggered from src/daily.js when a company's fetch fails twice in a row
// (consecutive_failures >= 2 and today's run also failed). Probes a small
// set of slug variants across all three ATS endpoints. On first hit:
// updates companies.json and records a recovery entry in health.json.
// On full miss: records a persistent-failure entry so the weekly digest
// can surface it for manual investigation.
//
// Trigger condition is "exactly consecutive_failures == 2 today" — we
// retry recovery once; after that the persistent_failure flag is set
// and no further recovery attempts fire until a daily fetch succeeds
// again (which clears both flags).

const fs = require('node:fs');
const path = require('node:path');

const { fetchCompany } = require('./fetcher');

const ATS_ORDER = ['greenhouse', 'lever', 'ashby'];

// Slug variants to try (in order). The company's current slug is skipped
// since it just failed.
function slugVariants(companyName) {
  const lower = (companyName || '').toLowerCase();
  const stripped = lower.replace(/[^a-z0-9]/g, '');       // "The Trade Desk" -> "thetradedesk"
  const hyphenated = lower.replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
  const noArticles = lower.replace(/\b(the|a|an)\s+/g, '').replace(/[^a-z0-9]/g, '');
  const variants = new Set([
    stripped,
    hyphenated,
    stripped + 'hq',
    stripped + 'careers',
    noArticles,                // fallback: catch "The Trade Desk" -> "tradedesk"
  ]);
  variants.delete('');
  return [...variants];
}

// Returns true on fetch success (HTTP 200 with any payload — including
// zero jobs). False on non-200 or network error.
async function probeSlug(ats, slug) {
  try {
    const result = await fetchCompany({ ats, slug, name: `probe:${ats}:${slug}` });
    return { ok: true, jobs: result.jobs.length };
  } catch (err) {
    return { ok: false, http_status: err.status || null, error: err.message };
  }
}

// Attempt recovery for a single company. Returns one of:
//   { recovered: true,  new_ats, new_slug, jobs }
//   { recovered: false, attempts: [...] }
async function recoverCompany(company, { log, delayMs } = {}) {
  const say = log || (m => process.stderr.write(m + '\n'));
  const delay = Number.isFinite(delayMs) ? delayMs : 500;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const variants = slugVariants(company.name).filter(v => v !== company.slug);
  const attempts = [];
  let first = true;
  for (const variant of variants) {
    for (const ats of ATS_ORDER) {
      // Skip exact (ats, slug) that the daily job just failed on.
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

// Persist a slug change to companies.json (safe atomic write).
function updateCompaniesJson(companiesPath, companyName, newAts, newSlug) {
  const text = fs.readFileSync(companiesPath, 'utf8');
  const arr = JSON.parse(text);
  let touched = false;
  for (const c of arr) {
    if (c.name === companyName) {
      c.ats = newAts;
      c.slug = newSlug;
      touched = true;
      break;
    }
  }
  if (!touched) throw new Error(`companies.json: no entry for "${companyName}"`);
  const tmp = companiesPath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(arr, null, 2) + '\n');
  fs.renameSync(tmp, companiesPath);
  return arr;
}

// Decide which companies should trigger recovery this run.
//   runResults: [{ name, status: 'ok'|'zero'|'fail', http_status, ... }]
//   health:     existing data/health.json (BEFORE today's update is merged)
//
// A company qualifies when:
//   - today's run failed
//   - previous consecutive_failures counter was >= 1
//     (so today's fail brings it to >= 2)
//   - persistent_failure is NOT already set (already attempted)
function selectRecoveryCandidates(runResults, companiesByName, health) {
  const out = [];
  const existing = (health && health.companies) || {};
  for (const r of runResults) {
    if (r.status !== 'fail') continue;
    const h = existing[r.name] || {};
    const prevFails = h.consecutive_failures || 0;
    if (prevFails < 1) continue;   // first fail — wait a day
    if (h.persistent_failure) continue;  // already attempted + failed
    const company = companiesByName.get(r.name);
    if (!company) continue;
    out.push(company);
  }
  return out;
}

// Record recovery outcome into the health.json entry for a company. Mutates
// `health` in place. `outcome` is the return of recoverCompany().
function recordRecoveryOutcome(health, companyName, outcome, todayDate) {
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
    // Trim recovery log to 30 entries (bounded growth).
    if (entry.recoveries.length > 30) entry.recoveries.length = 30;
    // Clear any persistent-failure flag now that recovery worked.
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

// Clear any lingering persistent_failure flag when a company's fetch
// starts succeeding again. Called from daily.js for companies with
// today.status === 'ok' or 'zero'.
function clearPersistentFailureOnSuccess(health, companyName) {
  if (!health || !health.companies || !health.companies[companyName]) return;
  if (health.companies[companyName].persistent_failure) {
    delete health.companies[companyName].persistent_failure;
  }
}

module.exports = {
  slugVariants,
  probeSlug,
  recoverCompany,
  updateCompaniesJson,
  selectRecoveryCandidates,
  recordRecoveryOutcome,
  clearPersistentFailureOnSuccess,
  ATS_ORDER,
};
