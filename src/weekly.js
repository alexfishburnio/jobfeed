// Weekly digest: reads the last 7 daily snapshots, aggregates roles whose
// first_seen_date falls within the week window, dedupes, builds the one
// email that lands each Monday 09:00 ET.

const fs = require('node:fs');
const path = require('node:path');

const { dedupePostings } = require('./dedupe');
const { evaluateAlerts } = require('./health');
const {
  sortPostings, pickTopForBody,
  tierBreakdownHtml, tierPillHtml,
  postingRow, postingRowTopFive,
  formatShortDate, escapeHtml,
  sendOrPreview, TIER_LABELS,
} = require('./emailer');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const HEALTH_PATH = path.join(DATA_DIR, 'health.json');
const CONFIG_PATH = path.join(ROOT, 'config.json');
const COMPANIES_PATH = path.join(ROOT, 'companies.json');
const PUBLIC_DIR = path.join(ROOT, 'public');
const WEEKLY_PREVIEW = path.join(PUBLIC_DIR, 'weekly-preview.html');

const log = msg => process.stderr.write(msg + '\n');

function todayInET() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

function daysBefore(dateStr, n) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - n);
  return dt.toISOString().slice(0, 10);
}

function listSnapshots(dataDir) {
  if (!fs.existsSync(dataDir)) return [];
  return fs.readdirSync(dataDir)
    .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort();
}

