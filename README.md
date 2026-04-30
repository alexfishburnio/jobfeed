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
