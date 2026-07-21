#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# NEGATIVE backfill harness (Operro 0013, correction pass 3).
# Proves the atomicity guarantee: when SECTION 310's BACKFILL ABORT fires on
# un-migratable data, the WHOLE migration transaction rolls back and the
# pre-0013 database is left EXACTLY intact.
#
#   Usage: DATABASE_URL=postgres://...  MIGRATION=/path/to/0013.sql \
#          ./run_backfill_negative.sh
#
# Steps:
#   1. seed poison data (a non-grooming booking carrying legacy pet_id/service_id);
#   2. apply 0013 and REQUIRE it to fail (nonzero psql exit under ON_ERROR_STOP);
#   3. on a BRAND-NEW connection, prove nothing from 0013 committed and all
#      pre-0013 schema, data, triggers, and functions remain intact.
#
# Exits 0 only if the migration failed AS EXPECTED *and* every integrity
# assertion on the fresh connection passes.
# ---------------------------------------------------------------------------
set -uo pipefail
: "${DATABASE_URL:?set DATABASE_URL}"
DIR="$(cd "$(dirname "$0")" && pwd)"
MIGRATION="${MIGRATION:-$DIR/../0013_core_neutrality_grooming_lines.sql}"

echo "== [negative] seed poison data (non-grooming booking with legacy pet/service) =="
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$DIR/negative_seed.sql"

echo "== [negative] apply 0013 (MUST fail with BACKFILL ABORT) =="
# Capture output; expect a nonzero exit AND the specific abort message.
APPLY_LOG="$(mktemp "${TMPDIR:-/tmp}/neg_apply.XXXXXX")"
if psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$MIGRATION" > "$APPLY_LOG" 2>&1; then
  echo "NEGATIVE FAIL: 0013 unexpectedly SUCCEEDED on poison data — abort did not fire."
  echo "---- migration output ----"; cat "$APPLY_LOG"; rm -f "$APPLY_LOG"
  exit 1
fi
APPLY_RC_OK=1
echo "0013 exited nonzero as required. Abort message:"
grep -i "BACKFILL ABORT" "$APPLY_LOG" || {
  echo "NEGATIVE FAIL: 0013 failed but NOT via the SECTION 310 BACKFILL ABORT."
  echo "---- migration output ----"; cat "$APPLY_LOG"; rm -f "$APPLY_LOG"
  exit 1
}
# psql should also have reported that COMMIT could not proceed (tx aborted) OR
# stopped at the raise; either way the tx never committed. Show context.
echo "---- tail of migration output ----"; tail -8 "$APPLY_LOG"
rm -f "$APPLY_LOG"

echo "== [negative] FRESH connection: prove pre-0013 schema/data/functions intact =="
# A new psql invocation = a new backend connection/session. If 0013 had leaked
# any partially-committed object, these assertions would catch it.
if psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$DIR/negative_assert.sql"; then
  echo "NEGATIVE PASS: abort fired, whole migration rolled back, DB fully intact."
  exit 0
else
  echo "NEGATIVE FAIL: post-abort integrity check found leaked/partial 0013 state."
  exit 1
fi
