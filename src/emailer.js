// Builds the daily email (subject + HTML body) and sends it via Resend.
// Supports a dry-run mode that writes the HTML to disk for preview instead.

const fs = require('node:fs');
const path = require('node:path');
const { Resend } = require('resend');

const TIER_LABELS = ['1', '2', '2.5', '3', '4'];

// Mode rank for sort tiebreaking — higher means "more remote-leaning".
// Used in sortPostings(); fit_score itself is content-only (Phase 1.2).
const MODE_RANK = {
  fully_remote: 4,
  remote_friendly: 3,
  hybrid_2_3: 2,
  hybrid_4_plus: 1,
  fully_onsite: 0,
  unknown: 0,
};

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatSalary(min, max) {
  const k = n => `$${Math.round(n / 1000)}k`;
  if (Number.isFinite(min) && Number.isFinite(max)) return `${k(min)}–${k(max)}`;
  if (Number.isFinite(min)) return `${k(min)}+ base`;
  if (Number.isFinite(max)) return `Up to ${k(max)} base`;
  return 'Salary not listed';
}

const MODE_LABEL = {
  fully_remote:    'Remote',
  remote_friendly: 'Remote-friendly',
  hybrid_2_3:      'Hybrid',
  hybrid_4_plus:   'Hybrid 4+',
  fully_onsite:    'Onsite',
  unknown:         '',
};

const RESUME_LABEL = {
  ads:     'ads resume',
  aipm:    'aipm resume',
  general: 'general resume',
};

function tierBreakdownText(postings) {
  const counts = {};
  for (const p of postings) counts[String(p.tier)] = (counts[String(p.tier)] || 0) + 1;
  const parts = [];
  for (const t of TIER_LABELS) {
    const n = counts[t] || 0;
    if (n) parts.push(`Tier ${t}: ${n}`);
  }
  return parts.join(' · ') || 'no tier breakdown';
}

function formatLongDate(dateStr) {
  // dateStr is "YYYY-MM-DD" in ET. Build a UTC midnight Date for that
  // calendar day so the en-US formatter renders the correct weekday
  // regardless of the runtime's local timezone.
  const [y, m, d] = String(dateStr).split('-').map(Number);
  if (!y || !m || !d) return dateStr;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
    timeZone: 'UTC',
  }).format(dt);
}

function formatFit(fit) {
  const f = Number.isFinite(fit) ? fit : 0;
  // Round to nearest half so 4.6 → 4.5, 4.9 → 5. Drop trailing ".0".
  const rounded = Math.round(f * 2) / 2;
  const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  return `${text}/5`;
}

function pickTopCompanyNames(newKept, n) {
  return pickTopByCompany(sortPostings(newKept), n).map(p => p.company);
}

// Iterates through a pre-sorted list and picks the highest-fit role per
// unique company until `n` distinct companies are picked or the pool is
// exhausted.
function pickTopByCompany(sorted, n) {
  const seen = new Set();
  const out = [];
  for (const p of sorted) {
    if (seen.has(p.company)) continue;
    seen.add(p.company);
    out.push(p);
    if (out.length >= n) break;
  }
  return out;
}

// Sort order (Phase 1.3):
//   1. priority_score desc (fit × realism — surfaces realistic, high-content roles)
//   2. mode rank desc
//   3. tier asc (Tier 1 first)
//   4. salary_max_base desc (null treated as 0)
//   5. company asc (deterministic tiebreak)
function sortPostings(arr) {
  return [...arr].sort((a, b) => {
    const ap = a.priority_score ?? 0;
    const bp = b.priority_score ?? 0;
    if (bp !== ap) return bp - ap;
    const ar = MODE_RANK[a.mode] ?? 0;
    const br = MODE_RANK[b.mode] ?? 0;
    if (br !== ar) return br - ar;
    const at = Number(a.tier), bt = Number(b.tier);
    if (at !== bt) return at - bt;
    const aS = a.salary_max_base || 0;
    const bS = b.salary_max_base || 0;
    if (bS !== aS) return bS - aS;
    return (a.company || '').localeCompare(b.company || '');
  });
}

