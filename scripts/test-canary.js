#!/usr/bin/env node
// Synthetic tests for the canary's decision function. Verifies the
// age-based check correctly accepts/rejects various commit + time
// combinations without invoking git or the network.

const { isCanaryOk, MAX_AGE_HOURS } = require('./canary-check');

const cases = [
  // 1. No "feed:" commit ever — should ALERT
  {
    name: 'No "feed:" commit (subject empty)',
    subject: null,
    commitDateISO: null,
    now: '2026-05-03T00:30:00Z',
    expectOk: false,
  },
  // 2. Latest commit isn't a feed commit — should ALERT
  {
    name: 'Latest commit is a code change (not "feed:")',
    subject: 'phase 1.6.1: broaden description-based mode detection',
    commitDateISO: '2026-05-01T03:15:03Z',
    now: '2026-05-03T00:30:00Z',
    expectOk: false,
  },
  // 3. Feed commit on time (within 24h) — should NOT alert
  {
    name: 'feed: today exists (on time fire 23:17 UTC)',
    subject: 'feed: 2026-05-02',
    commitDateISO: '2026-05-02T23:18:00Z',
    now: '2026-05-03T00:30:00Z',
    expectOk: true,
  },
  // 4. Feed commit just landed — should NOT alert
  {
    name: 'feed: just-now',
    subject: 'feed: 2026-05-03',
    commitDateISO: '2026-05-03T00:25:00Z',
    now: '2026-05-03T00:30:00Z',
    expectOk: true,
  },
  // 5. Delayed-but-successful fire (last night's run delayed to morning) — should NOT alert
  {
    name: 'Delayed fire — feed: today landed at 06:30 UTC same morning',
    subject: 'feed: 2026-05-03',
    commitDateISO: '2026-05-03T06:30:00Z',
    now: '2026-05-03T07:10:00Z',
    expectOk: true,
  },
  // 6. Yesterday's commit is the most recent — within 30h — should NOT alert
  {
    name: 'feed: yesterday at 23:17 UTC, canary at 00:30 UTC next day',
    subject: 'feed: 2026-05-01',
    commitDateISO: '2026-05-01T23:18:00Z',
    now: '2026-05-02T00:30:00Z',
    expectOk: true,
  },
  // 7. Two days old — beyond 30h — should ALERT
  {
    name: 'Latest "feed:" commit is 2 days old',
    subject: 'feed: 2026-05-01',
    commitDateISO: '2026-05-01T23:18:00Z',
    now: '2026-05-03T07:00:00Z',
    expectOk: false,
  },
  // 8. Boundary: exactly 30 hours — should NOT alert (inclusive)
  {
    name: 'Exactly 30h old — at the boundary, still OK',
    subject: 'feed: 2026-05-01',
    commitDateISO: '2026-05-01T18:30:00Z',
    now: '2026-05-03T00:30:00Z',
    expectOk: true,
  },
  // 9. Boundary: just past 30 hours — should ALERT
  {
    name: '30h 1min old — just past boundary, ALERT',
    subject: 'feed: 2026-05-01',
    commitDateISO: '2026-05-01T18:29:00Z',
    now: '2026-05-03T00:30:00Z',
    expectOk: false,
  },
  // 10. Future commit date (clock skew) — treat as not OK
  {
    name: 'Commit date in the future (negative age) — reject',
    subject: 'feed: 2026-05-04',
    commitDateISO: '2026-05-04T00:00:00Z',
    now: '2026-05-03T00:30:00Z',
    expectOk: false,
  },
];

let pass = 0, fail = 0;
for (const c of cases) {
  const got = isCanaryOk({
    subject: c.subject,
    commitDateISO: c.commitDateISO,
    nowMs: new Date(c.now).getTime(),
  });
  const ok = got === c.expectOk;
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? '✓' : '✗'} ${c.name}`);
  console.log(`      got=${got} expected=${c.expectOk}`);
}
console.log(`\n${pass} pass, ${fail} fail (max-age=${MAX_AGE_HOURS}h)`);
if (fail) process.exit(1);
