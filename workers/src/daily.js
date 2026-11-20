// Daily orchestrator — Cloudflare Worker entry. Silent (no email).
//
// Env bindings expected:
//   env.KV    — KV namespace for state/health/companies
//   env.R2    — R2 bucket for snapshots and public feed.json
//   env.CONFIG_JSON — bundled config (passed in from the worker shim)
//
// On a fresh deploy, env.KV.get('companies') is null — we seed it from
// the bundled companies.json fallback.

import defaultCompanies from './companies.json' with { type: 'json' };
import defaultConfig from './config.json' with { type: 'json' };

import { fetchCompany } from './fetcher.js';
import { parsePosting } from './parser.js';
import { scoreAll } from './scorer.js';
import { diff } from './differ.js';
import { buildFeedFromSnapshot } from './exporter.js';
import { update as updateHealth } from './health.js';
import {
  selectRecoveryCandidates, recoverCompany,
  updateCompanySlug, recordRecoveryOutcome,
  clearPersistentFailureOnSuccess,
} from './slug-recovery.js';
import {
  STATE_KEY, HEALTH_KEY, COMPANIES_KEY,
  FEED_KEY, snapshotKeyFor,
  kvGetJson, kvPutJson,
  r2GetJson, r2PutJson,
} from './storage.js';

const REQUEST_DELAY_MS = 1500;
const sleep = ms => new Promise(r => setTimeout(r, ms));

function todayInET() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

async function fetchAll(companies, log) {
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

export async function runDaily(env, { log = m => console.log(m), limit } = {}) {
  const config = defaultConfig;  // bundled; no runtime override
  let companies = await kvGetJson(env.KV, COMPANIES_KEY);
  if (!companies || !Array.isArray(companies) || !companies.length) {
    log('seeding KV/companies from bundled companies.json');
    companies = defaultCompanies;
    await kvPutJson(env.KV, COMPANIES_KEY, companies);
  }
  if (Number.isFinite(limit)) {
    companies = companies.slice(0, limit);
    log(`limit: probing first ${companies.length} companies`);
  }

  const date = todayInET();
  const startedAt = new Date().toISOString();
  log(`daily run — ${date} — ${companies.length} companies (silent)`);

  log('fetching...');
  const { successes, failures, runResults } = await fetchAll(companies, log);
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

  const prevState = await kvGetJson(env.KV, STATE_KEY);
  const prevSnapshotKey = prevState && prevState.date ? snapshotKeyFor(prevState.date) : null;
  const prevSnapshot = prevSnapshotKey ? await r2GetJson(env.R2, prevSnapshotKey) : null;
  const d = diff({ kept, excluded }, prevState, prevSnapshot, date);
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

  await r2PutJson(env.R2, snapshotKeyFor(date), snapshot);
  await kvPutJson(env.KV, STATE_KEY, { date, postings: d.state_map });
  log(`wrote R2 snapshot ${snapshotKeyFor(date)} and KV state`);

  const feed = buildFeedFromSnapshot(snapshot, config.feed_retention_days || 30);
  await r2PutJson(env.R2, FEED_KEY, feed, { publicAccess: true });
  log(`wrote R2 feed.json (${feed.days.length} day(s))`);

  // Slug-health + auto-recovery
  let recoveries = [];
  try {
    const preRunHealth = await kvGetJson(env.KV, HEALTH_KEY);
    const updatedHealth = updateHealth(preRunHealth, runResults, date);

    const companiesByName = new Map(companies.map(c => [c.name, c]));
    const candidates = selectRecoveryCandidates(runResults, companiesByName, preRunHealth);
    if (candidates.length) {
      log(`slug-recovery: ${candidates.length} candidate(s)`);
      for (const company of candidates) {
        try {
          const outcome = await recoverCompany(company, { log });
          outcome.old_ats = company.ats;
          outcome.old_slug = company.slug;
          outcome.last_http_status = (runResults.find(r => r.name === company.name) || {}).http_status || null;
          if (outcome.recovered) {
            updateCompanySlug(companies, company.name, outcome.new_ats, outcome.new_slug);
            await kvPutJson(env.KV, COMPANIES_KEY, companies);
            log(`  companies KV updated: ${company.name}: ${company.ats}:${company.slug} → ${outcome.new_ats}:${outcome.new_slug}`);
            recoveries.push({
              company: company.name,
              old_ats: company.ats, old_slug: company.slug,
              new_ats: outcome.new_ats, new_slug: outcome.new_slug,
              jobs_found: outcome.jobs,
            });
          }
          recordRecoveryOutcome(updatedHealth, company.name, outcome, date);
        } catch (err) {
          log(`  recovery error for ${company.name}: ${err.stack || err.message}`);
        }
      }
    }

    for (const r of runResults) {
      if (r.status === 'ok' || r.status === 'zero') {
        clearPersistentFailureOnSuccess(updatedHealth, r.name);
      }
    }

    await kvPutJson(env.KV, HEALTH_KEY, updatedHealth);
    log(`wrote KV health`);
    if (recoveries.length) log(`slug-recovery: ${recoveries.length} auto-recovered`);
  } catch (err) {
    log(`slug-health/recovery error: ${err.stack || err.message}`);
  }

  return {
    date,
    new: snapshot.counts.new_today,
    ongoing: snapshot.counts.ongoing,
    closed_today: snapshot.counts.closed_today,
    closed: snapshot.counts.closed,
    excluded_new: snapshot.counts.excluded_new,
    fetch_failures: failures.length,
    slug_recoveries: recoveries,
  };
}
