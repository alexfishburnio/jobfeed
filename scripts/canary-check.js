#!/usr/bin/env node
// Canary: detects when the daily-feed cron silently misses a fire.
//
// Runs from .github/workflows/canary.yml at 00:30 UTC daily — ~73 min
// after the main daily-feed cron's 23:17 UTC fire.
//
// Phase 1.7: switched from string-matching the commit message
// ("feed: ${yesterday-UTC}") to an age-based check on the most recent
// "feed: " commit. The string match false-positives whenever the daily
// cron is delayed past midnight UTC — the commit message uses today-UTC
// instead of yesterday-UTC, and the canary mistakenly alerts. Age-based
// check tolerates that delay correctly, while still alerting if no
// "feed: " commit lands within a 30-hour window (covers normal ~24h
// cycles plus generous slack for delayed but successful runs).

const { execSync } = require('node:child_process');

const MAX_AGE_HOURS = 30;

function git(args) {
  return execSync(`git ${args}`, { encoding: 'utf8' }).trim();
}

function getLatestFeedCommit() {
  // Most recent commit whose subject starts with "feed:". Returns null
  // if no such commit exists.
  const out = (() => {
    try {
      return execSync(
        `git log -1 --grep='^feed:' --format='%H|%s|%cI'`,
        { encoding: 'utf8' },
      ).trim();
    } catch { return ''; }
  })();
  if (!out) return null;
  const [sha, subject, dateISO] = out.split('|');
  return { sha, subject, dateISO };
}

// Pure decision function — extracted so test-canary.js can verify it
// without invoking git or the network.
function isCanaryOk({ subject, commitDateISO, nowMs, maxAgeHours = MAX_AGE_HOURS }) {
  if (!subject || !commitDateISO) return false;
  if (!/^feed:/.test(subject)) return false;
  const commitMs = new Date(commitDateISO).getTime();
  if (!Number.isFinite(commitMs)) return false;
  const ageHours = (nowMs - commitMs) / 3600000;
  return ageHours >= 0 && ageHours <= maxAgeHours;
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

async function alert({ subject, commitDateISO, sha, repo, apiKey, from, to }) {
  if (!apiKey) {
    console.error('RESEND_API_KEY not set; cannot alert');
    return { ok: false };
  }
  const actionsUrl = `https://github.com/${repo}/actions`;
  const ageHours = commitDateISO
    ? ((Date.now() - new Date(commitDateISO).getTime()) / 3600000).toFixed(1)
    : 'n/a';
  const html = `<!doctype html>
<html><body style="margin:0;padding:0;background:#fafafa;">
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px;background:#fff;color:#202124;">
  <h1 style="font-size:20px;margin:0 0 8px;">Jobfeed cron missed today's run</h1>
  <p style="font-size:14px;line-height:1.5;color:#202124;">No "feed: …" commit on <code>main</code> within the last ${MAX_AGE_HOURS} hours. Most recent feed commit:</p>
  <ul style="font-size:13px;line-height:1.6;color:#202124;margin:8px 0 16px 20px;padding:0;">
    <li><strong>SHA:</strong> <code>${escapeHtml(sha || 'none')}</code></li>
    <li><strong>Committer date:</strong> ${escapeHtml(commitDateISO || 'never')}</li>
    <li><strong>Message:</strong> ${escapeHtml(subject || '(no feed commit found)')}</li>
    <li><strong>Age:</strong> ${escapeHtml(String(ageHours))} hours</li>
  </ul>
  <p style="font-size:13px;"><a href="${escapeHtml(actionsUrl)}" style="color:#1a73e8;">→ Open Actions tab to inspect daily-feed and daily-fallback runs</a></p>
  <p style="font-size:12px;color:#5f6368;margin-top:16px;padding-top:12px;border-top:1px solid #ddd;">Triggered by the canary workflow at 00:30 UTC. If both the main and fallback workflows missed their fires, manually trigger one with <code>gh workflow run daily.yml</code> or <code>gh workflow run daily-fallback.yml</code>.</p>
</div></body></html>`;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from, to: [to],
      subject: "Jobfeed cron missed today's run",
      html,
    }),
  });
  const body = await res.json().catch(() => ({}));
  console.log('alert response:', res.status, JSON.stringify(body));
  return { ok: res.ok };
}

async function run() {
  const repo   = process.env.GITHUB_REPOSITORY || 'alexfishburnio/jobfeed';
  const apiKey = process.env.RESEND_API_KEY;
  const from   = process.env.RESEND_FROM || 'onboarding@resend.dev';
  const to     = process.env.RESEND_TO   || 'alexfishburn@gmail.com';

  const feed = getLatestFeedCommit();
  const now = Date.now();
  const ok = feed
    ? isCanaryOk({ subject: feed.subject, commitDateISO: feed.dateISO, nowMs: now })
    : false;

  if (ok) {
    const ageHours = ((now - new Date(feed.dateISO).getTime()) / 3600000).toFixed(1);
    console.log(`OK: latest "feed:" commit is ${ageHours}h old — "${feed.subject}" (${feed.sha.slice(0, 7)})`);
    return;
  }

  if (feed) {
    const ageHours = ((now - new Date(feed.dateISO).getTime()) / 3600000).toFixed(1);
    console.error(`MISSED: latest "feed:" commit is ${ageHours}h old — "${feed.subject}" (${feed.sha.slice(0, 7)} @ ${feed.dateISO})`);
  } else {
    console.error(`MISSED: no "feed:" commit found on main`);
  }

  const r = await alert({
    subject: feed?.subject,
    commitDateISO: feed?.dateISO,
    sha: feed?.sha,
    repo, apiKey, from, to,
  });
  if (!r.ok) process.exit(1);
  process.exit(2);  // non-zero so the canary run is visibly failed in the Actions UI
}

if (require.main === module) {
  run().catch(err => {
    console.error('canary error:', err.stack || err.message);
    process.exit(1);
  });
}

module.exports = { isCanaryOk, MAX_AGE_HOURS };
