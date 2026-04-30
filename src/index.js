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
const { buildSubject, buildHtml, sendOrPreview, sortPostings, pickTopByCompany } = require('./emailer');
const { dedupePostings } = require('./dedupe');

const ROOT = path.join(__dirname, '..');
const CONFIG_PATH    = path.join(ROOT, 'config.json');
const COMPANIES_PATH = path.join(ROOT, 'companies.json');
const DATA_DIR       = path.join(ROOT, 'data');
const STATE_PATH     = path.join(DATA_DIR, 'state.json');
const PUBLIC_DIR     = path.join(ROOT, 'public');
const EMAIL_PREVIEW  = path.join(PUBLIC_DIR, 'email-preview.html');

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
  let first = true;
  for (const c of companies) {
    if (!first) await sleep(REQUEST_DELAY_MS);
    first = false;
    try {
      const { jobs } = await fetchCompany(c);
      successes.push({ company: c, jobs });
      log(`  ✓ ${c.ats}/${c.slug} (${c.name}) — ${jobs.length}`);
    } catch (err) {
      failures.push({ company: c, error: err.message });
      log(`  ✗ ${c.ats}/${c.slug} (${c.name}) — ${err.message}`);
    }
  }
  return { successes, failures };
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
  const { successes, failures } = await fetchAll(companies);
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

  // 4. Diff (operates on individual postings — state.json + snapshot store
  // raw IDs for fidelity; dedupe happens later for display only).
  const d = diff({ kept, excluded }, STATE_PATH, DATA_DIR, date);
  const dedKept     = dedupePostings(d.kept);
  const dedExcluded = dedupePostings(d.excluded);
  const dedClosed   = dedupePostings(d.closed_today);
  const newKept       = dedKept.filter(p => p.status === 'new');
  const ongoingKept   = dedKept.filter(p => p.status === 'ongoing');
  const newExcluded   = dedExcluded.filter(p => p.status === 'new');
  log(`diff — new=${newKept.length} ongoing=${ongoingKept.length} closed=${dedClosed.length} (prev=${d.prev_count}, today=${d.today_count}; raw kept=${d.kept.length}, deduped=${dedKept.length})`);

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
      new: newKept.length,
      ongoing: ongoingKept.length,
      closed: d.closed_today.length,
      excluded_new: newExcluded.length,
      excluded_total: d.excluded.length,
    },
    kept: d.kept.map(stripDescription),
    excluded: d.excluded.map(stripDescription),
    closed_today: d.closed_today.map(stripDescription),
  };

  if (!args.dryRunEmail) {
    writeSnapshot(DATA_DIR, date, snapshot);
    writeState(STATE_PATH, date, d.today_ids);
    log(`wrote data/${date}.json and data/state.json`);
    const feed = buildFeed(DATA_DIR, config.feed_retention_days || 30);
    writeFeed(PUBLIC_DIR, feed);
    log(`wrote public/feed.json (${feed.days.length} day(s))`);
  } else {
    log('dry-run: skipping writes to data/ and public/feed.json');
    // Verification dump for review — top postings with full scoring fields
    // (these are stripped from the email HTML, so we surface them here).
    const sortedNew = sortPostings(newKept);
    const top5 = pickTopByCompany(sortedNew, 5);
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

  // 7. Email (rendered against deduped views).
  const subject = buildSubject(newKept);
  const html = buildHtml({
    date,
    newKept: newKept.map(stripDescription),
    closedToday: dedClosed.map(stripDescription),
    excluded: dedExcluded.map(stripDescription),
    feedUrl: config.feed_page_url,
    maxRolesInBody: config.email_max_roles_in_body,
  });

  // Preflight: surface the new-count and subject on stdout BEFORE sending
  // so the caller can verify it isn't a degenerate "0 new roles" send.
  process.stdout.write(`preflight: new=${newKept.length} ongoing=${ongoingKept.length} closed=${d.closed_today.length} excluded_new=${newExcluded.length}\npreflight subject: ${subject}\n`);
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

  // 8. Final summary on stdout (separate from log on stderr)
  process.stdout.write(JSON.stringify({
    date,
    new: newKept.length,
    ongoing: ongoingKept.length,
    closed: d.closed_today.length,
    excluded_new: newExcluded.length,
    fetch_failures: failures.length,
    subject,
  }, null, 2) + '\n');
}

main().catch(err => {
  log(`fatal: ${err.stack || err.message}`);
  process.exit(1);
});
