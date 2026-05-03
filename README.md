# Job Feed Aggregator — Phase 0 Audit

Probes target companies against Greenhouse, Lever, and Ashby public ATS APIs to determine which are addressable before committing to the full build.

## Run

    npm run audit
    # or: node audit.js

Reads `companies.json`. Sequential, 1.5s delay between requests. ~190 companies → expect ~10–25 minutes depending on how many fall through to Ashby.

`audit-report.csv` is written incrementally — re-running resumes from where it stopped. Delete the CSV to start fresh.

## Outputs

- `audit-report.csv` — `name, tier, ats_detected, slug_used, job_count, status, notes`. UTF-8 with BOM (Excel/Numbers-friendly).
- `audit-summary.md` — counts by ATS / tier × status, top 10 by openings, list of companies needing manual investigation, flags.

## Probe order

1. Greenhouse — `https://boards-api.greenhouse.io/v1/boards/{slug}/jobs`
2. Lever — `https://api.lever.co/v0/postings/{slug}?mode=json`
3. Ashby — `https://api.ashbyhq.com/posting-api/job-board/{slug}?includeCompensation=true`

Each ATS is tried with up to four slug variants (deduped):

1. `slug_hint` from `companies.json` if provided
2. lowercase, non-alphanumeric stripped (`The Trade Desk` → `thetradedesk`)
3. lowercase, hyphenated (`The Trade Desk` → `the-trade-desk`)
4. lowercase, articles dropped, concatenated (`The Trade Desk` → `tradedesk`)

On 429, back off 30s and retry once. On any other non-200, fall through to the next variant / ATS. After all variants × all ATSes fail, the company is recorded as `unknown`.

## Requirements

Node 18+ (uses built-in `fetch`). No npm dependencies.

## Operations — daily run

The daily feed pipeline runs on a VPS (`157.230.237.104`) via Linux cron, not GitHub Actions. GitHub Actions scheduled runs were unreliable (4–7 hour delays); Linux cron fires within seconds of schedule.

### Schedule

    0 23 * * * /root/jobfeed/run-daily.sh >> /var/log/jobfeed.log 2>&1

`23:00 UTC` = 19:00 EDT during DST (March–November). When DST ends, change to `0 0 * * *` (00:00 UTC = 19:00 EST).

### Pipeline

`/root/jobfeed/run-daily.sh` does:

1. `git pull --rebase origin main`
2. `node --env-file=.env src/index.js` (fetches → parses → scores → diffs → emails → writes data/state.json + public/feed.json)
3. `git add data/ public/feed.json && git commit -m "feed: $(date -u +%Y-%m-%d) (vps)" && git push origin main` (only if there are changes)

The VPS authenticates to GitHub via a deploy key (`/root/.ssh/id_jobfeed`) registered as a write-enabled deploy key on the repo. Commits are authored by `Jobfeed VPS <vps@alexfishburn.io>`.

### GitHub Actions state

- `daily.yml` and `daily-fallback.yml` are **disabled** (not deleted) — VPS replaces them. To revert, `gh workflow enable daily.yml`.
- `canary.yml` remains **enabled** — runs at 00:30 UTC daily, alerts via Resend if no `feed: …` commit landed within 30 hours. Works with both legacy and `(vps)`-suffix commit messages (matches `^feed:`).

### Monitoring

- VPS-side: `/root/jobfeed-monitor.sh` runs at 02:00 UTC daily. Checks `/var/log/jobfeed.log` for today's run; sends a Resend alert if missed.
- GitHub-side: `canary.yml` (above) — independent backup alert.

### Debugging

    ssh root@157.230.237.104
    tail -200 /var/log/jobfeed.log     # see recent runs
    crontab -l                          # confirm cron is scheduled
    /root/jobfeed/run-daily.sh          # manual run
