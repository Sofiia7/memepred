#!/usr/bin/env bash
# Hourly Postgres backup. Add to crontab:
#   0 * * * * /home/USER/memepred/deploy/scripts/backup-db.sh
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/var/backups/memepred}"
KEEP_HOURS=720          # ~30 days
TS=$(date -u +%Y%m%d-%H%M%S)

mkdir -p "$BACKUP_DIR"

cd "$(dirname "$0")/.."
docker compose exec -T postgres pg_dump -U "${POSTGRES_USER:-memepred}" "${POSTGRES_DB:-memepred}" \
  | gzip > "$BACKUP_DIR/memepred-$TS.sql.gz"

# Prune older than KEEP_HOURS
find "$BACKUP_DIR" -type f -name 'memepred-*.sql.gz' -mmin +$((KEEP_HOURS * 60)) -delete

echo "backup ok: $BACKUP_DIR/memepred-$TS.sql.gz"
