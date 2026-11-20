// Weekly digest — Cloudflare Worker entry.
//
// Reads the last 7 R2 snapshots, aggregates roles whose first_seen_date is
// within the window, dedupes, runs the freshness check, builds + sends the
// one email. On any fatal error, sends a single "WEEKLY DIGEST FAILED" alert.

import defaultCompanies from './companies.json' with { type: 'json' };
import defaultConfig from './config.json' with { type: 'json' };

import { dedupePostings } from './dedupe.js';
import { evaluateAlerts } from './health.js';
import { freshnessCheck } from './freshness.js';
import {
  sortPostings, pickTopForBody,
  tierBreakdownHtml, postingRow, postingRowTopFive,
  formatShortDate, escapeHtml,
  sendEmail,
} from './emailer.js';
import {
  HEALTH_KEY, COMPANIES_KEY,
  SNAPSHOT_PREFIX, snapshotKeyFor,
  kvGetJson, r2ListRecentSnapshots,
} from './storage.js';

function todayInET() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

function daysBefore(dateStr, n) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - n);
  return dt.toISOString().slice(0, 10);
}

function weekWindow(today) {
  const dates = [];
  for (let i = 6; i >= 0; i--) dates.push(daysBefore(today, i));
  return { dates, start: dates[0], end: dates[6] };
}

async function loadWindowSnapshots(r2, windowDates) {
  const byDate = new Map();
  await Promise.all(windowDates.map(async date => {
    const obj = await r2.get(snapshotKeyFor(date));
    if (!obj) return;
    try {
      const snap = await obj.json();
      byDate.set(date, snap);
    } catch { /* ignore unreadable */ }
  }));
  return byDate;
}

function aggregateWeek(snapshotsByDate, windowDates) {
  const byId = new Map();
  const windowSet = new Set(windowDates);
  for (const date of windowDates) {
    const snap = snapshotsByDate.get(date);
    if (!snap) continue;
    for (const p of (snap.postings || [])) {
      if (!p.first_seen_date || !windowSet.has(p.first_seen_date)) continue;
      byId.set(p.id, p);
    }
  }
  return [...byId.values()];
}

function daysCovered(snapshotsByDate, windowDates) {
  const result = { success: [], missing: [], failed: [] };
  for (const date of windowDates) {
    const snap = snapshotsByDate.get(date);
    if (!snap) { result.missing.push(date); continue; }
    const failed = snap.fetch_summary && snap.fetch_summary.companies_failed;
    const total  = snap.fetch_summary && snap.fetch_summary.companies_total;
    if (failed && total && failed / total > 0.2) {
      const names = (snap.fetch_summary.failures || []).map(f => f.company).slice(0, 5).join(', ');
      result.failed.push({
        date,
        reason: `${failed}/${total} companies failed to fetch (${names}${snap.fetch_summary.failures.length > 5 ? ', …' : ''})`,
      });
    } else {
      result.success.push(date);
    }
  }
  return result;
}

function slugHealthIssues(health, companies, windowDates, config) {
  if (!health || !health.companies) return { companies: [], count: 0 };
  const windowSet = new Set(windowDates);
  const issues = new Map();
  const note = (name, reason) => { if (!issues.has(name)) issues.set(name, reason); };

  for (const c of companies) {
    const entry = health.companies[c.name];
    if (!entry || !entry.history) continue;
    const inWindow = entry.history.filter(h => windowSet.has(h.date));
    if (!inWindow.length) continue;
    const failDays = inWindow.filter(h => h.status === 'fail');
    if (failDays.length) {
      const last = failDays[0];
      note(c.name, `fetch failed ${failDays.length} day${failDays.length === 1 ? '' : 's'} this week (${c.ats}:${c.slug}, last: ${last.date})`);
    }
  }

  const latestDate = [...windowDates].sort().reverse()[0];
  const alerts = evaluateAlerts(health, companies, latestDate, config);
  for (const a of alerts.suspicious_zero) {
    const had = a.entry.last_nonzero_count != null
      ? `had ${a.entry.last_nonzero_count} on ${a.entry.last_nonzero_date}`
      : `no prior history`;
    note(a.company.name, `suspicious zero (${a.company.ats}:${a.company.slug}, ${had})`);
  }
  for (const a of alerts.sustained_zero) {
    note(a.company.name, `zero jobs for ${a.entry.consecutive_zero_days} consecutive days (${a.company.ats}:${a.company.slug})`);
  }

  const out = [...issues.entries()].map(([name, reason]) => ({ name, reason }));
  out.sort((a, b) => a.name.localeCompare(b.name));
  return { companies: out, count: out.length };
}

