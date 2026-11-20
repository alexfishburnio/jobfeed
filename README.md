# Jobfeed — PM-role aggregator

Fetches PM postings from 91 target companies (Greenhouse / Lever / Ashby),
scores them, and emails Alex a **single weekly digest** every Monday 09:00 ET.

## Architecture

- `src/fetcher.js` — ATS API probes (Greenhouse / Lever / Ashby)
- `src/parser.js` — normalizes raw postings, detects level / mode / salary
- `src/scorer.js` — fit, realism, priority; filters (PM gate, location, salary floor)
- `src/differ.js` — compares against `data/state.json` → active / closed_today / closed
- `src/dedupe.js` — collapses (company, normalized title) pairs for display
- `src/exporter.js` — builds `public/feed.json` (page consumes this)
- `src/health.js` — per-company slug-health tracking → `data/health.json`
- `src/emailer.js` — HTML primitives, Resend send
- `src/daily.js` — daily orchestrator: fetch → parse → score → diff → snapshot. **No email.**
- `src/weekly.js` — Monday digest: reads last 7 snapshots, builds the one email.

## Data model

- `data/YYYY-MM-DD.json` — per-day snapshot (all currently-tracked postings).
- `data/state.json` — diff state; posting ID → first_seen_date, status, closed_date.
- `data/health.json` — per-company fetch history (14-day rolling).
- `data/archive/YYYY-MM.tar.gz` — monthly archives of snapshots older than 60 days.
- `public/feed.json` — last 30 days, deduped, grouped by first_seen_date (page consumes).

## Cron (VPS: 157.230.237.104)

```
# Daily fetch — silent — target 06:00 America/New_York.
# Cron fires 10, 11, 12 UTC to span EST→EDT; wrapper guards ET hour and runs once per day.
0 10 * * * /root/jobfeed/scripts/daily-run.sh >> /var/log/jobfeed-daily.log 2>&1
0 11 * * * /root/jobfeed/scripts/daily-run.sh >> /var/log/jobfeed-daily.log 2>&1
0 12 * * * /root/jobfeed/scripts/daily-run.sh >> /var/log/jobfeed-daily.log 2>&1

# Weekly digest — ONE email per week — target Monday 09:00 America/New_York.
0 13 * * 1 /root/jobfeed/scripts/weekly-run.sh >> /var/log/jobfeed-weekly.log 2>&1
0 14 * * 1 /root/jobfeed/scripts/weekly-run.sh >> /var/log/jobfeed-weekly.log 2>&1
0 15 * * 1 /root/jobfeed/scripts/weekly-run.sh >> /var/log/jobfeed-weekly.log 2>&1
```

Only the weekly job sends email. The daily job is silent — any failures surface
in the next weekly digest's Infrastructure section.

If the weekly job itself crashes, one failure alert is sent via Resend with
subject `WEEKLY DIGEST FAILED {date}`. This is the only exception to the
one-email-per-week rule.

## Running manually

```
node --env-file=.env src/daily.js              # fetch + snapshot, no email
node --env-file=.env src/weekly.js --dry-run   # build preview → public/weekly-preview.html
node --env-file=.env src/weekly.js --test      # send a TEST-labeled weekly digest
node --env-file=.env src/weekly.js             # send real weekly digest
```

## Debugging

    ssh root@157.230.237.104
    crontab -l                                 # confirm schedule
    tail -200 /var/log/jobfeed-daily.log       # daily runs
    tail -200 /var/log/jobfeed-weekly.log      # weekly sends
    ls /var/lib/jobfeed/                       # per-day lock files
    /root/jobfeed/scripts/daily-run.sh         # force a daily run (ignores ET-hour guard only if hour matches)
