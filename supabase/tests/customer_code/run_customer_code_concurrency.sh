#!/usr/bin/env bash
set -uo pipefail
: "${DATABASE_URL:?set DATABASE_URL}"
DIR="$(cd "$(dirname "$0")" && pwd)"
OUT="$(mktemp -d "${TMPDIR:-/tmp}/operro-customer-code.XXXXXX")"
trap 'rm -rf "$OUT"' EXIT
fail(){ echo "CUSTOMER CODE CONCURRENCY FAIL: $*" >&2; exit 1; }

psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f "$DIR/concurrency_seed.sql" >/dev/null || fail "seed"

( psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f "$DIR/sessionA_same_org.sql" >"$OUT/A.out" 2>&1; echo $? >"$OUT/A.rc" ) &
apid=$!
sleep 1
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f "$DIR/sessionB_same_org.sql" >"$OUT/B.out" 2>&1
brc=$?
wait "$apid"
arc=$(cat "$OUT/A.rc")
[ "$arc" = 0 ] || { cat "$OUT/A.out"; fail "same-org session A rc=$arc"; }
[ "$brc" = 0 ] || { cat "$OUT/B.out"; fail "same-org session B rc=$brc"; }
grep -q 'PASS: same-org' "$OUT/B.out" || { cat "$OUT/B.out"; fail "same-org assertion missing"; }
codes=$(psql "$DATABASE_URL" -X -tAc "select string_agg(customer_code,',' order by customer_code) from public.customers where organization_id='0c400000-0000-4000-8000-000000000001'")
[ "$codes" = 'CUST-001,CUST-002' ] || fail "same-org codes=$codes"

( psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f "$DIR/sessionA_diff_org.sql" >"$OUT/C.out" 2>&1; echo $? >"$OUT/C.rc" ) &
cpid=$!
sleep 1
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f "$DIR/sessionB_diff_org.sql" >"$OUT/D.out" 2>&1
drc=$?
wait "$cpid"
crc=$(cat "$OUT/C.rc")
[ "$crc" = 0 ] || { cat "$OUT/C.out"; fail "different-org session C rc=$crc"; }
[ "$drc" = 0 ] || { cat "$OUT/D.out"; fail "different-org session D rc=$drc"; }
grep -q 'PASS: different-org' "$OUT/D.out" || { cat "$OUT/D.out"; fail "different-org assertion missing"; }
code_c=$(psql "$DATABASE_URL" -X -tAc "select customer_code from public.customers where organization_id='0c400000-0000-4000-8000-000000000002'")
code_d=$(psql "$DATABASE_URL" -X -tAc "select customer_code from public.customers where organization_id='0c400000-0000-4000-8000-000000000003'")
[ "$code_c" = 'CUST-001' ] || fail "org C code=$code_c"
[ "$code_d" = 'CUST-001' ] || fail "org D code=$code_d"

echo 'CUSTOMER CODE CONCURRENCY PASS'