function buildSubject(newKept) {
  const n = newKept.length;
  if (n === 0) return '0 new roles today';
  const top = pickTopCompanyNames(newKept, 3);
  return `${n} new roles — top: ${top.join(', ')}`;
}

// --- HTML builders ----------------------------------------------------------

function modeChip(mode) {
  const label = MODE_LABEL[mode];
  if (!label) return '';
  // Color groups: green = remote-leaning, yellow = hybrid, gray = onsite/unknown.
  let bg, fg;
  if (mode === 'fully_remote' || mode === 'remote_friendly') { bg = '#e6f4ea'; fg = '#137333'; }
  else if (mode === 'hybrid_2_3' || mode === 'hybrid_4_plus')  { bg = '#fef7e0'; fg = '#b06000'; }
  else                                                         { bg = '#f1f3f4'; fg = '#5f6368'; }
  return `<span style="background:${bg};color:${fg};padding:2px 8px;border-radius:10px;font-size:11px;margin-right:6px;">${escapeHtml(label)}</span>`;
}

function tierChip(tier) {
  return `<span style="background:#eef;color:#33a;padding:2px 8px;border-radius:10px;font-size:11px;margin-right:6px;">Tier ${escapeHtml(String(tier))}</span>`;
}

// Tier breakdown pills for the email header. Same blue/gray hue family with
// Tier 1 slightly darker to indicate priority — scannable, not decorative.
const TIER_PILL_STYLE = {
  '1':   'background:#d4dbe7;color:#1f3a5f;',
  '2':   'background:#e2e8f1;color:#1f3a5f;',
  '2.5': 'background:#e8edf3;color:#3c5278;',
  '3':   'background:#eef2f7;color:#5f6368;',
  '4':   'background:#f4f6fa;color:#5f6368;',
};

function tierPillHtml(tier, count) {
  const key = String(tier);
  const style = TIER_PILL_STYLE[key] || 'background:#f4f6fa;color:#5f6368;';
  return `<span style="${style}padding:4px 10px;border-radius:12px;font-size:12px;font-weight:500;margin-right:6px;margin-bottom:4px;display:inline-block;">Tier ${escapeHtml(key)} · ${count}</span>`;
}

function tierBreakdownHtml(postings) {
  const counts = {};
  for (const p of postings) counts[String(p.tier)] = (counts[String(p.tier)] || 0) + 1;
  const pills = [];
  for (const t of TIER_LABELS) {
    const n = counts[t] || 0;
    if (n) pills.push(tierPillHtml(t, n));
  }
  return pills.length
    ? `<div style="line-height:1.8;margin-top:8px;">${pills.join('')}</div>`
    : `<div style="color:#5f6368;font-size:13px;margin-top:8px;">no tier breakdown</div>`;
}

function fitChip(fit) {
  const f = (typeof fit === 'number') ? fit : 0;
  const color = f >= 4.5 ? '#1a73e8' : f >= 3 ? '#188038' : '#5f6368';
  return `<span style="background:#fff;color:${color};border:1px solid ${color};padding:2px 8px;border-radius:10px;font-size:11px;margin-right:6px;font-weight:600;">Fit ${formatFit(f)}</span>`;
}

function resumeChip(tag) {
  const label = RESUME_LABEL[tag] || tag;
  return `<span style="color:#5f6368;font-size:12px;">→ ${escapeHtml(label)}</span>`;
}

function metroDisplay(p) {
  // Deduped groups carry `metros` (array). Singletons carry `metro` (single).
  // Render alphabetical, with "Remote" forced to the end. "other" is hidden.
  const arr = (p.metros && p.metros.length) ? p.metros : (p.metro ? [p.metro] : []);
  const labels = arr
    .filter(m => m && m !== 'other')
    .map(m => m === 'remote' ? 'Remote' : m.toUpperCase());
  labels.sort((a, b) => {
    const aR = a === 'Remote', bR = b === 'Remote';
    if (aR && !bR) return 1;
    if (!aR && bR) return -1;
    return a.localeCompare(b);
  });
  return labels.join(', ');
}

