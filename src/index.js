// Daily orchestrator: fetch → parse → score → diff → snapshot → state →
// feed.json → email. Runs end-to-end. Use `--dry-run-email` to skip the
// actual Resend send (HTML preview written to public/email-preview.html).

const fs = require('node:fs');
const path = require('node:path');

const { fetchCompany } = require('./fetcher');
const { parsePosting } = require('./parser');
const { scoreAll } = require('./scorer');
const { diff, writeSnapshot, writeState } = require('./differ');
const { buildFeed, writeFeed } = require('./exporter');
const {
  buildSubject, buildHtml, sendOrPreview,
  buildHealthSubject, buildHealthHtml, sendHealthAlertOrPreview,
  sortPostings, pickTopByCompany, pickTopForBody,
} = require('./emailer');
const { dedupePostings } = require('./dedupe');
const {
  loadHealth, update: updateHealth, evaluateAlerts, alertCount, writeHealth,
} = require('./health');

const ROOT = path.join(__dirname, '..');
const CONFIG_PATH    = path.join(ROOT, 'config.json');
const COMPANIES_PATH = path.join(ROOT, 'companies.json');
const DATA_DIR       = path.join(ROOT, 'data');
const STATE_PATH     = path.join(DATA_DIR, 'state.json');
const HEALTH_PATH    = path.join(DATA_DIR, 'health.json');
const PUBLIC_DIR     = path.join(ROOT, 'public');
const EMAIL_PREVIEW  = path.join(PUBLIC_DIR, 'email-preview.html');
const HEALTH_PREVIEW = path.join(PUBLIC_DIR, 'health-alert-preview.html');
const HEALTH_REPO_URL = 'https://github.com/alexfishburnio/jobfeed/blob/main/data/health.json';

const REQUEST_DELAY_MS = 1500;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = msg => process.stderr.write(msg + '\n');

