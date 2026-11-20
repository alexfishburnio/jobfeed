// Synthetic tests for Phase 2.1 features (freshness check + slug recovery).
// Runs read-only against live ATS APIs; does not mutate the repo.

const path = require('node:path');
const fs = require('node:fs');

const { freshnessCheck } = require('../src/freshness');
const {
  slugVariants, probeSlug, recoverCompany,
  selectRecoveryCandidates, recordRecoveryOutcome,
} = require('../src/slug-recovery');

const ROOT = path.join(__dirname, '..');
const COMPANIES = JSON.parse(fs.readFileSync(path.join(ROOT, 'companies.json'), 'utf8'));
const log = m => process.stderr.write(m + '\n');

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    failed++;
    console.log(`  FAIL: ${msg}`);
  } else {
    console.log(`  ok  : ${msg}`);
  }
}

async function testFreshnessAlive() {
  console.log('\n[1] Freshness: real role is alive after fresh fetch');
  // Use a known real posting from today's snapshot. If none, skip.
  const snapPath = path.join(ROOT, 'data', '2026-11-20.json');
  if (!fs.existsSync(snapPath)) {
    console.log('  skip: data/2026-11-20.json missing');
    return;
  }
  const snap = JSON.parse(fs.readFileSync(snapPath, 'utf8'));
  const sample = (snap.postings || [])
    .filter(p => p.status === 'active' && p.company === 'Anthropic')
    .slice(0, 1);
  if (!sample.length) {
    console.log('  skip: no active Anthropic posting in snapshot');
    return;
  }
  const result = await freshnessCheck(sample, COMPANIES, { log });
  assert(result.alive.length >= 1 || result.fetchFailures.length === 1,
    `alive=${result.alive.length} closed=${result.closed.length} fetch_failures=${result.fetchFailures.length}`);
}

async function testFreshnessClosed() {
  console.log('\n[2] Freshness: synthetic nonexistent job_id is reported closed');
  // Craft a fake posting that cannot be live.
  const fake = {
    id: 'greenhouse:anthropic:99999999999',
    company: 'Anthropic',
    title: 'Fake Role',
    first_seen_date: '2026-11-18',
  };
  const result = await freshnessCheck([fake], COMPANIES, { log });
  assert(result.closed.length === 1 && result.alive.length === 0,
    `fake id expected closed — got alive=${result.alive.length} closed=${result.closed.length}`);
}

async function testFreshnessFetchFailure() {
  console.log('\n[3] Freshness: fetch failure → role kept alive (optimistic)');
  // Make sure a fake-company path keeps the role alive when its slug is not
  // in companies.json (companiesInPool filters it out — alive-by-default).
  const fake = {
    id: 'greenhouse:this-slug-does-not-exist:1234',
    company: 'UnknownCo',
    title: 'Mystery',
    first_seen_date: '2026-11-18',
  };
  const result = await freshnessCheck([fake], COMPANIES, { log });
  // companiesInPool() will not include an unknown slug, so it stays in alive
  // without any fetch attempt.
  assert(result.alive.length === 1 && result.closed.length === 0,
    `unknown-slug role expected alive, got alive=${result.alive.length}`);
}

function testSlugVariants() {
  console.log('\n[4] slugVariants() generates expected variants');
  const v1 = slugVariants('The Trade Desk');
  console.log(`  variants("The Trade Desk"): ${JSON.stringify(v1)}`);
  assert(v1.includes('thetradedesk') && v1.includes('the-trade-desk') && v1.includes('tradedesk'),
    'includes "thetradedesk", "the-trade-desk", "tradedesk"');
  const v2 = slugVariants('Headspace');
  assert(v2.includes('headspace') && v2.includes('headspacehq') && v2.includes('headspacecareers'),
    'includes "headspace", "headspacehq", "headspacecareers"');
}

