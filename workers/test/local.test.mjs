// Local port correctness tests. Mocks KV + R2 with in-memory shims and
// runs the daily + weekly handlers against the live ATS APIs for a small
// subset of companies. No Resend sends.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runDaily } from '../src/daily.js';
import { runWeekly } from '../src/weekly.js';
import { slugVariants, recoverCompany } from '../src/slug-recovery.js';
import { freshnessCheck } from '../src/freshness.js';

// Minimal KV shim
function mockKV() {
  const store = new Map();
  return {
    async get(key, type) {
      const raw = store.get(key);
      if (raw == null) return null;
      return type === 'json' ? JSON.parse(raw) : raw;
    },
    async put(key, value) {
      store.set(key, value);
    },
    _dump() { return Object.fromEntries(store); },
  };
}

// Minimal R2 shim
function mockR2() {
  const store = new Map();
  return {
    async get(key) {
      if (!store.has(key)) return null;
      const buf = store.get(key);
      return {
        async json() { return JSON.parse(buf); },
        async text() { return buf; },
        async arrayBuffer() { return new TextEncoder().encode(buf).buffer; },
      };
    },
    async put(key, body /*, options */) {
      const text = typeof body === 'string' ? body : new TextDecoder().decode(body);
      store.set(key, text);
    },
    async list({ prefix, limit } = {}) {
      const keys = [...store.keys()].filter(k => !prefix || k.startsWith(prefix));
      return { objects: keys.slice(0, limit || keys.length).map(key => ({ key })) };
    },
    _dump() { return Object.fromEntries(store); },
  };
}

test('slugVariants includes expected forms', () => {
  const v = slugVariants('The Trade Desk');
  assert.ok(v.includes('thetradedesk'));
  assert.ok(v.includes('the-trade-desk'));
  assert.ok(v.includes('tradedesk'));
});

test('freshnessCheck marks fake job_id as closed', async () => {
  const companies = [{ name: 'Anthropic', tier: 1, ats: 'greenhouse', slug: 'anthropic' }];
  const fake = { id: 'greenhouse:anthropic:999999999', company: 'Anthropic', title: 'Fake', first_seen_date: '2026-11-18' };
  const r = await freshnessCheck([fake], companies);
  assert.equal(r.alive.length, 0);
  assert.equal(r.closed.length, 1);
});

test('recoverCompany finds anthropic variant', async () => {
  const outcome = await recoverCompany({ name: 'Anthropic', ats: 'greenhouse', slug: 'anthropic-wrong' }, { delayMs: 200 });
  assert.equal(outcome.recovered, true);
  assert.equal(outcome.new_slug, 'anthropic');
});

test('runDaily against KV+R2 shim with --limit=2 fetches + writes', async () => {
  const env = { KV: mockKV(), R2: mockR2() };
  const log = () => {};
  const result = await runDaily(env, { log, limit: 2 });
  assert.ok(result.date);
  assert.equal(typeof result.new, 'number');
  const kvDump = env.KV._dump();
  assert.ok(kvDump.state, 'state key written');
  assert.ok(kvDump.health, 'health key written');
  assert.ok(kvDump.companies, 'companies key seeded');
  const r2Dump = env.R2._dump();
  assert.ok(r2Dump['feed.json'], 'feed.json written');
  const todayKey = Object.keys(r2Dump).find(k => k.startsWith('snapshots/'));
  assert.ok(todayKey, 'snapshot written');
});

test('runWeekly with skipFreshness+skipSend returns html preview', async () => {
  const env = { KV: mockKV(), R2: mockR2() };
  // Seed a tiny snapshot in R2 so there's something to aggregate
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const snap = {
    date: today,
    fetch_summary: { companies_total: 1, companies_ok: 1, companies_failed: 0, failures: [] },
    counts: {},
    postings: [{
      id: 'greenhouse:fake:1', company: 'FakeCo', tier: 1, ats: 'greenhouse', title: 'PM, Test',
      locations: ['New York, NY'], metro: 'nyc', mode: 'fully_remote', level: 'mid_level',
      salary_min_base: null, salary_max_base: null,
      fit_score: 3, realism_score: 1, priority_score: 3,
      recommended_resume: 'general', apply_url: 'https://example.invalid',
      status: 'active', first_seen_date: today,
    }],
    excluded: [],
  };
  await env.R2.put(`snapshots/${today}.json`, JSON.stringify(snap));
  const log = () => {};
  const result = await runWeekly(env, { skipFreshness: true, skipSend: true, log });
  assert.ok(result.html && result.html.includes('FakeCo'), 'preview html contains fake posting');
  assert.ok(result.subject.startsWith('Weekly job digest'));
});
