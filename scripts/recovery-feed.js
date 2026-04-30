#!/usr/bin/env node
// One-off recovery: refetch all 91 companies, force every active posting
// to status="new" for today, write public/feed.json with that view.
//
// Does NOT touch:
//   - data/state.json   (so tomorrow's cron continues to diff normally)
//   - data/YYYY-MM-DD.json snapshot
//
// Reuses the production pipeline modules so scoring/dedupe stays consistent.

const fs = require('node:fs');
const path = require('node:path');

const { fetchCompany } = require('../src/fetcher');
const { parsePosting } = require('../src/parser');
const { scoreAll } = require('../src/scorer');
const { dedupePostings } = require('../src/dedupe');

const ROOT = path.join(__dirname, '..');
const CONFIG_PATH    = path.join(ROOT, 'config.json');
const COMPANIES_PATH = path.join(ROOT, 'companies.json');
const PUBLIC_DIR     = path.join(ROOT, 'public');
const FEED_PATH      = path.join(PUBLIC_DIR, 'feed.json');

const REQUEST_DELAY_MS = 1500;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = msg => process.stderr.write(msg + '\n');

function todayInET() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

async function fetchAll(companies) {
  const successes = [], failures = [];
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

const stripDescription = ({ description, ...rest }) => rest;
const tagNew = p => ({ ...p, status: 'new' });

(async () => {
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const companies = JSON.parse(fs.readFileSync(COMPANIES_PATH, 'utf8'));
  const date = todayInET();

  log(`recovery feed — ${date} — ${companies.length} companies`);
  log('fetching...');
  const { successes, failures } = await fetchAll(companies);
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

  // Force every active posting to status=new (recovery semantics).
  const keptNew     = kept.map(tagNew).map(stripDescription);
  const excludedNew = excluded.map(tagNew).map(stripDescription);

  // Dedupe for display (matches normal exporter output).
  const dedKept     = dedupePostings(keptNew);
  const dedExcluded = dedupePostings(excludedNew);

  const feed = {
    generated_at: new Date().toISOString(),
    days: [
      {
        date,
        counts: {
          new: dedKept.length,
          ongoing: 0,
          closed: 0,
          excluded: dedExcluded.length,
        },
        new: dedKept,
        ongoing: [],
        closed: [],
        excluded: dedExcluded,
      },
    ],
  };

  fs.mkdirSync(PUBLIC_DIR, { recursive: true });
  fs.writeFileSync(FEED_PATH, JSON.stringify(feed, null, 2) + '\n');
  log(`wrote ${path.relative(ROOT, FEED_PATH)} — ${dedKept.length} new (deduped) · ${dedExcluded.length} excluded · ${failures.length} fetch failures`);
})().catch(err => {
  log(`fatal: ${err.stack || err.message}`);
  process.exit(1);
});
