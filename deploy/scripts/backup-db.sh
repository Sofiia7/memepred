#!/usr/bin/env bash
# Hourly Postgres backup. Add to crontab:
#   17 * * * * /home/openclaw/memepred/deploy/scripts/backup-db.sh >> /home/openclaw/backups/memepred-db.log 2>&1
#
# This existed but was never scheduled — the only cron on the production host
# backed up a different project sharing the box, so the orders/matches history
# had no copy at all. Verify with `ls -lh "$BACKUP_DIR"` after the first hour.
set -euo pipefail

# Default under $HOME rather than /var/backups: the stack runs as an unprivileged
# user, and the old default silently failed with "Permission denied".
BACKUP_DIR="${BACKUP_DIR:-$HOME/backups/flipthememe}"
KEEP_HOURS=720          # ~30 days
TS=$(date -u +%Y%m%d-%H%M%S)

mkdir -p "$BACKUP_DIR"

cd "$(dirname "$0")/.."
# NOTE: -U/db name default to the actual Postgres user/db (still "memepred",
# matching deploy/docker-compose.yml) — not the product's public brand name.
#
# Written to a .part file and moved into place only on success, so a dump that
# dies halfway (disk full, container restart) can never be mistaken for a good
# backup by the pruner or by whoever is restoring at 3am.
docker compose exec -T postgres pg_dump -U "${POSTGRES_USER:-memepred}" "${POSTGRES_DB:-memepred}" \
  | gzip > "$BACKUP_DIR/flipthememe-$TS.sql.gz.part"
mv "$BACKUP_DIR/flipthememe-$TS.sql.gz.part" "$BACKUP_DIR/flipthememe-$TS.sql.gz"

# Prune older than KEEP_HOURS. `memepred-*` is the pre-rebrand filename: hosts
# deployed before the rename still have those, and pruning only the new prefix
# would leave them accumulating forever.
find "$BACKUP_DIR" -type f \( -name 'flipthememe-*.sql.gz' -o -name 'memepred-*.sql.gz' \) \
  -mmin +$((KEEP_HOURS * 60)) -delete
find "$BACKUP_DIR" -type f -name '*.sql.gz.part' -mmin +180 -delete

echo "backup ok: $BACKUP_DIR/flipthememe-$TS.sql.gz ($(du -h "$BACKUP_DIR/flipthememe-$TS.sql.gz" | cut -f1))"

# Restore note: the DB is TimescaleDB, and pg_dump warns about circular FKs on
# its internal `continuous_agg` catalog. Restore with
#   psql -U memepred -d memepred --set ON_ERROR_STOP=off < dump.sql
# or add --disable-triggers; a plain restore can fail on that catalog alone.
