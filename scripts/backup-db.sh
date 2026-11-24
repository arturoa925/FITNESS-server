#!/usr/bin/env bash
# Creates a compressed, restorable backup of the app database and checks it can be read.
#
#   DATABASE_URL=postgres://user:pass@host:5432/db  ./scripts/backup-db.sh     # hosted (Render etc.)
#   DB_NAME=fitnessapp DB_USER=postgres ./scripts/backup-db.sh                # local (DB_HOST/DB_PORT/DB_PW optional)
#
# Output: backups/fitness-<UTC timestamp>.dump   (pg_dump custom format; restore with pg_restore)
# Needs the PostgreSQL client tools (pg_dump, pg_restore) of the same or newer major version
# as the server. NOTE: backups contain user data; keep them private (backups/ is git-ignored).
set -euo pipefail

OUT_DIR="${BACKUP_DIR:-backups}"
mkdir -p "$OUT_DIR"
FILE="$OUT_DIR/fitness-$(date -u +%Y%m%dT%H%M%SZ).dump"
# never leave a partial/unusable backup lying around
trap '[[ $? -ne 0 ]] && rm -f "$FILE"' EXIT

command -v pg_dump >/dev/null    || { echo "pg_dump not found. Install the PostgreSQL client tools." >&2; exit 1; }
command -v pg_restore >/dev/null || { echo "pg_restore not found. Install the PostgreSQL client tools." >&2; exit 1; }

if [[ -n "${DATABASE_URL:-}" ]]; then
  # Hosted databases require TLS; a URL that already says sslmode=... wins.
  export PGSSLMODE="${PGSSLMODE:-require}"
  pg_dump --format=custom --no-owner --no-privileges --file "$FILE" "$DATABASE_URL"
else
  : "${DB_NAME:?set DATABASE_URL, or DB_NAME (and DB_USER)}"
  [[ -n "${DB_PW:-}" ]] && export PGPASSWORD="$DB_PW"
  pg_dump --format=custom --no-owner --no-privileges \
    --host "${DB_HOST:-localhost}" --port "${DB_PORT:-5432}" --username "${DB_USER:-postgres}" \
    --file "$FILE" "$DB_NAME"
fi

# A backup you can't read is not a backup: list its contents as a sanity check.
TABLES=$(pg_restore --list "$FILE" | grep -c ' TABLE DATA ' || true)
if [[ "$TABLES" -lt 1 ]]; then
  echo "Backup written to $FILE but it contains no table data. Do NOT rely on it." >&2
  exit 1
fi
SIZE=$(wc -c < "$FILE" | tr -d ' ')
echo "OK: $FILE  (${SIZE} bytes, ${TABLES} tables with data)"
echo "Restore into an empty database with:  pg_restore --no-owner --dbname <url-or-name> $FILE"
