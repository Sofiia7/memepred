#!/usr/bin/env bash
# Hourly Postgres backup. Add to crontab:
#   0 * * * * /home/USER/memepred/deploy/scripts/backup-db.sh
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/var/backups/flipthememe}"
KEEP_HOURS=720          # ~30 days
TS=$(date -u +%Y%m%d-%H%M%S)

mkdir -p "$BACKUP_DIR"

cd "$(dirname "$0")/.."
# NOTE: -U/db name default to the actual Postgres user/db (still "memepred",
# matching deploy/docker-compose.yml) — not the product's public brand name.
docker compose exec -T postgres pg_dump -U "${POSTGRES_USER:-memepred}" "${POSTGRES_DB:-memepred}" \
  | gzip > "$BACKUP_DIR/flipthememe-$TS.sql.gz"

# Prune older than KEEP_HOURS
find "$BACKUP_DIR" -type f -name 'flipthememe-*.sql.gz' -mmin +$((KEEP_HOURS * 60)) -delete

echo "backup ok: $BACKUP_DIR/flipthememe-$TS.sql.gz"
