#!/usr/bin/env node
// Canary: detects when the daily-feed cron silently misses a fire.
//
// Runs from .github/workflows/canary.yml at 00:30 UTC daily — about an
// hour after the main daily-feed cron is supposed to have committed
// "feed: YYYY-MM-DD" (where YYYY-MM-DD is yesterday from canary's UTC
// perspective, since main fires at 23:17 UTC the previous calendar day).
//
// If the latest commit on main doesn't match the expected message,
// sends a Resend alert email and exits non-zero (so the canary run
// itself is also visibly failed in the Actions UI).

const { execSync } = require('node:child_process');

const repo      = process.env.GITHUB_REPOSITORY || 'alexfishburnio/jobfeed';
const apiKey    = process.env.RESEND_API_KEY;
const from      = process.env.RESEND_FROM || 'onboarding@resend.dev';
const to        = process.env.RESEND_TO   || 'alexfishburn@gmail.com';

function git(args) {
  return execSync(`git ${args}`, { encoding: 'utf8' }).trim();
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

(async () => {
  const sha     = git('rev-parse HEAD');
  const subject = git('log -1 --format=%s');
  const date    = git('log -1 --format=%cI');

  // Expected: "feed: ${yesterday-UTC}". The main cron fires at 23:17 UTC
  // and stamps its commit with `date -u +%Y-%m-%d` for that same UTC day.
  // The canary fires at 00:30 UTC the next UTC day, so "yesterday from now"
  // is the date the latest cron commit should carry.
  const now = new Date();
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000)
    .toISOString().slice(0, 10);
  const expected = `feed: ${yesterday}`;

  if (subject === expected) {
    console.log(`OK: latest commit on main is "${subject}" (${sha.slice(0, 7)})`);
    return;
  }

  console.error(`MISSED: expected "${expected}", got "${subject}" (${sha.slice(0, 7)} @ ${date})`);

  if (!apiKey) {
    console.error('RESEND_API_KEY not set; cannot alert');
    process.exit(2);
  }

  const actionsUrl = `https://github.com/${repo}/actions/workflows/daily.yml`;
  const html = `<!doctype html>
<html><body style="margin:0;padding:0;background:#fafafa;">
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px;background:#fff;color:#202124;">
  <h1 style="font-size:20px;margin:0 0 8px;">Jobfeed cron missed today's run</h1>
  <p style="font-size:14px;line-height:1.5;color:#202124;">Expected the main <code>daily-feed</code> workflow to commit <code>${escapeHtml(expected)}</code> by 00:30 UTC. The latest commit on <code>main</code> is something else:</p>
  <ul style="font-size:13px;line-height:1.6;color:#202124;margin:8px 0 16px 20px;padding:0;">
    <li><strong>SHA:</strong> <code>${escapeHtml(sha)}</code></li>
    <li><strong>Committer date:</strong> ${escapeHtml(date)}</li>
    <li><strong>Message:</strong> ${escapeHtml(subject)}</li>
  </ul>
  <p style="font-size:13px;"><a href="${escapeHtml(actionsUrl)}" style="color:#1a73e8;">→ Open Actions tab to inspect daily-feed runs</a></p>
  <p style="font-size:12px;color:#5f6368;margin-top:16px;padding-top:12px;border-top:1px solid #ddd;">Triggered by canary workflow. If you just pushed a manual commit on top of the cron's commit, this can be a false positive — re-run the cron manually with <code>gh workflow run daily.yml</code>.</p>
</div></body></html>`;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to: [to],
      subject: "Jobfeed cron missed today's run",
      html,
    }),
  });
  const body = await res.json().catch(() => ({}));
  console.log('alert response:', res.status, JSON.stringify(body));
  if (!res.ok) process.exit(1);
  process.exit(2);  // non-zero so the canary run is visibly failed in UI
})();
