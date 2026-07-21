#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# STRICT T11 concurrency harness (Operro 0013, FINAL PASS item 5).
# Two psql sessions, both as the AUTHENTICATED role, race for the SAME
# customer_package that has EXACTLY ONE session.
#
#   Usage: DATABASE_URL=postgres://... ./run_concurrency.sh
#
# STRICT contract (all must hold, else exit 1):
#   * Session A runs as authenticated and exits 0 (reserves the one session).
#   * Session B runs as authenticated and exits NONZERO (a real failing process,
#     not a 0-exit psql whose output merely contains an error).
#   * Session B output contains EXACTLY ONE expected error: no_sessions_available
#   * Session B output contains NO OTHER "ERROR" lines.
#   * Final active ('reserved') reservation count on the package = exactly 1.
#   * No duplicate reservation / package-ledger effect exists.
#
# Uses `set -euo pipefail`; immediate-exit is temporarily disabled ONLY while
# capturing session B's expected failure, then restored. A_RC and B_RC are both
# checked explicitly.
# ---------------------------------------------------------------------------
set -euo pipefail
: "${DATABASE_URL:?set DATABASE_URL}"
DIR="$(cd "$(dirname "$0")" && pwd)"
PKG='0c000000-0000-4000-8000-0000000ca001'

# Writable scratch (script dir may be read-only for the OS user running psql).
OUT="$(mktemp -d "${TMPDIR:-/tmp}/t11.XXXXXX")"
trap 'rm -rf "$OUT"' EXIT

fail() { echo "T11 FAIL: $*" >&2; exit 1; }

echo "== setup =="
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$DIR/setup.sql"

echo "== launch session A (holds lock ~3s, as authenticated) =="
# A runs in the background; capture its rc via a temp file (pipefail + wait).
( psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$DIR/sessionA.sql" > "$OUT/A.out" 2>&1; echo $? > "$OUT/A.rc" ) &
A_BG=$!

sleep 1   # ensure A has taken the customer_packages row lock before B starts

echo "== launch session B (must block then FAIL nonzero, as authenticated) =="
# Temporarily disable -e so B's expected nonzero exit doesn't kill the harness.
set +e
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$DIR/sessionB.sql" > "$OUT/B.out" 2>&1
B_RC=$?
set -e

wait "$A_BG" || true
A_RC="$(cat "$OUT/A.rc" 2>/dev/null || echo 99)"

echo "== session A output =="; cat "$OUT/A.out"
echo "== session B output =="; cat "$OUT/B.out"

echo "== assertions =="
echo "A_RC=$A_RC  B_RC=$B_RC"

# 1. Session A must have SUCCEEDED.
[ "$A_RC" -eq 0 ] || fail "session A did not exit 0 (A_RC=$A_RC)."

# 2. Session B must have FAILED (nonzero) — a real failing process.
[ "$B_RC" -ne 0 ] || fail "session B exited 0 but was required to fail."

# 3. Session B output must contain EXACTLY ONE expected error line.
EXPECTED_COUNT="$(grep -c 'no_sessions_available' "$OUT/B.out" || true)"
[ "$EXPECTED_COUNT" -eq 1 ] \
  || fail "expected exactly 1 'no_sessions_available' in B (got $EXPECTED_COUNT)."

# 4. Session B output must contain NO OTHER ERROR lines. Count total psql ERROR
#    lines; the single expected failure surfaces as one 'ERROR:' line that also
#    contains no_sessions_available, so total ERROR lines must be exactly 1.
TOTAL_ERR="$(grep -c 'ERROR' "$OUT/B.out" || true)"
[ "$TOTAL_ERR" -eq 1 ] \
  || fail "session B has $TOTAL_ERR ERROR lines; exactly 1 (the expected one) allowed."
# And that single ERROR line must be the expected one.
grep 'ERROR' "$OUT/B.out" | grep -q 'no_sessions_available' \
  || fail "session B's ERROR line is not the expected no_sessions_available."

# 5. Exactly one ACTIVE reservation on the package (no oversubscription).
RES_COUNT="$(psql "$DATABASE_URL" -tAc \
  "select count(*) from public.package_reservations where customer_package_id='$PKG' and status='reserved';" \
  | tr -d '[:space:]')"
[ "$RES_COUNT" = "1" ] || fail "expected exactly 1 reserved row, found $RES_COUNT."

# 6. No duplicate effect: at most one reservation row total for lineA, and no
#    consumption ledger row yet (reservation only, not consumed).
LINEA_ROWS="$(psql "$DATABASE_URL" -tAc \
  "select count(*) from public.package_reservations where grooming_job_pet_service_id='0c000000-0000-4000-8000-0000000f1001';" \
  | tr -d '[:space:]')"
[ "$LINEA_ROWS" = "1" ] || fail "expected exactly 1 lifecycle row for lineA, found $LINEA_ROWS."
LEDGER_DUP="$(psql "$DATABASE_URL" -tAc \
  "select count(*) from public.customer_package_ledger where customer_package_id='$PKG' and reason='consumption';" \
  | tr -d '[:space:]')"
[ "$LEDGER_DUP" = "0" ] || fail "unexpected consumption ledger rows: $LEDGER_DUP (reservation must not consume)."

echo "T11 PASS: A exited 0; B failed nonzero with exactly one no_sessions_available;"
echo "          no other ERROR lines; exactly 1 reservation; no duplicate effects."
exit 0
