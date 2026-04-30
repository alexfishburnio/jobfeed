#!/usr/bin/env node
// Phase 0 audit. Probes target companies across Greenhouse, Lever, and Ashby
// public ATS APIs to determine which are addressable before committing to the
// full build. Sequential, 1.5s between any two requests, 30s back-off + one
// retry on 429. Writes audit-report.csv incrementally so the run can resume
// after an interrupt, and audit-summary.md at the end.

const fs = require('node:fs');
const path = require('node:path');

const ROOT = __dirname;
const COMPANIES_PATH = path.join(ROOT, 'companies.json');
const CSV_PATH = path.join(ROOT, 'audit-report.csv');
const SUMMARY_PATH = path.join(ROOT, 'audit-summary.md');

const USER_AGENT = 'alexfishburn.io job audit - alexfishburn@gmail.com';
const REQUEST_DELAY_MS = 1500;
const RATE_LIMIT_BACKOFF_MS = 30_000;
const ARTICLES = new Set(['the', 'a', 'an']);

const CSV_HEADER = 'name,tier,ats_detected,slug_used,job_count,status,notes';

function slugVariants(name, slugHint) {
  const tokens = name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const concat = tokens.join('');
  const hyphen = tokens.join('-');
  const concatNoArticles = tokens.filter(t => !ARTICLES.has(t)).join('');

  const out = [];
  const push = v => { if (v && !out.includes(v)) out.push(v); };
  if (slugHint) push(slugHint.trim().toLowerCase());
  push(concat);
  push(hyphen);
  push(concatNoArticles);
  return out;
}

const ATS_PROBES = [
  {
    name: 'greenhouse',
    url: slug => `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs`,
    countJobs: data => Array.isArray(data && data.jobs) ? data.jobs.length : null,
  },
  {
    name: 'lever',
    url: slug => `https://api.lever.co/v0/postings/${encodeURIComponent(slug)}?mode=json`,
    countJobs: data => Array.isArray(data) ? data.length : null,
  },
  {
    name: 'ashby',
    url: slug => `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(slug)}?includeCompensation=true`,
    countJobs: data => Array.isArray(data && data.jobs) ? data.jobs.length : null,
  },
];

const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = msg => process.stderr.write(msg + '\n');

async function probeOnce(url) {
  let res;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' },
      redirect: 'follow',
    });
  } catch (err) {
    return { kind: 'network-error', error: err.message };
  }
  if (res.status === 200) {
    let data;
    try { data = await res.json(); } catch (err) { return { kind: 'invalid-json', error: err.message }; }
    return { kind: 'ok', data };
  }
  if (res.status === 404) return { kind: 'not-found' };
  if (res.status === 429) return { kind: 'rate-limited' };
  return { kind: 'http-error', status: res.status };
}

async function probe(url) {
  let r = await probeOnce(url);
  if (r.kind === 'rate-limited') {
    log(`  · 429 rate-limited, sleeping ${RATE_LIMIT_BACKOFF_MS}ms then retrying once`);
    await sleep(RATE_LIMIT_BACKOFF_MS);
    r = await probeOnce(url);
  }
  return r;
}

function csvField(v) {
  const s = v == null ? '' : String(v);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function parseCsv(text) {
  text = text.replace(/^﻿/, '');
  const rows = [];
  let i = 0, field = '', row = [], inQuotes = false;
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i += 2; continue; }
      if (c === '"') { inQuotes = false; i++; continue; }
      field += c; i++; continue;
    }
    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += c; i++;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function loadDoneFromCsv() {
  if (!fs.existsSync(CSV_PATH)) return new Map();
  const rows = parseCsv(fs.readFileSync(CSV_PATH, 'utf8'));
  if (rows.length < 2) return new Map();
  const out = new Map();
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r[0]) continue;
    out.set(r[0], {
      name: r[0],
      tier: r[1],
      ats_detected: r[2],
      slug_used: r[3],
      job_count: r[4],
      status: r[5],
      notes: r[6] || '',
    });
  }
  return out;
}