function postingRow(p) {
  const salary = formatSalary(p.salary_min_base, p.salary_max_base);
  const metroLabel = metroDisplay(p);
  // Salary is always rendered (formatSalary returns "Salary not listed"
  // when both fields are null, per Phase 1.3 spec).
  const meta = [metroLabel || null, salary]
    .filter(Boolean).join(' · ');
  const isStretch = Number.isFinite(p.realism_score) && p.realism_score < 0.5;
  const stretchHint = isStretch
    ? ` <span style="color:#9aa0a6;font-size:12px;">· stretch</span>`
    : '';
  return `
    <div style="border-bottom:1px solid #eee;padding:10px 0;">
      <div style="margin-bottom:4px;">
        ${fitChip(p.fit_score)}${tierChip(p.tier)}${modeChip(p.mode)}
      </div>
      <div style="font-size:15px;line-height:1.4;">
        <strong>${escapeHtml(p.company)}</strong> — <a href="${escapeHtml(p.apply_url)}" style="color:#1a73e8;text-decoration:none;">${escapeHtml(p.title)}</a>
      </div>
      <div style="color:#5f6368;font-size:12px;margin-top:2px;">
        ${escapeHtml(meta)}${meta ? ' · ' : ''}${resumeChip(p.recommended_resume)}${stretchHint}
      </div>
    </div>`;
}

// Top-5 picks render with company on its own line, linked title below — more
// visual room for the headline picks. The "All new roles" body still uses
// the dense single-line postingRow above.
function postingRowTopFive(p) {
  const salary = formatSalary(p.salary_min_base, p.salary_max_base);
  const metroLabel = metroDisplay(p);
  const meta = [metroLabel || null, salary]
    .filter(Boolean).join(' · ');
  const isStretch = Number.isFinite(p.realism_score) && p.realism_score < 0.5;
  const stretchHint = isStretch
    ? ` <span style="color:#9aa0a6;font-size:12px;">· stretch</span>`
    : '';
  return `
    <div style="border-bottom:1px solid #eee;padding:12px 0;">
      <div style="margin-bottom:6px;">
        ${fitChip(p.fit_score)}${tierChip(p.tier)}${modeChip(p.mode)}
      </div>
      <div style="font-weight:600;font-size:14px;color:#202124;">${escapeHtml(p.company)}</div>
      <div style="font-size:14px;margin-top:2px;">
        <a href="${escapeHtml(p.apply_url)}" style="color:#1a73e8;text-decoration:none;">${escapeHtml(p.title)}</a>
      </div>
      <div style="color:#5f6368;font-size:12px;margin-top:4px;">
        ${escapeHtml(meta)}${meta ? ' · ' : ''}${resumeChip(p.recommended_resume)}${stretchHint}
      </div>
    </div>`;
}

function excludedRow(p) {
  return `
    <div style="border-bottom:1px solid #f4f4f4;padding:6px 0;color:#5f6368;font-size:12px;">
      ${tierChip(p.tier)}<strong>${escapeHtml(p.company)}</strong> — ${escapeHtml(p.title)}
      <div style="margin-top:2px;">${escapeHtml(p.exclusion_reason || '')}</div>
    </div>`;
}

function closedRow(p) {
  return `
    <div style="padding:4px 0;color:#5f6368;font-size:12px;">
      ${tierChip(p.tier)}<strong>${escapeHtml(p.company)}</strong> — ${escapeHtml(p.title)}
    </div>`;
}