function todayInET() {
  // YYYY-MM-DD in America/New_York; en-CA locale renders this directly.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

function parseArgs(argv) {
  return {
    dryRunEmail: argv.includes('--dry-run-email'),
    limit: (() => {
      const i = argv.indexOf('--limit');
      return i >= 0 ? parseInt(argv[i + 1], 10) : null;
    })(),
  };
}

async function fetchAll(companies) {
  const successes = [];
  const failures = [];
  const runResults = [];  // for health module — { name, status, jobs, http_status?, error? }
  let first = true;
  for (const c of companies) {
    if (!first) await sleep(REQUEST_DELAY_MS);
    first = false;
    try {
      const { jobs } = await fetchCompany(c);
      successes.push({ company: c, jobs });
      runResults.push({
        name: c.name,
        status: jobs.length === 0 ? 'zero' : 'ok',
        jobs: jobs.length,
        http_status: 200,
      });
      log(`  ✓ ${c.ats}/${c.slug} (${c.name}) — ${jobs.length}`);
    } catch (err) {
      failures.push({ company: c, error: err.message });
      runResults.push({
        name: c.name,
        status: 'fail',
        jobs: null,
        http_status: err.status || null,
        error: err.message,
      });
      log(`  ✗ ${c.ats}/${c.slug} (${c.name}) — ${err.message}`);
    }
  }
  return { successes, failures, runResults };
}

async function main() {
  const args = parseArgs(process.argv);
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  let companies = JSON.parse(fs.readFileSync(COMPANIES_PATH, 'utf8'));
  if (args.limit) {
    companies = companies.slice(0, args.limit);
    log(`limit: probing first ${companies.length} companies`);
  }

  const date = todayInET();
  const startedAt = new Date().toISOString();
  log(`daily run — ${date} — ${companies.length} companies${args.dryRunEmail ? ' (DRY-RUN EMAIL)' : ''}`);

  // 1. Fetch
  log('fetching...');
  const { successes, failures, runResults } = await fetchAll(companies);
  log(`fetched ${successes.length}/${companies.length} ok, ${failures.length} failed`);

  // 2. Parse
  const parsed = [];
  for (const { company, jobs } of successes) {
    for (const j of jobs) {
      try { parsed.push(parsePosting(j, company, config)); }
      catch (err) { log(`  parse error for ${company.name}: ${err.message}`); }
    }
  }
  log(`parsed ${parsed.length} postings`);

  // 3. Score
  const { kept, excluded, dropped } = scoreAll(parsed, config);
  log(`scored — kept=${kept.length} excluded=${excluded.length} dropped: pm_gate=${dropped.pm_gate} location=${dropped.location} exclude_title=${dropped.exclude_title}`);

  // 4. Diff (Phase 1.4: postings carry first_seen_date; status reflects current
  // state across runs — "active" / "closed_today" / "closed").
  const d = diff({ kept, excluded }, STATE_PATH, DATA_DIR, date);

  // Phase 1.7 idempotent gate: when the daily-feed primary already ran
  // today (state.date == today) and this run discovered no new IDs, this
  // is the daily-fallback re-fire. Skip the email + health alert sends
  // (they would be duplicates). Snapshot/state/feed writes are still
  // performed — they're idempotent if data is unchanged.
  const isDuplicateRun = d.prev_date === date && d.newly_discovered === 0;
  log(`idempotent: prev_date=${d.prev_date} today=${date} newly_discovered=${d.newly_discovered} → ${isDuplicateRun ? 'SKIP email/alert' : 'normal send'}`);

  // Today's "new" = first_seen_date == today AND currently active.
  const newKeptRaw         = d.kept.filter(p => p.status === 'active' && p.first_seen_date === date);
  const ongoingKeptRaw     = d.kept.filter(p => p.status === 'active' && p.first_seen_date !== date);
  const closedTodayKeptRaw = d.kept.filter(p => p.status === 'closed_today');
  const closedKeptRaw      = d.kept.filter(p => p.status === 'closed');
  const newExcludedRaw     = d.excluded.filter(p => p.status === 'active' && p.first_seen_date === date);

  const newKept         = dedupePostings(newKeptRaw);
  const ongoingKept     = dedupePostings(ongoingKeptRaw);
  const closedTodayKept = dedupePostings(closedTodayKeptRaw);
  const closedKept      = dedupePostings(closedKeptRaw);
  const newExcluded     = dedupePostings(newExcludedRaw);

  log(`diff — new=${newKept.length} ongoing=${ongoingKept.length} closed_today=${closedTodayKept.length} closed=${closedKept.length} (prev=${d.prev_count} → today=${d.today_total_count}; new_raw=${newKeptRaw.length})`);

  // 5. Write snapshot + state. Drop the full job description from persisted
  // artifacts — descriptions are needed during scoring but bloat the daily
  // snapshot ~50× and aren't useful downstream. The apply_url links to the
  // live posting if a description is ever needed.
  //
  // Dry-run is read-only: no snapshot, no state, no feed write. Only the
  // email-preview.html is produced. This keeps state.json clean across
  // repeated dry-runs so the next real run sees a true diff.
  const stripDescription = ({ description, ...rest }) => rest;
  const snapshot = {
    date,
    generated_at: startedAt,
    fetch_summary: {
      companies_total: companies.length,
      companies_ok: successes.length,
      companies_failed: failures.length,
      failures: failures.map(f => ({ company: f.company.name, error: f.error })),
    },
    counts: {
      new_today:        newKeptRaw.length,
      ongoing:          ongoingKeptRaw.length,
      closed_today:     closedTodayKeptRaw.length,
      closed:           closedKeptRaw.length,
      excluded_new:     newExcludedRaw.length,
      excluded_total:   d.excluded.length,
    },
    postings: d.kept.map(stripDescription),
    excluded: d.excluded.map(stripDescription),
  };

  if (!args.dryRunEmail) {
    writeSnapshot(DATA_DIR, date, snapshot);
    writeState(STATE_PATH, date, d.state_map);
    log(`wrote data/${date}.json and data/state.json`);
    const feed = buildFeed(DATA_DIR, config.feed_retention_days || 30);
    writeFeed(PUBLIC_DIR, feed);
    log(`wrote public/feed.json (${feed.days.length} day(s))`);
  } else {
    log('dry-run: skipping writes to data/ and public/feed.json');
    // Verification dump for review — top postings with full scoring fields
    // (these are stripped from the email HTML, so we surface them here).
    const sortedNew = sortPostings(newKept);
    const tpCfg = config.top_picks || {};
    const top5 = pickTopForBody(
      sortedNew,
      Number.isFinite(tpCfg.max_count) ? tpCfg.max_count : 5,
      Number.isFinite(tpCfg.min_fit_score) ? tpCfg.min_fit_score : 0,
    );
    const dump = {
      counts: snapshot.counts,
      top5: top5.map(p => ({
        priority_score: p.priority_score,
        fit_score: p.fit_score,
        realism_score: p.realism_score,
        level: p.level,
        tier: p.tier,
        mode: p.mode,
        company: p.company,
        title: p.title,
        salary_min_base: p.salary_min_base,
        salary_max_base: p.salary_max_base,
        recommended_resume: p.recommended_resume,
        first_seen_date: p.first_seen_date,
        status: p.status,
      })),
      top50: sortedNew.slice(0, 50).map(p => ({
        priority_score: p.priority_score,
        fit_score: p.fit_score,
        realism_score: p.realism_score,
        level: p.level,
        tier: p.tier,
        mode: p.mode,
        company: p.company,
        title: p.title,
        salary_min_base: p.salary_min_base,
        salary_max_base: p.salary_max_base,
      })),
      stretch_examples: sortedNew.filter(p => p.realism_score < 0.5).slice(0, 5).map(p => ({
        priority_score: p.priority_score, fit_score: p.fit_score, realism_score: p.realism_score,
        level: p.level, tier: p.tier, company: p.company, title: p.title,
      })),
      no_salary_examples: sortedNew.filter(p => p.salary_min_base == null && p.salary_max_base == null).slice(0, 5).map(p => ({
        company: p.company, title: p.title, mode: p.mode, tier: p.tier,
      })),
    };
    fs.writeFileSync(path.join(PUBLIC_DIR, 'dry-run-report.json'), JSON.stringify(dump, null, 2));
    log('dry-run: wrote public/dry-run-report.json (verification dump)');
  }

  // 7. Email (rendered against deduped views — daily-signal semantics).
  //    "new" = today's first_seen_date AND status=active.
  //    closed_today section = postings whose status flipped today regardless
  //    of first_seen_date.
  //    excluded footer = excluded postings first seen today (active).
  const subject = buildSubject(newKept);
  const html = buildHtml({
    date,
    newKept: newKept.map(stripDescription),
    closedToday: closedTodayKept.map(stripDescription),
    excluded: newExcluded.map(stripDescription),
    feedUrl: config.feed_page_url,
    maxRolesInBody: config.email_max_roles_in_body,
    topPicks: config.top_picks,
  });

  // Preflight: surface the new-count and subject on stdout BEFORE sending
  // so the caller can verify it isn't a degenerate "0 new roles" send.
  process.stdout.write(`preflight: new=${newKept.length} ongoing=${ongoingKept.length} closed_today=${closedTodayKept.length} excluded_new=${newExcluded.length} duplicate_run=${isDuplicateRun}\npreflight subject: ${subject}\n`);
  if (isDuplicateRun && !args.dryRunEmail) {
    log('idempotent skip: state.date == today and 0 newly-discovered IDs — not sending digest email');
  } else {
    try {
      const result = await sendOrPreview({
        html, subject,
        dryRun: args.dryRunEmail,
        previewPath: EMAIL_PREVIEW,
      });
      if (result.dryRun) {
        log(`DRY RUN — preview written to ${path.relative(ROOT, EMAIL_PREVIEW)}`);
        log(`Subject: ${subject}`);
      } else if (result.error) {
        log(`email send FAILED: ${JSON.stringify(result.error)}`);
        process.exitCode = 1;
      } else {
        log(`email sent — id=${result.id} from=${result.from} to=${result.to}`);
        log(`Subject: ${subject}`);
      }
    } catch (err) {
      log(`email send error: ${err.stack || err.message}`);
      process.exitCode = 1;
    }
  }

  // 8. Health tracking + alert email. Always runs (in dry-run mode the
  //    preview is written to public/, no Resend call). Skipped entirely if
  //    config.health_alerts.enabled is false.
  let healthAlertCount = 0;
  if ((config.health_alerts || {}).enabled !== false) {
    try {
      const existing = loadHealth(HEALTH_PATH);
      const updatedHealth = updateHealth(existing, runResults, date);
      if (!args.dryRunEmail) {
        writeHealth(HEALTH_PATH, updatedHealth);
        log(`wrote ${path.relative(ROOT, HEALTH_PATH)}`);
      }
      const alerts = evaluateAlerts(updatedHealth, companies, date, config);
      healthAlertCount = alertCount(alerts);
      log(`health: ${healthAlertCount} alert(s) — hard_failure=${alerts.hard_failure.length} suspicious_zero=${alerts.suspicious_zero.length} sustained_zero=${alerts.sustained_zero.length} recovery=${alerts.recovery.length}`);
      if (isDuplicateRun && !args.dryRunEmail && healthAlertCount > 0) {
        log('idempotent skip: health alert already sent by primary run today');
        healthAlertCount = 0;
      } else if (healthAlertCount > 0) {
        const subject = buildHealthSubject(alerts);
        const html = buildHealthHtml(alerts, date, HEALTH_REPO_URL);
        const result = await sendHealthAlertOrPreview({
          html, subject,
          dryRun: args.dryRunEmail,
          previewPath: HEALTH_PREVIEW,
          recipient: (config.health_alerts || {}).alert_recipient,
        });
        if (result.dryRun) {
          log(`DRY RUN — health alert preview written to ${path.relative(ROOT, HEALTH_PREVIEW)}`);
          log(`Health subject: ${subject}`);
        } else if (result.error) {
          log(`health alert send FAILED: ${JSON.stringify(result.error)}`);
        } else {
          log(`health alert sent — id=${result.id} from=${result.from} to=${result.to}`);
          log(`Health subject: ${subject}`);
        }
      }
    } catch (err) {
      log(`health alert error: ${err.stack || err.message}`);
    }
  } else {
    log('health: alerts disabled in config (health_alerts.enabled=false)');
  }

  // 9. Final summary on stdout (separate from log on stderr)
  process.stdout.write(JSON.stringify({
    date,
    new: newKept.length,
    ongoing: ongoingKept.length,
    closed_today: closedTodayKept.length,
    closed: closedKept.length,
    excluded_new: newExcluded.length,
    fetch_failures: failures.length,
    health_alerts: healthAlertCount,
    subject,
  }, null, 2) + '\n');
}

main().catch(err => {
  log(`fatal: ${err.stack || err.message}`);
  process.exit(1);
});
