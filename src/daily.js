// Daily orchestrator: fetch → parse → score → diff → snapshot → state →
// feed.json → slug-health. Silent — no email is sent. Any failures are
// surfaced in the next weekly digest's infrastructure section.

const fs = require('node:fs');
const path = require('node:path');

const { fetchCompany } = require('./fetcher');
const { parsePosting } = require('./parser');
const { scoreAll } = require('./scorer');
const { diff, writeSnapshot, writeState } = require('./differ');
const { buildFeed, writeFeed } = require('./exporter');
const { loadHealth, update: updateHealth, writeHealth } = require('./health');

const ROOT = path.join(__dirname, '..');
const CONFIG_PATH    = path.join(ROOT, 'config.json');
const COMPANIES_PATH = path.join(ROOT, 'companies.json');
const DATA_DIR       = path.join(ROOT, 'data');
const STATE_PATH     = path.join(DATA_DIR, 'state.json');
const HEALTH_PATH    = path.join(DATA_DIR, 'health.json');
const PUBLIC_DIR     = path.join(ROOT, 'public');

const REQUEST_DELAY_MS = 1500;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = msg => process.stderr.write(msg + '\n');

function todayInET() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

function parseArgs(argv) {
  return {
    limit: (() => {
      const i = argv.indexOf('--limit');
      return i >= 0 ? parseInt(argv[i + 1], 10) : null;
    })(),
  };
}

async function fetchAll(companies) {
  const successes = [];
  const failures = [];
  const runResults = [];
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
      log(`  ok ${c.ats}/${c.slug} (${c.name}) — ${jobs.length}`);
    } catch (err) {
      failures.push({ company: c, error: err.message });
      runResults.push({
        name: c.name,
        status: 'fail',
        jobs: null,
        http_status: err.status || null,
        error: err.message,
      });
      log(`  FAIL ${c.ats}/${c.slug} (${c.name}) — ${err.message}`);
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
  log(`daily run — ${date} — ${companies.length} companies (silent)`);

  log('fetching...');
  const { successes, failures, runResults } = await fetchAll(companies);
  log(`fetched ${successes.length}/${companies.length} ok, ${failures.length} failed`);

  const parsed = [];
  for (const { company, jobs } of successes) {
    for (const j of jobs) {
      try { parsed.push(parsePosting(j, company, config)); }
      catch (err) { log(`  parse error for ${company.name}: ${err.message}`); }
    }
  }
  log(`parsed ${parsed.length} postings`);

  const { kept, excluded, dropped } = scoreAll(parsed, config);
  log(`scored — kept=${kept.length} excluded=${excluded.length} dropped: pm_gate=${dropped.pm_gate} location=${dropped.location} exclude_title=${dropped.exclude_title}`);

  const d = diff({ kept, excluded }, STATE_PATH, DATA_DIR, date);
  log(`diff — prev_date=${d.prev_date} today=${date} newly_discovered=${d.newly_discovered}`);

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
      new_today:      d.kept.filter(p => p.status === 'active' && p.first_seen_date === date).length,
      ongoing:        d.kept.filter(p => p.status === 'active' && p.first_seen_date !== date).length,
      closed_today:   d.kept.filter(p => p.status === 'closed_today').length,
      closed:         d.kept.filter(p => p.status === 'closed').length,
      excluded_new:   d.excluded.filter(p => p.status === 'active' && p.first_seen_date === date).length,
      excluded_total: d.excluded.length,
    },
    postings: d.kept.map(stripDescription),
    excluded: d.excluded.map(stripDescription),
  };

  writeSnapshot(DATA_DIR, date, snapshot);
  writeState(STATE_PATH, date, d.state_map);
  log(`wrote data/${date}.json and data/state.json`);

  const feed = buildFeed(DATA_DIR, config.feed_retention_days || 30);
  writeFeed(PUBLIC_DIR, feed);
  log(`wrote public/feed.json (${feed.days.length} day(s))`);

  // Slug-health tracking — appended per-day to data/health.json. The weekly
  // digest's infrastructure section reads this file to surface issues.
  try {
    const existing = loadHealth(HEALTH_PATH);
    const updatedHealth = updateHealth(existing, runResults, date);
    writeHealth(HEALTH_PATH, updatedHealth);
    log(`wrote ${path.relative(ROOT, HEALTH_PATH)}`);
  } catch (err) {
    log(`slug-health error: ${err.stack || err.message}`);
  }

  process.stdout.write(JSON.stringify({
    date,
    new: snapshot.counts.new_today,
    ongoing: snapshot.counts.ongoing,
    closed_today: snapshot.counts.closed_today,
    closed: snapshot.counts.closed,
    excluded_new: snapshot.counts.excluded_new,
    fetch_failures: failures.length,
  }, null, 2) + '\n');
}

main().catch(err => {
  log(`fatal: ${err.stack || err.message}`);
  process.exit(1);
});
