// Email primitives — HTML row rendering, sorting, top-pick selection.
// Used by the weekly digest (src/weekly.js). The daily job (src/daily.js)
// does not send email; it only writes snapshots and feed.json.

const fs = require('node:fs');
const path = require('node:path');
const { Resend } = require('resend');

const TIER_LABELS = ['1', '2', '2.5', '3', '4'];

// Mode rank for sort tiebreaking — higher means "more remote-leaning".
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
  const [y, m, d] = String(dateStr).split('-').map(Number);
  if (!y || !m || !d) return dateStr;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
    timeZone: 'UTC',
  }).format(dt);
}

function formatShortDate(dateStr) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  if (!y || !m || !d) return dateStr;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return new Intl.DateTimeFormat('en-US', {
    month: 'short', day: 'numeric',
    timeZone: 'UTC',
  }).format(dt);
}

function formatFit(fit) {
  const f = Number.isFinite(fit) ? fit : 0;
  const rounded = Math.round(f * 2) / 2;
  const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  return `${text}/5`;
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

// Sort order:
//   1. priority_score desc (fit × realism)
//   2. mode rank desc
//   3. tier asc
//   4. salary_max_base desc
//   5. company asc
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

// --- HTML builders ----------------------------------------------------------

function modeChip(mode) {
  const label = MODE_LABEL[mode];
  if (!label) return '';
  let bg, fg;
  if (mode === 'fully_remote' || mode === 'remote_friendly') { bg = '#e6f4ea'; fg = '#137333'; }
  else if (mode === 'hybrid_2_3' || mode === 'hybrid_4_plus')  { bg = '#fef7e0'; fg = '#b06000'; }
  else                                                         { bg = '#f1f3f4'; fg = '#5f6368'; }
  return `<span style="background:${bg};color:${fg};padding:2px 8px;border-radius:10px;font-size:11px;margin-right:6px;">${escapeHtml(label)}</span>`;
}

function tierChip(tier) {
  return `<span style="background:#eef;color:#33a;padding:2px 8px;border-radius:10px;font-size:11px;margin-right:6px;">Tier ${escapeHtml(String(tier))}</span>`;
}

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
  const arr = (p.metros && p.metros.length) ? p.metros : (p.metro ? [p.metro] : []);
  const named = arr.filter(m => m && m !== 'other');

  if (named.length) {
    const labels = named.map(m => m === 'remote' ? 'Remote' : m.toUpperCase());
    labels.sort((a, b) => {
      const aR = a === 'Remote', bR = b === 'Remote';
      if (aR && !bR) return 1;
      if (!aR && bR) return -1;
      return a.localeCompare(b);
    });
    return labels.join(', ');
  }

  if (p.locations && p.locations.length) {
    return [...new Set(p.locations)].join(', ');
  }
  return null;
}

function modeBlurb(p) {
  if (Number.isFinite(p.office_days) && p.office_days >= 1) {
    return `${p.office_days} day${p.office_days === 1 ? '' : 's'} in office`;
  }
  if ((p.mode === 'hybrid_2_3' || p.mode === 'hybrid_4_plus')
      && (p.office_days == null)) {
    return 'Hybrid';
  }
  return '';
}

function buildMetaSegments(p) {
  const salary = formatSalary(p.salary_min_base, p.salary_max_base);
  const metroLabel = metroDisplay(p) || 'Location not listed';
  const blurb = modeBlurb(p);
  return [metroLabel, blurb || null, salary].filter(Boolean).join(' · ');
}

function postingRow(p, { muted = false } = {}) {
  const meta = buildMetaSegments(p);
  const style = muted
    ? 'border-bottom:1px solid #f4f4f4;padding:8px 0;opacity:0.5;'
    : 'border-bottom:1px solid #eee;padding:10px 0;';
  return `
    <div style="${style}">
      <div style="margin-bottom:4px;">
        ${fitChip(p.fit_score)}${tierChip(p.tier)}${modeChip(p.mode)}
      </div>
      <div style="font-size:15px;line-height:1.4;">
        <strong>${escapeHtml(p.company)}</strong> — <a href="${escapeHtml(p.apply_url)}" style="color:#1a73e8;text-decoration:none;">${escapeHtml(p.title)}</a>
      </div>
      <div style="color:#5f6368;font-size:12px;margin-top:2px;">
        ${escapeHtml(meta)}${meta ? ' · ' : ''}${resumeChip(p.recommended_resume)}
      </div>
    </div>`;
}

function postingRowTopFive(p) {
  const meta = buildMetaSegments(p);
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
        ${escapeHtml(meta)}${meta ? ' · ' : ''}${resumeChip(p.recommended_resume)}
      </div>
    </div>`;
}

// Top picks for the email body. Two passes — first preferring unique
// companies, second relaxing the unique constraint so we don't pad with
// low-fit roles when fewer than max_count companies have eligible
// (>= min_fit_score) roles. Also drops stretch roles (realism < 0.5).
function pickTopForBody(sorted, max, minFitScore = 0) {
  const eligible = sorted.filter(p =>
    (p.fit_score || 0) >= minFitScore
    && !(Number.isFinite(p.realism_score) && p.realism_score < 0.5)
  );
  const seen = new Set();
  const firstPass = [];
  const dupes = [];
  for (const p of eligible) {
    if (seen.has(p.company)) { dupes.push(p); continue; }
    seen.add(p.company);
    firstPass.push(p);
  }
  const out = firstPass.slice(0, max);
  if (out.length < max) {
    for (const p of dupes) {
      out.push(p);
      if (out.length >= max) break;
    }
  }
  return out;
}

async function sendOrPreview({ html, subject, dryRun, previewPath, subjectPrefix }) {
  const finalSubject = subjectPrefix ? `${subjectPrefix}${subject}` : subject;
  if (dryRun) {
    fs.mkdirSync(path.dirname(previewPath), { recursive: true });
    fs.writeFileSync(previewPath, html);
    return { dryRun: true, previewPath, subject: finalSubject };
  }
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error('RESEND_API_KEY env var not set');
  const from = process.env.RESEND_FROM || 'onboarding@resend.dev';
  const to = process.env.RESEND_TO || 'alexfishburn@gmail.com';
  const resend = new Resend(apiKey);
  const r = await resend.emails.send({ from, to: [to], subject: finalSubject, html });
  return { dryRun: false, from, to, subject: finalSubject, id: r.data && r.data.id, error: r.error };
}

module.exports = {
  buildHtml: null,  // explicit — daily buildHtml is retired; weekly owns its own
  sendOrPreview,
  sortPostings, pickTopByCompany, pickTopForBody,
  formatFit, formatLongDate, formatShortDate,
  tierBreakdownHtml, tierBreakdownText, tierChip, tierPillHtml,
  modeChip, fitChip, resumeChip,
  postingRow, postingRowTopFive,
  escapeHtml, buildMetaSegments,
  MODE_RANK, TIER_LABELS,
};
