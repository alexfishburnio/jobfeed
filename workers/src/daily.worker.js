// Cloudflare Worker: daily jobfeed fetch.
//
// Scheduled trigger: fires on the cron(s) in wrangler.daily.toml. The
// handler guards on current ET hour so DST doesn't drift the run time.
//
// The fetch handler is a manual-trigger endpoint, gated on a secret in
// env.MANUAL_TRIGGER_SECRET. Useful for first-deploy testing and ad-hoc
// re-runs without waiting for cron.

import { runDaily } from './daily.js';

function etHour() {
  // 0-23 in America/New_York, current moment.
  return new Intl.DateTimeFormat('en-US', { hour: '2-digit', hour12: false, timeZone: 'America/New_York' })
    .format(new Date());
}

export default {
  async scheduled(event, env, ctx) {
    const hour = parseInt(etHour(), 10);
    const targetHour = parseInt(env.TARGET_ET_HOUR || '6', 10);
    const log = m => console.log(m);
    log(`[scheduled] cron=${event.cron} etHour=${hour} target=${targetHour}`);
    if (hour !== targetHour) {
      log(`[scheduled] ET-hour ${hour} != ${targetHour}, skipping (DST guard)`);
      return;
    }
    // Run inside waitUntil so we don't hold the request open; scheduled
    // has its own wall-clock budget (15 min on paid).
    ctx.waitUntil((async () => {
      try {
        const result = await runDaily(env, { log });
        log(`[scheduled] done: ${JSON.stringify(result)}`);
      } catch (err) {
        log(`[scheduled] FATAL: ${err.stack || err.message}`);
      }
    })());
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const secret = url.searchParams.get('secret');
    if (!env.MANUAL_TRIGGER_SECRET || secret !== env.MANUAL_TRIGGER_SECRET) {
      return new Response('forbidden', { status: 403 });
    }
    const limit = url.searchParams.has('limit') ? parseInt(url.searchParams.get('limit'), 10) : undefined;
    const chunks = [];
    const log = m => { console.log(m); chunks.push(m); };
    try {
      const result = await runDaily(env, { log, limit });
      return new Response(JSON.stringify({ ok: true, result, log: chunks }, null, 2), {
        headers: { 'content-type': 'application/json' },
      });
    } catch (err) {
      return new Response(JSON.stringify({ ok: false, error: err.message, stack: err.stack, log: chunks }, null, 2), {
        status: 500, headers: { 'content-type': 'application/json' },
      });
    }
  },
};