function readJsonOrNull(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

// Compute the 7-day window ending today (inclusive). Returns the list of
// expected ISO dates and the earliest/latest for header rendering.
function weekWindow(today) {
  const dates = [];
  for (let i = 6; i >= 0; i--) dates.push(daysBefore(today, i));
  return { dates, start: dates[0], end: dates[6] };
}

// Aggregate the week's new roles from daily snapshots. Preference rule:
// read the latest snapshot in the window as the authoritative source for
// posting details (it carries all currently-tracked postings including
// status transitions). Fall back to older snapshots only for postings
// whose first_seen_date fell within the window but closed/aged out before
// the latest snapshot was written.
function aggregateWeek(dataDir, windowDates) {
  // Pass 1: build id -> posting map, latest-snapshot-wins. Walk the window
  // oldest → newest so later snapshots overwrite earlier ones.
  const byId = new Map();
  const windowSet = new Set(windowDates);
  for (const date of windowDates) {
    const file = path.join(dataDir, `${date}.json`);
    if (!fs.existsSync(file)) continue;
    const snap = readJsonOrNull(file);
    if (!snap) continue;
    for (const p of (snap.postings || [])) {
      if (!p.first_seen_date || !windowSet.has(p.first_seen_date)) continue;
      byId.set(p.id, p);
    }
  }
  return [...byId.values()];
}

// Which days in the window completed a daily run (snapshot file exists)?
function daysCovered(dataDir, windowDates) {
  const result = { success: [], missing: [], failed: [] };
  for (const date of windowDates) {
    const file = path.join(dataDir, `${date}.json`);
    if (!fs.existsSync(file)) {
      result.missing.push(date);
      continue;
    }
    const snap = readJsonOrNull(file);
    if (!snap) {
      result.failed.push({ date, reason: 'snapshot unreadable' });
      continue;
    }
    const failed = snap.fetch_summary && snap.fetch_summary.companies_failed;
    const total  = snap.fetch_summary && snap.fetch_summary.companies_total;
    // Treat "> 20% of companies failed" as a failed day, otherwise successful.
    if (failed && total && failed / total > 0.2) {
      const names = (snap.fetch_summary.failures || []).map(f => f.company).slice(0, 5).join(', ');
      result.failed.push({ date, reason: `${failed}/${total} companies failed to fetch (${names}${snap.fetch_summary.failures.length > 5 ? ', ...' : ''})` });
    } else {
      result.success.push(date);
    }
  }
  return result;
}

// Inspect health.json across the week window and surface per-company issues.
// Returns { companies: [{name, reason}], count }.
function slugHealthIssues(health, companies, windowDates, config) {
  if (!health || !health.companies) return { companies: [], count: 0 };
  const windowSet = new Set(windowDates);
  const issues = new Map();

  const note = (companyName, reason) => {
    if (!issues.has(companyName)) issues.set(companyName, reason);
  };

  // 1. Hard failures in any day of the window (any history entry with status=fail)
  for (const c of companies) {
    const entry = health.companies[c.name];
    if (!entry || !entry.history) continue;
    const inWindow = entry.history.filter(h => windowSet.has(h.date));
    if (!inWindow.length) continue;

    const failDays = inWindow.filter(h => h.status === 'fail');
    if (failDays.length) {
      const last = failDays[0];  // history is newest-first
      note(c.name, `fetch failed ${failDays.length} day${failDays.length === 1 ? '' : 's'} this week (${c.ats}:${c.slug}, last: ${last.date})`);
      continue;
    }
  }

  // 2. Suspicious + sustained zero evaluated from the latest history entry.
  // Reuse the daily alert evaluation logic — the latest-day eval captures
  // sustained-zero streaks and today's suspicious-zero flips.
  const latestDate = [...windowDates].sort().reverse()[0];
  const alerts = evaluateAlerts(health, companies, latestDate, config);
  for (const a of alerts.suspicious_zero) {
    const had = a.entry.last_nonzero_count != null
      ? `had ${a.entry.last_nonzero_count} on ${a.entry.last_nonzero_date}`
      : `no prior history`;
    note(a.company.name, `suspicious zero (${a.company.ats}:${a.company.slug}, ${had})`);
  }
  for (const a of alerts.sustained_zero) {
    note(a.company.name, `zero jobs for ${a.entry.consecutive_zero_days} consecutive days (${a.company.ats}:${a.company.slug})`);
  }

  const out = [...issues.entries()].map(([name, reason]) => ({ name, reason }));
  out.sort((a, b) => a.name.localeCompare(b.name));
  return { companies: out, count: out.length };
}

function countsByTier(postings) {
  const counts = {};
  for (const p of postings) counts[String(p.tier)] = (counts[String(p.tier)] || 0) + 1;
  return counts;
}

function buildInfrastructureHtml({ coverage, slugIssues, config }) {
  const total = coverage.success.length + coverage.missing.length + coverage.failed.length;
  const allClean = coverage.missing.length === 0
                   && coverage.failed.length === 0
                   && slugIssues.count === 0;

  const header = `<h2 style="font-size:14px;margin:32px 0 8px;color:#5f6368;letter-spacing:0.04em;text-transform:uppercase;">Infrastructure</h2>`;

  if (allClean) {
    return header + `<div style="font-size:13px;color:#5f6368;">All ${total} runs completed. No slug issues.</div>`;
  }

  const bits = [];
  bits.push(`<div style="font-size:13px;color:#202124;line-height:1.6;"><strong>${coverage.success.length} of ${total}</strong> daily runs completed.</div>`);

  if (coverage.missing.length) {
    const li = coverage.missing.map(d => `<li>${escapeHtml(formatShortDate(d))} — no snapshot written</li>`).join('');
    bits.push(`<div style="font-size:13px;color:#202124;margin-top:8px;">Missing days:</div><ul style="font-size:13px;color:#5f6368;margin:4px 0 0 20px;padding:0;">${li}</ul>`);
  }
  if (coverage.failed.length) {
    const li = coverage.failed.map(f => `<li>${escapeHtml(formatShortDate(f.date))} — ${escapeHtml(f.reason)}</li>`).join('');
    bits.push(`<div style="font-size:13px;color:#202124;margin-top:8px;">Failed days:</div><ul style="font-size:13px;color:#5f6368;margin:4px 0 0 20px;padding:0;">${li}</ul>`);
  }
  if (slugIssues.count) {
    const li = slugIssues.companies.map(c => `<li><strong>${escapeHtml(c.name)}</strong> — ${escapeHtml(c.reason)}</li>`).join('');
    bits.push(`<div style="font-size:13px;color:#202124;margin-top:8px;">${slugIssues.count} compan${slugIssues.count === 1 ? 'y' : 'ies'} with slug issues:</div><ul style="font-size:13px;color:#5f6368;margin:4px 0 0 20px;padding:0;">${li}</ul>`);
  }

  return header + bits.join('');
}

function buildSubject({ newKept, isTest }) {
  const n = newKept.length;
  const base = `Weekly job digest — ${n} new role${n === 1 ? '' : 's'} this week`;
  return isTest ? `TEST — weekly digest preview — ${base}` : base;
}

function buildHtml({ windowStart, windowEnd, newKept, coverage, slugIssues, config, feedUrl, isTest }) {
  const sortedNew = sortPostings(newKept);
  const tpCfg = config.top_picks || {};
  const topMax = Number.isFinite(tpCfg.max_count) ? tpCfg.max_count : 5;
  const topMinFit = Number.isFinite(tpCfg.min_fit_score) ? tpCfg.min_fit_score : 2.5;
  const top5 = pickTopForBody(sortedNew, topMax, topMinFit);

  // Applied: not implemented in current data model. The spec allows for
  // applied roles at the bottom with muted styling — we treat `applied`
  // as a future field on the posting. Until a posting carries it, this
  // section is empty.
  const appliedRoles = sortedNew.filter(p => p.applied === true);
  const visibleRoles = sortedNew.filter(p => !(p.applied === true));

  const tierHtml = tierBreakdownHtml(sortedNew);

  const headerLine = `${formatShortDate(windowStart)} to ${formatShortDate(windowEnd)}`;
  const totalText = `${sortedNew.length} new role${sortedNew.length === 1 ? '' : 's'}`;

  const topSection = top5.length
    ? `<h2 style="font-size:16px;margin:24px 0 8px;color:#202124;">Top ${top5.length} pick${top5.length === 1 ? '' : 's'} this week</h2>${top5.map(postingRowTopFive).join('')}`
    : '';

  const allSection = visibleRoles.length
    ? `<h2 style="font-size:16px;margin:24px 0 8px;color:#202124;">All new roles (${visibleRoles.length})</h2>${visibleRoles.map(p => postingRow(p)).join('')}`
    : `<p style="color:#5f6368;">No new roles this week.</p>`;

  const appliedSection = appliedRoles.length
    ? `<h2 style="font-size:14px;margin:24px 0 8px;color:#5f6368;letter-spacing:0.04em;text-transform:uppercase;">Applied (${appliedRoles.length})</h2>${appliedRoles.map(p => postingRow(p, { muted: true })).join('')}`
    : '';

  const infraSection = buildInfrastructureHtml({ coverage, slugIssues, config });

  const testBanner = isTest
    ? `<div style="background:#fff3cd;color:#664d03;padding:12px 16px;border-radius:6px;margin-bottom:16px;font-size:13px;">TEST SEND — this is a preview of the weekly digest. Real weekly digests arrive every Monday 09:00 ET.</div>`
    : '';

  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#fafafa;">
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;max-width:640px;margin:0 auto;padding:24px;background:#fff;color:#202124;">
  ${testBanner}
  <div style="color:#5f6368;font-size:12px;margin-bottom:4px;">${escapeHtml(headerLine)}</div>
  <h1 style="font-size:22px;margin:0 0 4px;">${escapeHtml(totalText)} this week</h1>
  ${tierHtml}
  ${topSection}
  ${allSection}
  ${appliedSection}
  ${infraSection}
  <div style="margin-top:24px;padding-top:14px;border-top:1px solid #ddd;color:#5f6368;font-size:12px;">
    <a href="${escapeHtml(feedUrl)}" style="color:#1a73e8;">Full feed</a>
  </div>
</div></body></html>`;
}

async function runWeekly({ dryRun = false, isTest = false } = {}) {
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const companies = JSON.parse(fs.readFileSync(COMPANIES_PATH, 'utf8'));
  const health = readJsonOrNull(HEALTH_PATH);

  const today = todayInET();
  const { dates: windowDates, start, end } = weekWindow(today);
  log(`weekly digest — window ${start} .. ${end} (today=${today})`);

  const aggregated = aggregateWeek(DATA_DIR, windowDates);
  log(`aggregated ${aggregated.length} postings from ${windowDates.length}-day window`);

  const deduped = dedupePostings(aggregated);
  log(`deduped to ${deduped.length} rows`);

  const coverage = daysCovered(DATA_DIR, windowDates);
  log(`coverage — success=${coverage.success.length} missing=${coverage.missing.length} failed=${coverage.failed.length}`);

  const slugIssues = slugHealthIssues(health, companies, windowDates, config);
  log(`slug issues — ${slugIssues.count}`);

  const subject = buildSubject({ newKept: deduped, isTest });
  const html = buildHtml({
    windowStart: start,
    windowEnd: end,
    newKept: deduped,
    coverage,
    slugIssues,
    config,
    feedUrl: config.feed_page_url,
    isTest,
  });

  log(`preflight: new=${deduped.length} dry_run=${dryRun} test=${isTest}`);
  log(`subject: ${subject}`);

  const result = await sendOrPreview({
    html, subject, dryRun, previewPath: WEEKLY_PREVIEW,
  });
  if (result.dryRun) {
    log(`DRY RUN — preview written to ${path.relative(ROOT, WEEKLY_PREVIEW)}`);
    log(`Subject: ${subject}`);
  } else if (result.error) {
    log(`send FAILED: ${JSON.stringify(result.error)}`);
    throw new Error(`Resend error: ${JSON.stringify(result.error)}`);
  } else {
    log(`sent — id=${result.id} from=${result.from} to=${result.to}`);
    log(`Subject: ${subject}`);
  }
  return { subject, id: result.id, counts: { new: deduped.length, coverage, slugIssues: slugIssues.count } };
}

// Failure alert (the only "exception to one-email-per-week" allowed).
async function sendFailureAlert(err) {
  const { Resend } = require('resend');
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    log(`failure alert skipped: RESEND_API_KEY not set`);
    return;
  }
  const today = todayInET();
  const from = process.env.RESEND_FROM || 'onboarding@resend.dev';
  const to = process.env.RESEND_TO || 'alexfishburn@gmail.com';
  const subject = `WEEKLY DIGEST FAILED ${today}`;
  const stack = escapeHtml(err.stack || err.message || String(err));
  const html = `<!doctype html>
<html><body style="margin:0;padding:24px;font-family:-apple-system,BlinkMacSystemFont,Helvetica,Arial,sans-serif;">
<h1 style="font-size:20px;color:#b00020;">Weekly digest failed</h1>
<div style="color:#5f6368;font-size:12px;margin-bottom:12px;">${escapeHtml(today)}</div>
<pre style="background:#f8f9fa;padding:12px;border-radius:6px;overflow-x:auto;font-size:12px;white-space:pre-wrap;">${stack}</pre>
</body></html>`;
  const resend = new Resend(apiKey);
  await resend.emails.send({ from, to: [to], subject, html });
}

function parseArgs(argv) {
  return {
    dryRun: argv.includes('--dry-run'),
    test:   argv.includes('--test'),
  };
}

if (require.main === module) {
  const args = parseArgs(process.argv);
  runWeekly({ dryRun: args.dryRun, isTest: args.test })
    .then(r => {
      process.stdout.write(JSON.stringify({ ok: true, ...r }, null, 2) + '\n');
    })
    .catch(async err => {
      log(`fatal: ${err.stack || err.message}`);
      if (!args.dryRun) {
        try { await sendFailureAlert(err); log('failure alert sent'); }
        catch (e) { log(`failure alert send error: ${e.message}`); }
      }
      process.exit(1);
    });
}

module.exports = {
  runWeekly, weekWindow, aggregateWeek, daysCovered, slugHealthIssues,
  buildHtml, buildSubject, buildInfrastructureHtml,
};
