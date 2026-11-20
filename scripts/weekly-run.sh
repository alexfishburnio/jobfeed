#!/bin/bash
# Weekly digest send — the ONE email per week. Target: Monday 09:00 ET.
#
# Cron fires at 13, 14, 15 UTC on Mondays to span EST→EDT transitions. The
# ET-hour guard ensures the actual send only happens when ET hour == 9,
# and the lock file ensures only one send per ET-Monday.
#
# Called from crontab -r /root. Logs to /var/log/jobfeed-weekly.log.

set -eu
cd /root/jobfeed

ET_HOUR=$(TZ=America/New_York date +'%H')
ET_DOW=$(TZ=America/New_York date +'%u')   # 1=Monday
ET_DATE=$(TZ=America/New_York date +'%Y-%m-%d')
LOCK_DIR=/var/lib/jobfeed
LOCK_FILE="$LOCK_DIR/weekly-run.$ET_DATE.lock"

# Only fire 09:00 ET Mondays.
if [ "$ET_DOW" != "1" ] || [ "$ET_HOUR" != "09" ]; then
  exit 0
fi

mkdir -p "$LOCK_DIR"

if [ -f "$LOCK_FILE" ]; then
  echo "[$(date -u +'%F %T') UTC] weekly already sent for ET=$ET_DATE, skipping"
  exit 0
fi
touch "$LOCK_FILE"

# Reap old locks.
find "$LOCK_DIR" -name 'weekly-run.*.lock' -mtime +60 -delete 2>/dev/null || true

echo "[$(date -u +'%F %T') UTC] weekly digest start (ET=$ET_DATE)"

git pull --rebase origin main

node --env-file=.env src/weekly.js

echo "[$(date -u +'%F %T') UTC] weekly digest complete"
