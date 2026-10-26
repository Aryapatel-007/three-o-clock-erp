#!/usr/bin/env bash
# Takes an exact copy of the cloud database for a cafe PC. P62, docs/WINDOWS-INSTALL.md section 5b.
#
#   SOURCE_MONGO_URI='mongodb+srv://USER:PASSWORD@cluster.mongodb.net/restaurant-erp' bash box/export-cloud.sh
#
# READS ONLY: mongodump never writes to the database it copies. Every order, bill,
# guest, closed day, setting and login comes across with its own id, so the PC
# carries on the same invoice series. Left out: the cloud's sign-in sessions
# (everyone signs in again on the PC) and the cloud's own backup bookkeeping.
#
# Writes release/cafe-data-<date>.archive.gz. It holds password and PIN hashes and
# guests' phone numbers: move it by pen drive, and delete it once loaded.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
: "${SOURCE_MONGO_URI:?Set SOURCE_MONGO_URI to the cloud database address (never typed on the command line itself).}"
command -v mongodump >/dev/null || { echo "mongodump is missing: install the MongoDB Database Tools."; exit 1; }

DB="$(printf '%s' "$SOURCE_MONGO_URI" | sed -E 's#^mongodb(\+srv)?://[^/]*/?##; s#\?.*$##')"
DB="${DB:-restaurant-erp}"
mkdir -p "$ROOT/release"
OUT="$ROOT/release/cafe-data-$(date +%Y%m%d-%H%M).archive.gz"

echo "Reading database $DB (read only)..."
mongodump --uri="$SOURCE_MONGO_URI" --db="$DB" \
  --excludeCollection=refreshtokens --excludeCollection=backupruns --excludeCollection=backupstate \
  --gzip --archive="$OUT" 2>&1 | grep -E "done dumping|error|Failed" | sed -E 's/^[^\t]*\t//'
chmod 600 "$OUT"
echo "Wrote $OUT ($(du -h "$OUT" | cut -f1))."
echo "Bills made on the cloud after this moment are not in it: stop billing there before the cafe PC starts."
