// Cloudflare Worker: weekly jobfeed digest.
//
// Scheduled trigger: cron in wrangler.weekly.toml fires Monday(s); handler
// guards on ET day-of-week == 1 and ET hour == target.
//
// Fetch handler supports:
//   GET /?secret=... &preview=1          — return HTML preview, NO send
//   GET /?secret=... &test=1             — send a TEST-labeled email
//   GET /?secret=... &send=1             — send the real email
//   GET /?secret=... &skip-freshness=1   — skip the freshness fetch

import { runWeekly, sendFailureAlert } from './weekly.js';

function etHour() {
  return parseInt(new Intl.DateTimeFormat('en-US', { hour: '2-digit', hour12: false, timeZone: 'America/New_York' })
    .format(new Date()), 10);
}
function etDow() {
  // 1=Monday ... 7=Sunday; using en-GB locale's ISO-ish numeric weekday
  // trick is unreliable, so derive from the date's UTC parts + ET offset.
  const now = new Date();
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const jsDow = et.getDay();  // 0=Sunday .. 6=Saturday
  return jsDow === 0 ? 7 : jsDow;
}

export default {
  async scheduled(event, env, ctx) {
    const hour = etHour();
    const dow = etDow();
    const targetHour = parseInt(env.TARGET_ET_HOUR || '9', 10);
    const targetDow  = parseInt(env.TARGET_ET_DOW  || '1', 10);
    const log = m => console.log(m);
    log(`[scheduled] cron=${event.cron} etDow=${dow} etHour=${hour} target=${targetDow}/${targetHour}`);
    if (dow !== targetDow || hour !== targetHour) {
      log(`[scheduled] guard failed, skipping`);
      return;
    }
    ctx.waitUntil((async () => {
      try {
        const result = await runWeekly(env, { log });
        log(`[scheduled] done: ${JSON.stringify(result)}`);
      } catch (err) {
        log(`[scheduled] FATAL: ${err.stack || err.message}`);
        try { await sendFailureAlert(env, err); log('failure alert sent'); }
        catch (e) { log(`failure alert send error: ${e.message}`); }
      }
    })());
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const secret = url.searchParams.get('secret');
    if (!env.MANUAL_TRIGGER_SECRET || secret !== env.MANUAL_TRIGGER_SECRET) {
      return new Response('forbidden', { status: 403 });
    }
    const chunks = [];
    const log = m => { console.log(m); chunks.push(m); };
    const isPreview = url.searchParams.get('preview') === '1';
    const isTest    = url.searchParams.get('test') === '1';
    const isSend    = url.searchParams.get('send') === '1';
    const skipFreshness = url.searchParams.get('skip-freshness') === '1';
    const skipSend = isPreview && !isTest && !isSend;
    try {
      const result = await runWeekly(env, { isTest, skipFreshness, skipSend, log });
      if (skipSend && result.html) {
        return new Response(result.html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
      }
      return new Response(JSON.stringify({ ok: true, ...result, log: chunks }, null, 2), {
        headers: { 'content-type': 'application/json' },
      });
    } catch (err) {
      return new Response(JSON.stringify({ ok: false, error: err.message, stack: err.stack, log: chunks }, null, 2), {
        status: 500, headers: { 'content-type': 'application/json' },
      });
    }
  },
};