async function testRecoverRealCompany() {
  console.log('\n[5] recoverCompany finds alt slug when one exists');
  // Use a fake company name whose variants should hit a real Greenhouse board.
  // Pick "Anthropic" with a wrong slug — one of its variants ("anthropic")
  // IS the real slug, so recovery should succeed.
  const fake = { name: 'Anthropic', ats: 'greenhouse', slug: 'anthropic-wrong-name' };
  const outcome = await recoverCompany(fake, { log, delayMs: 300 });
  assert(outcome.recovered && outcome.new_slug === 'anthropic',
    `recovered=${outcome.recovered} new_slug=${outcome.new_slug} attempts=${(outcome.attempts || []).length}`);
}

async function testRecoverNoHit() {
  console.log('\n[6] recoverCompany returns false when no variant matches');
  const fake = { name: 'Zzzzzzz Nonexistent Ltd', ats: 'greenhouse', slug: 'zzzzzzz-nonexistent-ltd' };
  const outcome = await recoverCompany(fake, { log, delayMs: 300 });
  assert(outcome.recovered === false,
    `expected recovery miss — got recovered=${outcome.recovered}`);
}

function testSelectRecoveryCandidates() {
  console.log('\n[7] selectRecoveryCandidates picks right companies');
  const companiesByName = new Map([
    ['Co1', { name: 'Co1', ats: 'greenhouse', slug: 'co1' }],
    ['Co2', { name: 'Co2', ats: 'greenhouse', slug: 'co2' }],
    ['Co3', { name: 'Co3', ats: 'greenhouse', slug: 'co3' }],
    ['Co4', { name: 'Co4', ats: 'greenhouse', slug: 'co4' }],
  ]);
  const runResults = [
    { name: 'Co1', status: 'fail' },  // first fail, should NOT trigger
    { name: 'Co2', status: 'fail' },  // second fail, SHOULD trigger
    { name: 'Co3', status: 'fail' },  // already persistent_failure, should NOT trigger
    { name: 'Co4', status: 'ok' },    // success, should NOT trigger
  ];
  const health = {
    companies: {
      Co1: { consecutive_failures: 0 },
      Co2: { consecutive_failures: 1 },
      Co3: { consecutive_failures: 5, persistent_failure: { since: '2026-11-15' } },
      Co4: { consecutive_failures: 0 },
    },
  };
  const picks = selectRecoveryCandidates(runResults, companiesByName, health);
  const names = picks.map(c => c.name).sort();
  assert(names.length === 1 && names[0] === 'Co2',
    `expected only Co2 — got ${JSON.stringify(names)}`);
}

function testRecordRecoveryOutcome() {
  console.log('\n[8] recordRecoveryOutcome mutates health entry');
  const h = { companies: { Co: { consecutive_failures: 2 } } };
  const succ = { recovered: true, new_ats: 'lever', new_slug: 'conew', jobs: 42, attempts: [] };
  succ.old_ats = 'greenhouse'; succ.old_slug = 'co';
  recordRecoveryOutcome(h, 'Co', succ, '2026-11-20');
  assert((h.companies.Co.recoveries || []).length === 1 && h.companies.Co.recoveries[0].new_slug === 'conew',
    'recovery outcome persisted');
  assert(!h.companies.Co.persistent_failure, 'persistent_failure cleared on success');

  const miss = { recovered: false, attempts: [{}, {}, {}] };
  miss.old_ats = 'greenhouse'; miss.old_slug = 'co';
  miss.last_http_status = 404;
  const h2 = { companies: { Co: {} } };
  recordRecoveryOutcome(h2, 'Co', miss, '2026-11-20');
  assert(h2.companies.Co.persistent_failure && h2.companies.Co.persistent_failure.http_status === 404,
    'persistent_failure recorded on miss');
}

(async () => {
  try {
    testSlugVariants();
    testSelectRecoveryCandidates();
    testRecordRecoveryOutcome();
    await testFreshnessAlive();
    await testFreshnessClosed();
    await testFreshnessFetchFailure();
    await testRecoverRealCompany();
    await testRecoverNoHit();
  } catch (err) {
    console.error('TEST SUITE CRASHED:', err.stack || err.message);
    process.exit(2);
  }
  console.log(`\n${failed === 0 ? 'ALL PASS' : `FAILED: ${failed}`}`);
  process.exit(failed === 0 ? 0 : 1);
})();
