#!/bin/bash
# Daily data fetch — silent (no email). Target: 06:00 America/New_York.
#
# Cron fires three times (10, 11, 12 UTC) to span EST→EDT transitions. The
# ET-hour guard inside this script ensures the job only runs when local ET
# hour == 6, and the lock file ensures only one actual run per ET day.
#
# Called from crontab -r /root. Logs to /var/log/jobfeed-daily.log.

set -eu
cd /root/jobfeed

ET_HOUR=$(TZ=America/New_York date +'%H')
ET_DATE=$(TZ=America/New_York date +'%Y-%m-%d')
LOCK_DIR=/var/lib/jobfeed
LOCK_FILE="$LOCK_DIR/daily-run.$ET_DATE.lock"

# Only fire when it's 06:00 ET.
if [ "$ET_HOUR" != "06" ]; then
  exit 0
fi

mkdir -p "$LOCK_DIR"

# One run per ET day — second fire is a no-op.
if [ -f "$LOCK_FILE" ]; then
  echo "[$(date -u +'%F %T') UTC] daily already ran for ET=$ET_DATE, skipping"
  exit 0
fi
touch "$LOCK_FILE"

# Reap locks older than 14 days so the dir doesn't grow forever.
find "$LOCK_DIR" -name 'daily-run.*.lock' -mtime +14 -delete 2>/dev/null || true

echo "[$(date -u +'%F %T') UTC] daily run start (ET=$ET_DATE)"

git pull --rebase origin main

node --env-file=.env src/daily.js

git add data/ public/feed.json
if git diff --cached --quiet; then
  echo "no changes to commit"
else
  git commit -m "feed: $ET_DATE (daily)"
  git push origin main
fi

echo "[$(date -u +'%F %T') UTC] daily run complete"
