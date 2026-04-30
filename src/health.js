// Per-company health tracking + alert evaluation. Catches silent failures:
// slug breakage (HTTP 4xx/5xx), suspicious zero counts (board emptied
// overnight), sustained zero counts (productive board now persistently
// quiet), and recovery (slug back online).
//
// State lives in data/health.json — small (one entry per company × ~14
// days of history). Committed to the repo for debugging.

const fs = require('node:fs');
const path = require('node:path');

const HISTORY_DAYS = 14;

function loadHealth(healthPath) {
  try { return JSON.parse(fs.readFileSync(healthPath, 'utf8')); } catch { return null; }
}

function emptyEntry() {
  return {
    last_success: null,
    last_status: null,
    last_job_count: null,
    last_http_status: null,
    last_error: null,
    consecutive_failures: 0,
    consecutive_zero_days: 0,
    last_nonzero_count: null,
    last_nonzero_date: null,
    history: [],
  };
}

function daysBetween(a, b) {
  const aD = new Date(a + 'T00:00:00Z');
  const bD = new Date(b + 'T00:00:00Z');
  return Math.round((bD - aD) / 86400000);
}

// Apply today's runResults to the health record. runResults is an array of
//   { name, status: "ok"|"zero"|"fail", jobs: number|null, http_status?, error? }
function update(health, runResults, todayDate) {
  health = health || { last_updated: null, companies: {} };
  health.last_updated = new Date().toISOString();

  for (const r of runResults) {
    const entry = health.companies[r.name] || emptyEntry();

    if (r.status === 'ok' || r.status === 'zero') {
      entry.last_success = todayDate;
      entry.last_status = r.status;
      entry.last_job_count = r.jobs;
      entry.last_http_status = r.http_status ?? 200;
      entry.last_error = null;
      entry.consecutive_failures = 0;
      if ((r.jobs || 0) > 0) {
        entry.consecutive_zero_days = 0;
        entry.last_nonzero_count = r.jobs;
        entry.last_nonzero_date = todayDate;
      } else {
        entry.consecutive_zero_days = (entry.consecutive_zero_days || 0) + 1;
      }
    } else {
      entry.last_status = 'fail';
      entry.last_http_status = r.http_status ?? null;
      entry.last_error = r.error || null;
      entry.consecutive_failures = (entry.consecutive_failures || 0) + 1;
      // Don't touch last_success / last_job_count / nonzero fields on fail —
      // they preserve the most recent good fetch for the alert message.
    }

    // History stored newest-first; drop entries older than HISTORY_DAYS.
    const hist = entry.history || [];
    // Replace today's entry if it already exists (idempotent re-runs).
    const existingTodayIdx = hist.findIndex(h => h.date === todayDate);
    const todayHist = { date: todayDate, status: r.status, jobs: r.jobs ?? null };
    if (existingTodayIdx >= 0) hist[existingTodayIdx] = todayHist;
    else hist.unshift(todayHist);
    entry.history = hist
      .filter(h => daysBetween(h.date, todayDate) < HISTORY_DAYS)
      .sort((a, b) => b.date.localeCompare(a.date));

    health.companies[r.name] = entry;
  }

  return health;
}

// Returns { hard_failure: [], suspicious_zero: [], sustained_zero: [], recovery: [] }
// where each array contains { company, entry, ... } objects.
function evaluateAlerts(health, companies, todayDate, config) {
  const cfg = (config && config.health_alerts) || {};
  const zeroThresh    = cfg.suspicious_zero_threshold ?? 10;
  const sustainedDays = cfg.sustained_zero_days ?? 5;
  const sustainedMin  = cfg.sustained_zero_min_history ?? 5;

  const alerts = { hard_failure: [], suspicious_zero: [], sustained_zero: [], recovery: [] };

  for (const c of companies) {
    const entry = (health.companies || {})[c.name];
    if (!entry || !entry.history || !entry.history.length) continue;
    const today = entry.history[0];
    if (today.date !== todayDate) continue;  // company didn't run today
    const yesterday = entry.history[1];

    // 1. Hard failure — any non-200 today.
    if (entry.last_status === 'fail') {
      alerts.hard_failure.push({ company: c, entry });
      continue;  // hard failure short-circuits the other zero/recovery checks
    }

    // 4. Recovery — today succeeded, yesterday's run was a failure.
    if ((today.status === 'ok' || today.status === 'zero') && yesterday && yesterday.status === 'fail') {
      let failStreak = 0;
      for (let i = 1; i < entry.history.length; i++) {
        if (entry.history[i].status === 'fail') failStreak++;
        else break;
      }
      alerts.recovery.push({ company: c, entry, fail_streak: failStreak });
    }

    // 2. Suspicious zero — first day of zero on a previously-busy board.
    if (today.status === 'zero'
        && entry.consecutive_zero_days === 1
        && entry.last_nonzero_count != null
        && entry.last_nonzero_count >= zeroThresh) {
      alerts.suspicious_zero.push({ company: c, entry });
      continue;
    }

    // 3. Sustained zero — N consecutive zero days from a board that has
    //    historically returned at least sustainedMin jobs.
    if (today.status === 'zero'
        && entry.consecutive_zero_days >= sustainedDays
        && entry.last_nonzero_count != null
        && entry.last_nonzero_count >= sustainedMin) {
      alerts.sustained_zero.push({ company: c, entry });
    }
  }

  return alerts;
}

function alertCount(alerts) {
  return (alerts.hard_failure.length || 0)
       + (alerts.suspicious_zero.length || 0)
       + (alerts.sustained_zero.length || 0)
       + (alerts.recovery.length || 0);
}

function writeHealth(healthPath, health) {
  fs.mkdirSync(path.dirname(healthPath), { recursive: true });
  fs.writeFileSync(healthPath, JSON.stringify(health, null, 2) + '\n');
}

module.exports = { loadHealth, update, evaluateAlerts, alertCount, writeHealth, daysBetween, HISTORY_DAYS };