function collectWeekRecoveriesAndFailures(health, windowDates) {
  const recoveries = [];
  const persistent = [];
  if (!health || !health.companies) return { recoveries, persistent };
  const windowSet = new Set(windowDates);
  for (const [name, entry] of Object.entries(health.companies)) {
    for (const r of (entry.recoveries || [])) {
      if (windowSet.has(r.date)) recoveries.push({ company: name, ...r });
    }
    if (entry.persistent_failure && windowSet.has(entry.persistent_failure.since)) {
      persistent.push({
        name,
        ats: entry.persistent_failure.ats,
        slug: entry.persistent_failure.slug,
        reason: entry.persistent_failure.reason || `fetch failure since ${entry.persistent_failure.since}; no auto-recovery variant found`,
      });
    }
  }
  return { recoveries, persistent };
}

function buildInfrastructureHtml({ coverage, slugIssues, recoveries, persistent, freshnessFetchFailures }) {
  const total = coverage.success.length + coverage.missing.length + coverage.failed.length;
  const allClean = coverage.missing.length === 0
                   && coverage.failed.length === 0
                   && slugIssues.count === 0
                   && (!recoveries || recoveries.length === 0)
                   && (!persistent || persistent.length === 0)
                   && (!freshnessFetchFailures || freshnessFetchFailures.length === 0);
  const header = `<h2 style="font-size:14px;margin:32px 0 8px;color:#5f6368;letter-spacing:0.04em;text-transform:uppercase;">Infrastructure</h2>`;
  if (allClean) return header + `<div style="font-size:13px;color:#5f6368;">All ${total} runs completed. No slug issues.</div>`;

  const bits = [];
  bits.push(`<div style="font-size:13px;color:#202124;line-height:1.6;"><strong>${coverage.success.length} of ${total}</strong> daily runs completed.</div>`);

  if (coverage.missing.length) {
    const li = coverage.missing.map(d => `<li>${escapeHtml(formatShortDate(d))} — no snapshot written</li>`).join('');
    bits.push(`<div style="font-size:13px;color:#202124;margin-top:8px;">Missing days:</div><ul style="font-size:13px;color:#5f6368;margin:4px 0 0 20px;padding:0;">${li}</ul>`);
  }
  if (coverage.failed.length) {
    const li = coverage.failed.map(f => `<li>${escapeHtml(formatShortDate(f.date))} — ${escapeHtml(f.reason)}</li>`).join('');
    bits.push(`<div style="font-size:13px;color:#202124;margin-top:8px;">Failed days:</div><ul style="font-size:13px;color:#5f6368;margin:4px 0 0 20px;padding:0;">${li}</ul>`);
  }
  if (recoveries && recoveries.length) {
    const li = recoveries.map(r => `<li><strong>${escapeHtml(r.company)}</strong>: slug <code>${escapeHtml(r.old_ats)}:${escapeHtml(r.old_slug)}</code> → <code>${escapeHtml(r.new_ats)}:${escapeHtml(r.new_slug)}</code> (recovered ${escapeHtml(formatShortDate(r.date))})</li>`).join('');
    bits.push(`<div style="font-size:13px;color:#202124;margin-top:8px;">${recoveries.length} auto-recover${recoveries.length === 1 ? 'y' : 'ies'} this week:</div><ul style="font-size:13px;color:#5f6368;margin:4px 0 0 20px;padding:0;">${li}</ul>`);
  }
  if (persistent && persistent.length) {
    const li = persistent.map(p => `<li><strong>${escapeHtml(p.name)}</strong> (${escapeHtml(p.ats)}:${escapeHtml(p.slug)}) — ${escapeHtml(p.reason)}</li>`).join('');
    bits.push(`<div style="font-size:13px;color:#202124;margin-top:8px;">${persistent.length} compan${persistent.length === 1 ? 'y' : 'ies'} with persistent failure, no auto-recovery found:</div><ul style="font-size:13px;color:#5f6368;margin:4px 0 0 20px;padding:0;">${li}</ul>`);
  }
  if (slugIssues.count) {
    const li = slugIssues.companies.map(c => `<li><strong>${escapeHtml(c.name)}</strong> — ${escapeHtml(c.reason)}</li>`).join('');
    bits.push(`<div style="font-size:13px;color:#202124;margin-top:8px;">${slugIssues.count} compan${slugIssues.count === 1 ? 'y' : 'ies'} with slug issues:</div><ul style="font-size:13px;color:#5f6368;margin:4px 0 0 20px;padding:0;">${li}</ul>`);
  }
  if (freshnessFetchFailures && freshnessFetchFailures.length) {
    const li = freshnessFetchFailures.map(f => `<li><strong>${escapeHtml(f.company.name)}</strong> (${escapeHtml(f.company.ats)}:${escapeHtml(f.company.slug)}) — freshness fetch failed (${escapeHtml(f.error)}); assumed roles still live</li>`).join('');
    bits.push(`<div style="font-size:13px;color:#202124;margin-top:8px;">${freshnessFetchFailures.length} freshness-check fetch failure${freshnessFetchFailures.length === 1 ? '' : 's'}:</div><ul style="font-size:13px;color:#5f6368;margin:4px 0 0 20px;padding:0;">${li}</ul>`);
  }
  return header + bits.join('');
}

