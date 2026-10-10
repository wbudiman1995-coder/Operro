#!/usr/bin/env bash
# Two real database sessions race to start a cleanup run for one organization.
# Requires a disposable, fully migrated database (the seed commits rows):  DATABASE_URL=postgresql://... bash run_storage_cleanup_concurrency.sh
set -uo pipefail
: "${DATABASE_URL:?set DATABASE_URL}"
DIR="$(cd "$(dirname "$0")" && pwd)"
OUT="$(mktemp -d "${TMPDIR:-/tmp}/operro-storage-cleanup.XXXXXX")"
trap 'rm -rf "$OUT"' EXIT
fail(){ echo "STORAGE CLEANUP CONCURRENCY FAIL: $*" >&2; exit 1; }

psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -q -f "$DIR/seed.sql" >/dev/null || fail "seed"

( psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f "$DIR/sessionA.sql" >"$OUT/A.out" 2>&1; echo $? >"$OUT/A.rc" ) &
apid=$!
sleep 1
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f "$DIR/sessionB.sql" >"$OUT/B.out" 2>&1
brc=$?
wait "$apid"
arc=$(cat "$OUT/A.rc")
[ "$arc" = 0 ] || { cat "$OUT/A.out"; fail "session A rc=$arc"; }
[ "$brc" = 0 ] || { cat "$OUT/B.out"; fail "session B rc=$brc"; }
grep -q 'PASS: second concurrent apply waited' "$OUT/B.out" || { cat "$OUT/B.out"; fail "session B assertion missing"; }

running=$(psql "$DATABASE_URL" -X -tAc "select count(*) from public.storage_cleanup_runs where organization_id='c8f00000-0000-4000-8000-000000000001' and mode='apply' and status='running'")
[ "$running" = 1 ] || fail "expected exactly one running apply run, found $running"
marked=$(psql "$DATABASE_URL" -X -tAc "select count(*) from public.storage_cleanup_items where organization_id='c8f00000-0000-4000-8000-000000000001' and state='marked'")
[ "$marked" = 2 ] || fail "expected 2 marked items (each object tombstoned once), found $marked"
tomb=$(psql "$DATABASE_URL" -X -tAc "select count(*) from public.attachments where organization_id='c8f00000-0000-4000-8000-000000000001' and deleted_at is not null")
[ "$tomb" = 2 ] || fail "expected 2 tombstoned attachments, found $tomb"

echo 'STORAGE CLEANUP CONCURRENCY PASS'
