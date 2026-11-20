# jobfeed on Cloudflare Workers

Phase 3 target: run both jobfeed jobs (daily fetch, weekly digest) on Cloudflare
Workers Cron Triggers instead of the DigitalOcean VPS. State in KV, snapshots
+ feed.json in R2.

## Cost note — Workers Paid required

The daily fetch makes 91 subrequests to ATS APIs. Cloudflare Workers Free tier
allows only **50 subrequests per invocation**. The Paid plan ($5/mo) raises
this to 1000.

- **Weekly worker** fits on Free (≤40 subrequests).
- **Daily worker** needs **Paid**.

Alternatives if $5/mo isn't acceptable:
1. Keep the VPS ($4-6/mo on DO basic, roughly equivalent cost — the Phase 2.0
   setup is already stable).
2. Split daily fetch into 3 chunks × 31 companies, one cron trigger each.
   More moving parts; not implemented.

## One-time setup (user action)

1. Create a Cloudflare account (free, no credit card required for signup):
   <https://dash.cloudflare.com/sign-up>
2. In this directory:

   ```
   npx wrangler login
   ```

   This opens a browser window → authorize wrangler.
3. If you want the daily worker to run (requires Paid plan), subscribe at
   <https://dash.cloudflare.com/?to=/:account/workers/plans> ($5/mo). You can
   skip this and only deploy the weekly worker, then run the daily on the VPS
   or elsewhere.

## Create backing resources

```
# KV namespace (one ID used by both workers)
npx wrangler kv namespace create jobfeed_kv
# → copy the printed `id = "…"` into BOTH wrangler.daily.toml and wrangler.weekly.toml,
#   replacing REPLACE_WITH_KV_NAMESPACE_ID.

# R2 bucket (one bucket shared by both workers)
npx wrangler r2 bucket create jobfeed
```

## Seed KV + R2 from the current VPS state

Run from this directory. Replace the NAMESPACE_ID with the one printed above.

```
# KV — state and health
npx wrangler kv key put --namespace-id=NAMESPACE_ID --remote state  "$(cat seed/kv-state.json)"
npx wrangler kv key put --namespace-id=NAMESPACE_ID --remote health "$(cat seed/kv-health.json)"

# R2 — latest snapshot + feed.json (public-readable)
npx wrangler r2 object put jobfeed/snapshots/2026-11-20.json --file seed/r2-snapshots/2026-11-20.json --content-type application/json
npx wrangler r2 object put jobfeed/feed.json                 --file seed/r2-feed.json                 --content-type application/json
```

Then enable public read on the R2 bucket (one-time, dashboard action):

1. Open <https://dash.cloudflare.com> → R2 → `jobfeed` bucket → Settings → Public Access.
2. Enable "Allow Access" via the r2.dev development URL **or** attach a custom
   domain (e.g. `feed.alexfishburn.io`). The r2.dev URL is throttled and
   Cloudflare recommends custom domains for anything production.

The public URL after this step is either:
- `https://pub-<hash>.r2.dev/feed.json` (dev URL, Cloudflare picks the hash), OR
- `https://feed.alexfishburn.io/feed.json` (if custom domain attached — strongly recommended).

## Set secrets

Both workers need:

```
# Resend API key (not the same as reading from .env — it has to live as a secret)
npx wrangler secret put RESEND_API_KEY --config wrangler.daily.toml
npx wrangler secret put RESEND_API_KEY --config wrangler.weekly.toml

# From + To (not secret per se, but passed the same way)
npx wrangler secret put RESEND_FROM --config wrangler.weekly.toml
npx wrangler secret put RESEND_TO   --config wrangler.weekly.toml

# Manual-trigger secret — a random string you choose. Used to hit the Worker
# via HTTP for ad-hoc runs. Only the weekly worker needs the full one; daily's
# fetch handler also respects it for testing.
npx wrangler secret put MANUAL_TRIGGER_SECRET --config wrangler.daily.toml
npx wrangler secret put MANUAL_TRIGGER_SECRET --config wrangler.weekly.toml
```

Pull the Resend key/from/to from the existing VPS/local `.env`:

```
grep RESEND /Users/alexfishburn/Desktop/jobfeed/.env
```

## Deploy

```
npx wrangler deploy --config wrangler.daily.toml
npx wrangler deploy --config wrangler.weekly.toml
```

After deploy, Cloudflare shows the `*.workers.dev` URL for each. Keep these;
they're the manual-trigger endpoints.

## Verify

```
# Daily — manual trigger with limit=3 (fetches 3 companies, writes to KV/R2)
curl "https://jobfeed-daily.<account>.workers.dev/?secret=$SECRET&limit=3"

# Weekly — preview HTML (no send)
curl "https://jobfeed-weekly.<account>.workers.dev/?secret=$SECRET&preview=1" > /tmp/preview.html
open /tmp/preview.html

# Weekly — one real TEST send
curl "https://jobfeed-weekly.<account>.workers.dev/?secret=$SECRET&test=1"
```

Confirm in the Cloudflare dashboard:
- Workers & Pages → `jobfeed-daily` → Triggers → Cron Triggers: 3 schedules shown.
- Same for `jobfeed-weekly`.
- Logs: `wrangler tail --config wrangler.daily.toml` (and weekly).

## Flip the alexfishburn.io jobs page

The jobs page currently fetches feed.json from the GitHub raw URL. After the
R2 bucket is public, update the page's `FEED_URL` variable to the new URL.

Current (GitHub):
```
var FEED_URL = 'https://raw.githubusercontent.com/alexfishburnio/jobfeed/main/public/feed.json';
```

New (R2):
```
var FEED_URL = 'https://feed.alexfishburn.io/feed.json';
// or the r2.dev URL if no custom domain is attached.
```

The page lives in a separate repo (alexfishburnio). After editing, redeploy /
rebuild that site.

## Disable VPS crons

Once the Workers daily run has succeeded at least once (snapshot in R2, state
in KV), comment out the VPS crons:

```
ssh root@157.230.237.104 "crontab -l | sed 's|^0 \\(10\\|11\\|12\\|13\\|14\\|15\\) \\*.*/root/jobfeed/scripts/|# migrated-to-cloudflare 2026-11-20: &|' | crontab -"
```

Leaves the lines in the crontab as reference. Delete the VPS entirely only
after 7 days of stable Workers runs (user decision).

## Monitor

- `wrangler tail --config wrangler.daily.toml` — live logs
- Cloudflare dashboard → Workers & Pages → <worker> → Invocations graph
- Resend dashboard → sent emails list

## Rollback

If anything breaks before the VPS is destroyed:

```
# Re-enable VPS crons
ssh root@157.230.237.104 "crontab -l | sed 's/^# migrated-to-cloudflare 2026-11-20: //' | crontab -"

# Disable Workers crons (dashboard: Triggers → remove all, OR delete the
# Workers via `wrangler delete --config wrangler.daily.toml` etc.)
```