async function main() {
  const companies = JSON.parse(fs.readFileSync(COMPANIES_PATH, 'utf8'));
  const done = loadDoneFromCsv();
  log(`loaded ${companies.length} companies; ${done.size} already in CSV`);

  if (!fs.existsSync(CSV_PATH)) {
    fs.writeFileSync(CSV_PATH, '﻿' + CSV_HEADER + '\n', 'utf8');
  }

  const results = Array.from(done.values());
  let firstRequest = true;

  for (const company of companies) {
    if (done.has(company.name)) continue;

    const variants = slugVariants(company.name, company.slug_hint);
    log(`[T${company.tier}] ${company.name} — ${variants.join(' | ')}`);

    let match = null;
    let lastError = null;

    outer:
    for (const ats of ATS_PROBES) {
      for (const slug of variants) {
        if (!firstRequest) await sleep(REQUEST_DELAY_MS);
        firstRequest = false;

        const url = ats.url(slug);
        const r = await probe(url);

        if (r.kind === 'ok') {
          const count = ats.countJobs(r.data);
          if (count == null) {
            log(`  · ${ats.name}/${slug} 200 but unexpected payload`);
            continue;
          }
          match = { ats: ats.name, slug, count };
          log(`  ✓ ${ats.name}/${slug} → ${count} jobs`);
          break outer;
        }
        if (r.kind === 'not-found') {
          log(`  · ${ats.name}/${slug} 404`);
          continue;
        }
        if (r.kind === 'rate-limited') {
          log(`  · ${ats.name}/${slug} 429 after retry, skipping`);
          lastError = `${ats.name}/${slug}: 429`;
          continue;
        }
        const detail = r.status ? `HTTP ${r.status}` : (r.error || r.kind);
        log(`  · ${ats.name}/${slug} ${detail}`);
        lastError = `${ats.name}/${slug}: ${detail}`;
      }
    }

    let result;
    if (match) {
      const status = match.count > 0 ? '✅ active' : '⚠️ empty';
      const notes = [];
      const hint = company.slug_hint ? company.slug_hint.trim().toLowerCase() : '';
      if (hint && hint !== match.slug) {
        notes.push(`slug_hint '${company.slug_hint}' did not match; matched on variant '${match.slug}'`);
      }
      result = {
        name: company.name,
        tier: company.tier,
        ats_detected: match.ats,
        slug_used: match.slug,
        job_count: match.count,
        status,
        notes: notes.join('; '),
      };
    } else {
      const notes = [`tried ${variants.length} variant(s): ${variants.join(', ')}`];
      if (lastError) notes.push(`last non-404: ${lastError}`);
      result = {
        name: company.name,
        tier: company.tier,
        ats_detected: 'unknown',
        slug_used: '',
        job_count: '',
        status: '❌ no ATS found',
        notes: notes.join('; '),
      };
    }

    const line = [
      result.name, result.tier, result.ats_detected, result.slug_used,
      result.job_count, result.status, result.notes,
    ].map(csvField).join(',');
    fs.appendFileSync(CSV_PATH, line + '\n', 'utf8');
    results.push(result);
    log(`  → ${result.status}${match ? ` (${match.ats}: ${match.count})` : ''}`);
  }

  writeSummary(results);
  log(`done — ${results.length} rows. wrote ${path.basename(CSV_PATH)} and ${path.basename(SUMMARY_PATH)}`);
}

function writeSummary(results) {
  const total = results.length;
  const byAts = { greenhouse: 0, lever: 0, ashby: 0, unknown: 0 };
  for (const r of results) byAts[r.ats_detected] = (byAts[r.ats_detected] || 0) + 1;

  const tiers = Array.from(new Set(results.map(r => r.tier))).sort((a, b) => Number(a) - Number(b));
  const statuses = ['✅ active', '⚠️ empty', '❌ no ATS found'];
  const grid = {};
  for (const t of tiers) grid[t] = { '✅ active': 0, '⚠️ empty': 0, '❌ no ATS found': 0 };
  for (const r of results) grid[r.tier][r.status] = (grid[r.tier][r.status] || 0) + 1;

  const noAts = {};
  for (const r of results) {
    if (r.ats_detected === 'unknown') {
      (noAts[r.tier] = noAts[r.tier] || []).push(r.name);
    }
  }

  const top = results
    .filter(r => Number.isFinite(Number(r.job_count)) && Number(r.job_count) > 0)
    .sort((a, b) => Number(b.job_count) - Number(a.job_count))
    .slice(0, 10);

  const slugHintMisses = results.filter(r => r.notes && r.notes.includes('slug_hint'));
  const empties = results.filter(r => r.status === '⚠️ empty');

  const out = [];
  out.push('# Phase 0 Audit Summary');
  out.push('');
  out.push(`**Total companies audited:** ${total}`);
  out.push('');
  out.push('## Counts by ATS');
  out.push('');
  out.push('| ATS | Count |');
  out.push('|---|---|');
  for (const k of ['greenhouse', 'lever', 'ashby', 'unknown']) {
    out.push(`| ${k} | ${byAts[k] || 0} |`);
  }
  out.push('');
  out.push('## Tier × Status');
  out.push('');
  out.push('| Tier | ✅ active | ⚠️ empty | ❌ no ATS found |');
  out.push('|---|---|---|---|');
  for (const t of tiers) {
    out.push(`| ${t} | ${grid[t]['✅ active'] || 0} | ${grid[t]['⚠️ empty'] || 0} | ${grid[t]['❌ no ATS found'] || 0} |`);
  }
  out.push('');
  out.push('## "No ATS found" — manual investigation needed');
  out.push('');
  if (Object.keys(noAts).length === 0) {
    out.push('_(none)_');
  } else {
    for (const t of Object.keys(noAts).sort((a, b) => Number(a) - Number(b))) {
      out.push(`### Tier ${t} (${noAts[t].length})`);
      for (const n of noAts[t]) out.push(`- ${n}`);
      out.push('');
    }
  }
  out.push('## Top 10 by current open job count');
  out.push('');
  if (top.length === 0) {
    out.push('_(none)_');
  } else {
    out.push('| Rank | Company | Tier | ATS | Jobs |');
    out.push('|---|---|---|---|---|');
    top.forEach((r, i) => {
      out.push(`| ${i + 1} | ${r.name} | ${r.tier} | ${r.ats_detected} | ${r.job_count} |`);
    });
  }
  out.push('');
  out.push('## Flags');
  out.push('');
  if (empties.length) {
    out.push(`### Empty boards (API works but 0 openings) — ${empties.length}`);
    for (const r of empties) out.push(`- ${r.name} (T${r.tier}, ${r.ats_detected}/${r.slug_used})`);
    out.push('');
  }
  if (slugHintMisses.length) {
    out.push(`### slug_hint missed but a variant matched — ${slugHintMisses.length}`);
    for (const r of slugHintMisses) out.push(`- ${r.name} → ${r.ats_detected}/${r.slug_used}`);
    out.push('');
  }
  if (!empties.length && !slugHintMisses.length) {
    out.push('_(nothing unusual)_');
  }

  fs.writeFileSync(SUMMARY_PATH, out.join('\n') + '\n', 'utf8');
}

main().catch(err => {
  log(`error: ${err.stack || err.message}`);
  process.exit(1);
});