function buildHtml({ date, newKept, closedToday, excluded, feedUrl, maxRolesInBody }) {
  const sortedNew = sortPostings(newKept);
  // Top picks: 5 unique companies, highest-priority role per company.
  const top5 = pickTopByCompany(sortedNew, 5);
  const tierHtml = tierBreakdownHtml(sortedNew);
  const excludedNew = excluded.filter(p => p.status === 'new');
  const cap = Number.isFinite(maxRolesInBody) ? maxRolesInBody : sortedNew.length;
  const visibleNew = sortedNew.slice(0, cap);
  const overflow = Math.max(0, sortedNew.length - cap);

  const topSection = top5.length
    ? `<h2 style="font-size:16px;margin:24px 0 8px;color:#202124;">Top ${top5.length} ${top5.length === 1 ? 'pick' : 'picks'}</h2>${top5.map(postingRowTopFive).join('')}`
    : '';

  const overflowNote = overflow > 0
    ? `<div style="color:#5f6368;font-size:12px;margin-top:8px;">…and ${overflow} more — <a href="${escapeHtml(feedUrl)}" style="color:#1a73e8;">see full feed</a></div>`
    : '';

  const allSection = sortedNew.length
    ? `<h2 style="font-size:16px;margin:24px 0 8px;color:#202124;">All new roles${overflow ? ` <span style="color:#5f6368;font-size:13px;font-weight:normal;">(top ${cap} of ${sortedNew.length})</span>` : ''}</h2>${visibleNew.map(postingRow).join('')}${overflowNote}`
    : `<p style="color:#5f6368;">No new roles today.</p>`;

  const closedSection = closedToday.length
    ? `<h2 style="font-size:16px;margin:24px 0 8px;color:#202124;">Closed today (${closedToday.length})</h2>${closedToday.map(closedRow).join('')}`
    : '';

  const excludedFooter = `
    <div style="margin-top:32px;padding-top:16px;border-top:1px solid #ddd;color:#5f6368;font-size:12px;">
      ${excludedNew.length} new role${excludedNew.length === 1 ? '' : 's'} excluded today (salary below floor) ·
      <a href="${escapeHtml(feedUrl)}" style="color:#1a73e8;">see full feed</a>
    </div>`;

  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#fafafa;">
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;max-width:640px;margin:0 auto;padding:24px;background:#fff;color:#202124;">
  <div style="color:#5f6368;font-size:12px;margin-bottom:4px;">${escapeHtml(formatLongDate(date))}</div>
  <h1 style="font-size:22px;margin:0 0 4px;">${sortedNew.length} new role${sortedNew.length === 1 ? '' : 's'} today</h1>
  ${tierHtml}
  ${topSection}
  ${allSection}
  ${closedSection}
  ${excludedFooter}
</div></body></html>`;
}

// --- Send -------------------------------------------------------------------

async function sendOrPreview({ html, subject, dryRun, previewPath }) {
  if (dryRun) {
    fs.mkdirSync(path.dirname(previewPath), { recursive: true });
    fs.writeFileSync(previewPath, html);
    return { dryRun: true, previewPath, subject };
  }
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error('RESEND_API_KEY env var not set');
  const from = process.env.RESEND_FROM || 'onboarding@resend.dev';
  const to = process.env.RESEND_TO || 'alexfishburn@gmail.com';
  const resend = new Resend(apiKey);
  const r = await resend.emails.send({ from, to: [to], subject, html });
  return { dryRun: false, from, to, subject, id: r.data && r.data.id, error: r.error };
}

// --- Health-alert email -----------------------------------------------------

function buildHealthSubject(alerts) {
  const n = (alerts.hard_failure.length || 0)
          + (alerts.suspicious_zero.length || 0)
          + (alerts.sustained_zero.length || 0)
          + (alerts.recovery.length || 0);
  if (n === 0) return null;
  return `Jobfeed health: ${n} company alert${n === 1 ? '' : 's'}`;
}

function buildHealthHtml(alerts, date, healthJsonUrl) {
  const longDate = formatLongDate(date);

  const li = (s) => `<li style="margin-bottom:6px;">${s}</li>`;
  const section = (title, items, render) => {
    if (!items.length) return '';
    return `<h3 style="font-size:14px;margin:18px 0 6px;color:#202124;letter-spacing:0.04em;">${escapeHtml(title)} (${items.length})</h3><ul style="margin:0 0 0 20px;padding:0;font-size:13px;line-height:1.5;color:#202124;">${items.map(render).join('')}</ul>`;
  };

  const renderHardFailure = ({ company, entry }) => {
    const code = entry.last_http_status ? `HTTP ${entry.last_http_status}` : 'fetch failed';
    const last = (entry.last_nonzero_count != null && entry.last_nonzero_date)
      ? `Last successful fetch: ${escapeHtml(entry.last_nonzero_date)} (${entry.last_nonzero_count} jobs).`
      : `No successful fetch on record.`;
    return li(`<strong>${escapeHtml(company.name)}</strong> (${escapeHtml(company.ats)}: <code>${escapeHtml(company.slug)}</code>) — ${escapeHtml(code)}, slug may be invalid. ${last}`);
  };
  const renderSuspiciousZero = ({ company, entry }) => {
    const had = (entry.last_nonzero_count != null && entry.last_nonzero_date)
      ? `had ${entry.last_nonzero_count} on ${escapeHtml(entry.last_nonzero_date)}`
      : `no nonzero history on record`;
    return li(`<strong>${escapeHtml(company.name)}</strong> (${escapeHtml(company.ats)}: <code>${escapeHtml(company.slug)}</code>) — 0 jobs today, ${had}. Possible slug or ATS change.`);
  };
  const renderSustainedZero = ({ company, entry }) => {
    const last = (entry.last_nonzero_date)
      ? `Last had jobs ${escapeHtml(entry.last_nonzero_date)} (${entry.last_nonzero_count} jobs).`
      : ``;
    return li(`<strong>${escapeHtml(company.name)}</strong> (${escapeHtml(company.ats)}: <code>${escapeHtml(company.slug)}</code>) — 0 jobs for ${entry.consecutive_zero_days} consecutive days. ${last}`);
  };
  const renderRecovery = ({ company, entry, fail_streak }) => {
    return li(`<strong>${escapeHtml(company.name)}</strong> (${escapeHtml(company.ats)}: <code>${escapeHtml(company.slug)}</code>) — back online today with ${entry.last_job_count} jobs after ${fail_streak} day${fail_streak === 1 ? '' : 's'} of failure.`);
  };

  const sections = [
    section('HARD FAILURE',    alerts.hard_failure,    renderHardFailure),
    section('SUSPICIOUS ZERO', alerts.suspicious_zero, renderSuspiciousZero),
    section('SUSTAINED ZERO',  alerts.sustained_zero,  renderSustainedZero),
    section('RECOVERY',        alerts.recovery,        renderRecovery),
  ].filter(Boolean).join('');

  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#fafafa;">
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;max-width:640px;margin:0 auto;padding:24px;background:#fff;color:#202124;">
  <div style="color:#5f6368;font-size:12px;margin-bottom:4px;">${escapeHtml(longDate)}</div>
  <h1 style="font-size:20px;margin:0 0 4px;">Jobfeed health check</h1>
  ${sections}
  <div style="margin-top:24px;padding-top:14px;border-top:1px solid #ddd;color:#5f6368;font-size:12px;">
    Investigate via: <a href="${escapeHtml(healthJsonUrl)}" style="color:#1a73e8;">data/health.json</a>
  </div>
</div></body></html>`;
}

async function sendHealthAlertOrPreview({ html, subject, dryRun, previewPath, recipient }) {
  if (dryRun) {
    fs.mkdirSync(path.dirname(previewPath), { recursive: true });
    fs.writeFileSync(previewPath, html);
    return { dryRun: true, previewPath, subject };
  }
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error('RESEND_API_KEY env var not set');
  const from = process.env.RESEND_FROM || 'onboarding@resend.dev';
  const to = recipient || process.env.RESEND_TO || 'alexfishburn@gmail.com';
  const resend = new Resend(apiKey);
  const r = await resend.emails.send({ from, to: [to], subject, html });
  return { dryRun: false, from, to, subject, id: r.data && r.data.id, error: r.error };
}

module.exports = {
  buildSubject, buildHtml, sendOrPreview,
  buildHealthSubject, buildHealthHtml, sendHealthAlertOrPreview,
  sortPostings, pickTopCompanyNames, pickTopByCompany,
  formatFit, formatLongDate, MODE_RANK,
};
