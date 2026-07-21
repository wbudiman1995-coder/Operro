#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# POSITIVE backfill harness (Operro 0013, correction pass 3).
# Proves SECTION 300 preserves every legacy singular-column grooming booking
# into the new grooming_job_pets / grooming_job_pet_services model, and that
# SECTION 320 then drops the legacy columns.
#
#   Usage: DATABASE_URL=postgres://...  MIGRATION=/path/to/0013.sql \
#          ./run_backfill_positive.sh
#
# Assumes the target DB already has migrations 0001..0012 applied and does NOT
# yet have 0013. Exits 0 only if 0013 applies AND every positive assertion holds.
# ---------------------------------------------------------------------------
set -uo pipefail
: "${DATABASE_URL:?set DATABASE_URL}"
DIR="$(cd "$(dirname "$0")" && pwd)"
MIGRATION="${MIGRATION:-$DIR/../0013_core_neutrality_grooming_lines.sql}"

echo "== [positive] seed legacy grooming bookings (pre-0013 shape) =="
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$DIR/positive_seed.sql"

echo "== [positive] apply 0013 (must succeed and backfill) =="
if ! psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$MIGRATION"; then
  echo "POSITIVE FAIL: 0013 did not apply cleanly on valid legacy data."
  exit 1
fi

echo "== [positive] assert legacy data preserved + columns dropped =="
if psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$DIR/positive_assert.sql"; then
  echo "POSITIVE PASS: all legacy grooming values migrated; columns dropped."
  exit 0
else
  echo "POSITIVE FAIL: one or more backfill assertions failed."
  exit 1
fi
