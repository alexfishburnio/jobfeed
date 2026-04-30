#!/usr/bin/env node
// Synthetic verification of the health alert email. Builds a health.json
// state + today's runResults that trigger one of each alert type, runs
// update + evaluate + render, writes the preview HTML.
//
// Does NOT touch data/health.json on disk — operates entirely in memory and
// writes the preview to public/health-alert-preview.html.

const fs = require('node:fs');
const path = require('node:path');

const { update: updateHealth, evaluateAlerts, alertCount } = require('../src/health');
const { buildHealthSubject, buildHealthHtml } = require('../src/emailer');

const ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const HEALTH_PREVIEW = path.join(PUBLIC_DIR, 'health-alert-preview.html');
const HEALTH_REPO_URL = 'https://github.com/alexfishburnio/jobfeed/blob/main/data/health.json';

const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));

const today = '2026-04-30';
const yesterday = '2026-04-29';

// Synthetic companies (subset of the real list — only the names we trigger
// alerts for need to match real config, and only for label rendering).
const companies = [
  { name: 'LiveRamp',  ats: 'greenhouse', slug: 'liveramp',  tier: 2.5 },
  { name: 'Mistral',   ats: 'lever',      slug: 'mistral',   tier: 3 },
  { name: 'Atlassian', ats: 'lever',      slug: 'atlassian', tier: 2 },
  { name: 'Headspace', ats: 'greenhouse', slug: 'hs',        tier: 3 },
];

// Synthetic prior health state (yesterday's snapshot of state).
const priorHealth = {
  last_updated: yesterday + 'T23:00:00Z',
  companies: {
    LiveRamp: {
      last_success: '2026-04-22',
      last_status: 'fail',
      last_job_count: null,
      last_http_status: 404,
      last_error: 'HTTP 404 Not Found',
      consecutive_failures: 0,  // will become 1 today
      consecutive_zero_days: 0,
      last_nonzero_count: 47,
      last_nonzero_date: '2026-04-22',
      history: [
        { date: yesterday, status: 'ok', jobs: 47 },  // last successful 8 days ago — but pretend it was yesterday
      ],
    },
    Mistral: {
      last_success: yesterday,
      last_status: 'ok',
      last_job_count: 158,
      last_http_status: 200,
      last_error: null,
      consecutive_failures: 0,
      consecutive_zero_days: 0,  // will become 1 today
      last_nonzero_count: 158,
      last_nonzero_date: yesterday,
      history: [
        { date: yesterday, status: 'ok', jobs: 158 },
      ],
    },
    Atlassian: {
      last_success: yesterday,
      last_status: 'zero',
      last_job_count: 0,
      last_http_status: 200,
      last_error: null,
      consecutive_failures: 0,
      consecutive_zero_days: 5,  // will become 6 today
      last_nonzero_count: 24,
      last_nonzero_date: '2026-04-24',
      history: [
        { date: yesterday,    status: 'zero', jobs: 0 },
        { date: '2026-04-28', status: 'zero', jobs: 0 },
        { date: '2026-04-27', status: 'zero', jobs: 0 },
        { date: '2026-04-26', status: 'zero', jobs: 0 },
        { date: '2026-04-25', status: 'zero', jobs: 0 },
        { date: '2026-04-24', status: 'ok',   jobs: 24 },
      ],
    },
    Headspace: {
      last_success: '2026-04-26',
      last_status: 'fail',
      last_job_count: null,
      last_http_status: 503,
      last_error: 'HTTP 503 Service Unavailable',
      consecutive_failures: 3,
      consecutive_zero_days: 0,
      last_nonzero_count: 36,
      last_nonzero_date: '2026-04-26',
      history: [
        { date: yesterday,    status: 'fail', jobs: null },
        { date: '2026-04-28', status: 'fail', jobs: null },
        { date: '2026-04-27', status: 'fail', jobs: null },
        { date: '2026-04-26', status: 'ok',   jobs: 36 },
      ],
    },
  },
};

// Today's synthetic run results — each company hits a different alert path.
const todayRunResults = [
  { name: 'LiveRamp',  status: 'fail', jobs: null, http_status: 404, error: 'HTTP 404 Not Found' }, // hard failure
  { name: 'Mistral',   status: 'zero', jobs: 0, http_status: 200 },                                  // suspicious zero
  { name: 'Atlassian', status: 'zero', jobs: 0, http_status: 200 },                                  // sustained zero
  { name: 'Headspace', status: 'ok',   jobs: 36, http_status: 200 },                                 // recovery
];

const updated = updateHealth(priorHealth, todayRunResults, today);
const alerts = evaluateAlerts(updated, companies, today, config);
const n = alertCount(alerts);

console.log(`alerts found: ${n}`);
console.log(`  hard_failure:    ${alerts.hard_failure.length}`);
console.log(`  suspicious_zero: ${alerts.suspicious_zero.length}`);
console.log(`  sustained_zero:  ${alerts.sustained_zero.length}`);
console.log(`  recovery:        ${alerts.recovery.length}`);

const subject = buildHealthSubject(alerts);
const html = buildHealthHtml(alerts, today, HEALTH_REPO_URL);
fs.mkdirSync(PUBLIC_DIR, { recursive: true });
fs.writeFileSync(HEALTH_PREVIEW, html);
console.log(`subject: ${subject}`);
console.log(`preview: ${path.relative(ROOT, HEALTH_PREVIEW)} (${html.length} bytes)`);