function closedRow(p) {
  const seen = p.first_seen_date ? formatShortDate(p.first_seen_date) : '';
  return `
    <div style="padding:6px 0;border-bottom:1px solid #f4f4f4;font-size:13px;color:#5f6368;">
      <strong>${escapeHtml(p.company)}</strong> — ${escapeHtml(p.title)}${seen ? ` <span style="color:#9aa0a6;">· first seen ${escapeHtml(seen)}</span>` : ''}
    </div>`;
}

function buildSubject(count, isTest) {
  const base = `Weekly job digest — ${count} new role${count === 1 ? '' : 's'} this week`;
  return isTest ? `TEST — weekly digest preview — ${base}` : base;
}

function buildHtml({ windowStart, windowEnd, newKept, closedRoles, coverage, slugIssues, recoveries, persistent, freshnessFetchFailures, config, feedUrl, isTest }) {
  const sortedNew = sortPostings(newKept);
  const tpCfg = config.top_picks || {};
  const topMax = Number.isFinite(tpCfg.max_count) ? tpCfg.max_count : 5;
  const topMinFit = Number.isFinite(tpCfg.min_fit_score) ? tpCfg.min_fit_score : 2.5;
  const top5 = pickTopForBody(sortedNew, topMax, topMinFit);

  const appliedRoles = sortedNew.filter(p => p.applied === true);
  const visibleRoles = sortedNew.filter(p => !(p.applied === true));
  const tierHtml = tierBreakdownHtml(sortedNew);

  const headerLine = `${formatShortDate(windowStart)} to ${formatShortDate(windowEnd)}`;
  const totalText = `${sortedNew.length} new role${sortedNew.length === 1 ? '' : 's'}`;

  const topSection = top5.length
    ? `<h2 style="font-size:16px;margin:24px 0 8px;color:#202124;">Top ${top5.length} pick${top5.length === 1 ? '' : 's'} this week</h2>${top5.map(postingRowTopFive).join('')}`
    : '';

  const allSection = visibleRoles.length
    ? `<h2 style="font-size:16px;margin:24px 0 8px;color:#202124;">All new roles (${visibleRoles.length})</h2>${visibleRoles.map(p => postingRow(p)).join('')}`
    : `<p style="color:#5f6368;">No new roles this week.</p>`;

  const appliedSection = appliedRoles.length
    ? `<h2 style="font-size:14px;margin:24px 0 8px;color:#5f6368;letter-spacing:0.04em;text-transform:uppercase;">Applied (${appliedRoles.length})</h2>${appliedRoles.map(p => postingRow(p, { muted: true })).join('')}`
    : '';

  const closedSection = (closedRoles && closedRoles.length)
    ? `<h2 style="font-size:14px;margin:24px 0 8px;color:#5f6368;letter-spacing:0.04em;text-transform:uppercase;">Closed this week (${closedRoles.length})</h2>${closedRoles.map(closedRow).join('')}`
    : '';

  const infraSection = buildInfrastructureHtml({ coverage, slugIssues, recoveries, persistent, freshnessFetchFailures });

  const testBanner = isTest
    ? `<div style="background:#fff3cd;color:#664d03;padding:12px 16px;border-radius:6px;margin-bottom:16px;font-size:13px;">TEST SEND — this is a preview of the weekly digest. Real weekly digests arrive every Monday 09:00 ET.</div>`
    : '';

  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#fafafa;">
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;max-width:640px;margin:0 auto;padding:24px;background:#fff;color:#202124;">
  ${testBanner}
  <div style="color:#5f6368;font-size:12px;margin-bottom:4px;">${escapeHtml(headerLine)}</div>
  <h1 style="font-size:22px;margin:0 0 4px;">${escapeHtml(totalText)} this week</h1>
  ${tierHtml}
  ${topSection}
  ${allSection}
  ${appliedSection}
  ${closedSection}
  ${infraSection}
  <div style="margin-top:24px;padding-top:14px;border-top:1px solid #ddd;color:#5f6368;font-size:12px;">
    <a href="${escapeHtml(feedUrl)}" style="color:#1a73e8;">Full feed</a>
  </div>
</div></body></html>`;
}

export async function runWeekly(env, { isTest = false, skipFreshness = false, skipSend = false, log = m => console.log(m) } = {}) {
  const config = defaultConfig;
  const companies = (await kvGetJson(env.KV, COMPANIES_KEY)) || defaultCompanies;
  const health = await kvGetJson(env.KV, HEALTH_KEY);

  const today = todayInET();
  const { dates: windowDates, start, end } = weekWindow(today);
  log(`weekly digest — window ${start} .. ${end} (today=${today})`);

  const snapshotsByDate = await loadWindowSnapshots(env.R2, windowDates);
  const aggregated = aggregateWeek(snapshotsByDate, windowDates);
  log(`aggregated ${aggregated.length} postings across ${snapshotsByDate.size} snapshot(s)`);

  const deduped = dedupePostings(aggregated);
  log(`deduped to ${deduped.length} rows`);

  let alive = deduped;
  let closedRoles = [];
  let freshnessFetchFailures = [];
  if (!skipFreshness && deduped.length) {
    try {
      const f = await freshnessCheck(deduped, companies, { log });
      alive = f.alive;
      closedRoles = f.closed;
      freshnessFetchFailures = f.fetchFailures;
    } catch (err) {
      log(`freshness check error: ${err.stack || err.message} — falling through`);
    }
  } else if (skipFreshness) {
    log('freshness check skipped');
  }

  const coverage = daysCovered(snapshotsByDate, windowDates);
  log(`coverage — success=${coverage.success.length} missing=${coverage.missing.length} failed=${coverage.failed.length}`);

  const slugIssues = slugHealthIssues(health, companies, windowDates, config);
  const { recoveries, persistent } = collectWeekRecoveriesAndFailures(health, windowDates);
  log(`slug issues=${slugIssues.count} recoveries=${recoveries.length} persistent=${persistent.length}`);

  const subject = buildSubject(alive.length, isTest);
  const html = buildHtml({
    windowStart: start, windowEnd: end,
    newKept: alive, closedRoles,
    coverage, slugIssues, recoveries, persistent, freshnessFetchFailures,
    config, feedUrl: config.feed_page_url, isTest,
  });

  log(`preflight: alive=${alive.length} closed=${closedRoles.length} test=${isTest} skipSend=${skipSend}`);

  if (skipSend) {
    log(`skipSend=true — preview HTML returned, no Resend call`);
    return { subject, id: null, html, counts: { alive: alive.length, closed: closedRoles.length, recoveries: recoveries.length } };
  }

  const result = await sendEmail({
    apiKey: env.RESEND_API_KEY,
    from: env.RESEND_FROM || 'onboarding@resend.dev',
    to: env.RESEND_TO || 'alexfishburn@gmail.com',
    subject, html,
  });
  log(`sent — id=${result.id}`);
  return { subject, id: result.id, counts: { alive: alive.length, closed: closedRoles.length, recoveries: recoveries.length, persistent: persistent.length } };
}

export async function sendFailureAlert(env, err) {
  if (!env.RESEND_API_KEY) return;
  const today = todayInET();
  const from = env.RESEND_FROM || 'onboarding@resend.dev';
  const to = env.RESEND_TO || 'alexfishburn@gmail.com';
  const subject = `WEEKLY DIGEST FAILED ${today}`;
  const stack = escapeHtml(err.stack || err.message || String(err));
  const html = `<!doctype html>
<html><body style="margin:0;padding:24px;font-family:-apple-system,BlinkMacSystemFont,Helvetica,Arial,sans-serif;">
<h1 style="font-size:20px;color:#b00020;">Weekly digest failed</h1>
<div style="color:#5f6368;font-size:12px;margin-bottom:12px;">${escapeHtml(today)}</div>
<pre style="background:#f8f9fa;padding:12px;border-radius:6px;overflow-x:auto;font-size:12px;white-space:pre-wrap;">${stack}</pre>
</body></html>`;
  await sendEmail({ apiKey: env.RESEND_API_KEY, from, to, subject, html });
}
