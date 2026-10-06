#!/usr/bin/env bash
# Two-session concurrency proof for SB-05 against a disposable PostgreSQL 16
# server (any checkout location). Builds its own database, then for each case
# runs two real sessions as the `authenticated` role:
#   1. two saves with the same expected version        -> exactly one wins, the other gets stale_layout
#   2. save vs. assembly_add_line (both orders)       -> strictly serialized, never a torn price/layout
#   3. save vs. size-restricted package sale (both orders) -> strictly serialized
#   4. a third session polling the layout during a held save only ever sees old or new, never a mixture
# Blocking is proven causally (the second session's result is only possible after the first commits).
set -uo pipefail
cd "$(dirname "$0")/.."
export PGUSER=postgres
db=operro_sb_conc
OUT="$(mktemp -d "${TMPDIR:-/tmp}/sbconc.XXXXXX")"; trap 'rm -rf "$OUT"' EXIT
fail() { echo "CONC FAIL: $*" >&2; exit 1; }
q() { psql "$db" -v ON_ERROR_STOP=1 -qAt "$@"; }

dropdb --if-exists "$db"; createdb "$db"
psql "$db" -v ON_ERROR_STOP=1 -q <<'SQL'
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
create schema if not exists auth;
create table if not exists auth.users(id uuid primary key, email text, raw_user_meta_data jsonb);
create or replace function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'sub', '')::uuid $$;
create schema if not exists storage;
create table if not exists storage.buckets(id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
create table if not exists storage.objects(id uuid, bucket_id text, name text, metadata jsonb);
create or replace function storage.foldername(name text) returns text[] language sql immutable as $$ select string_to_array(name, '/') $$;
do $$ begin create role anon nologin noinherit; exception when duplicate_object then null; end $$;
do $$ begin create role service_role nologin noinherit; exception when duplicate_object then null; end $$;
do $$ begin create role supabase_auth_admin nologin noinherit; exception when duplicate_object then null; end $$;
do $$ begin create role authenticated nologin noinherit; exception when duplicate_object then null; end $$;
grant usage on schema auth to authenticated;
SQL
psql "$db" -v ON_ERROR_STOP=1 -q -f integration/gate_bootstrap_extensions.sql
for m in supabase/migrations/*.sql; do psql "$db" -v ON_ERROR_STOP=1 -q -f "$m" || fail "migration $m"; done

org() { echo "5f0${1}0000-0000-4000-8000-000000000001"; }
uid() { echo "5f0${1}0000-0000-4000-8000-000000000003"; }
job() { echo "5f0${1}0000-0000-4000-8000-00000000000b"; }
pkg() { echo "5f0${1}0000-0000-4000-8000-000000000009"; }
svc() { echo "5f0${1}0000-0000-4000-8000-000000000007"; }
pet() { echo "5f0${1}0000-0000-4000-8000-000000000008"; }
cust() { echo "5f0${1}0000-0000-4000-8000-000000000006"; }
seed() { psql "$db" -v ON_ERROR_STOP=1 -q -v idx="$1" -f integration/size_band_concurrency_seed.sql || fail "seed $1"; }
head_sql() { # authenticated owner of case $1
  echo "begin; set local role authenticated; select set_config('request.jwt.claims', json_build_object('sub','$(uid "$1")','role','authenticated','active_org_id','$(org "$1")')::text, true);"
}
payload_a() { # XL closes at 35 inclusive, new XXL band on top
  q -c "select jsonb_set(jsonb_set(jsonb_agg(jsonb_build_object('id',id,'label',label,'upper_kg',upper_kg,'upper_inclusive',upper_inclusive) order by sort_order),'{4,upper_kg}','35'),'{4,upper_inclusive}','true') || '[{\"label\":\"XXL\",\"upper_kg\":null}]'::jsonb from public.organization_size_bands where organization_id='$(org "$1")' and band_kind='dog_weight' and status='active'"
}
payload_b() { # a different valid layout from the same starting version
  q -c "select jsonb_set(jsonb_agg(jsonb_build_object('id',id,'label',label,'upper_kg',upper_kg,'upper_inclusive',upper_inclusive) order by sort_order),'{1,upper_kg}','12') from public.organization_size_bands where organization_id='$(org "$1")' and band_kind='dog_weight' and status='active'"
}
now() { date +%s.%N; }

# ---------------------------------------------------------------- case 1
echo "== case 1: two saves with the same expected version =="
seed 1
PA=$(payload_a 1); PB=$(payload_b 1)
( { echo "$(head_sql 1)"; echo "select 'S1_SAVED', (app.save_size_bands('$(org 1)',1,'$PA'::jsonb)->>'layout_version');"; echo "select pg_sleep(3);"; echo "commit;"; } | psql "$db" -v ON_ERROR_STOP=1 >"$OUT/1a.out" 2>&1; echo $? >"$OUT/1a.rc"; now >"$OUT/1a.t" ) &
A=$!
( for i in $(seq 1 24); do q -c "select count(*)||'/'||count(*) filter (where upper_kg is null)||'/'||string_agg(band_key,',' order by sort_order) from public.organization_size_bands where organization_id='$(org 1)' and band_kind='dog_weight' and status='active'"; sleep 0.25; done >"$OUT/1c.out" 2>&1 ) &
C=$!
sleep 1
{ echo "$(head_sql 1)"; echo "select 'S2_SAVED', (app.save_size_bands('$(org 1)',1,'$PB'::jsonb)->>'layout_version');"; echo "commit;"; } | psql "$db" -v ON_ERROR_STOP=1 >"$OUT/1b.out" 2>&1; B_RC=$?
tB=$(now); wait $A; wait $C
A_RC=$(cat "$OUT/1a.rc"); tA=$(cat "$OUT/1a.t")
[ "$A_RC" -eq 0 ] || { cat "$OUT/1a.out"; fail "case 1 session A must succeed"; }
grep -q S1_SAVED "$OUT/1a.out" || fail "case 1 session A did not save"
[ "$B_RC" -ne 0 ] || { cat "$OUT/1b.out"; fail "case 1 session B must fail"; }
grep -q "stale_layout" "$OUT/1b.out" || { cat "$OUT/1b.out"; fail "case 1 session B must receive stale_layout"; }
grep -qi "deadlock" "$OUT/1a.out" "$OUT/1b.out" && fail "case 1 deadlock"
awk -v a="$tA" -v b="$tB" 'BEGIN{ if (b+0.25 < a) exit 1 }' || fail "case 1 B finished before A committed (did not block)"
[ "$(q -c "select layout_version from public.organization_size_band_settings where organization_id='$(org 1)'")" = 2 ] || fail "case 1 version must be 2"
[ "$(q -c "select string_agg(band_key,',' order by sort_order) from public.organization_size_bands where organization_id='$(org 1)' and band_kind='dog_weight' and status='active'")" = "extra_small,small,medium,large,extra_large,xxl" ] || fail "case 1 final layout is not session A's"
# torn-read check: every observation was a complete layout (exactly one open band) and either the old or the new one
sort -u "$OUT/1c.out" | grep -v '^$' > "$OUT/1c.uniq"
[ "$(wc -l < "$OUT/1c.uniq")" -le 2 ] || { cat "$OUT/1c.uniq"; fail "case 1 observed more than the old and the new layout"; }
grep -vqE '^(5|6)/1/' "$OUT/1c.uniq" && { cat "$OUT/1c.uniq"; fail "case 1 observed a torn layout"; }
grep -q '^5/1/' "$OUT/1c.uniq" && grep -q '^6/1/' "$OUT/1c.uniq" || { cat "$OUT/1c.uniq"; fail "case 1 poller did not see both the old and the new layout"; }
echo "  OK: exactly one same-version save won, the other got stale_layout after blocking; pollers saw only 5-band or 6-band complete layouts"

# ---------------------------------------------------------------- case 2a: save holds, line waits
echo "== case 2a: save (held) vs assembly_add_line =="
seed 2
PA=$(payload_a 2)
( { echo "$(head_sql 2)"; echo "select app.save_size_bands('$(org 2)',1,'$PA'::jsonb)->>'layout_version';"; echo "select pg_sleep(3);"; echo "commit;"; } | psql "$db" -v ON_ERROR_STOP=1 >"$OUT/2a.out" 2>&1; echo $? >"$OUT/2a.rc"; now >"$OUT/2a.t" ) &
A=$!; sleep 1
{ echo "$(head_sql 2)"; echo "select 'LINE', app.assembly_add_line('$(job 2)','$(svc 2)',1);"; echo "commit;"; } | psql "$db" -v ON_ERROR_STOP=1 >"$OUT/2b.out" 2>&1; B_RC=$?
tB=$(now); wait $A
[ "$(cat "$OUT/2a.rc")" -eq 0 ] || { cat "$OUT/2a.out"; fail "case 2a save must succeed"; }
[ "$B_RC" -eq 0 ] || { cat "$OUT/2b.out"; fail "case 2a line must succeed"; }
awk -v a="$(cat "$OUT/2a.t")" -v b="$tB" 'BEGIN{ if (b+0.25 < a) exit 1 }' || fail "case 2a line finished before the save committed (did not block)"
[ "$(q -c "select pet_size_snapshot||'/'||size_layout_version_snapshot||'/'||pet_size_label_snapshot from public.grooming_job_pet_services where organization_id='$(org 2)'")" = "xxl/2/XXL" ] || fail "case 2a line must be priced under the NEW layout"
echo "  OK: the line waited for the layout commit and resolved xxl at layout version 2"

# ---------------------------------------------------------------- case 2b: line holds, save waits
echo "== case 2b: assembly_add_line (held) vs save =="
seed 3
PA=$(payload_a 3)
( { echo "$(head_sql 3)"; echo "select 'LINE', app.assembly_add_line('$(job 3)','$(svc 3)',1);"; echo "select pg_sleep(3);"; echo "commit;"; } | psql "$db" -v ON_ERROR_STOP=1 >"$OUT/3a.out" 2>&1; echo $? >"$OUT/3a.rc"; now >"$OUT/3a.t" ) &
A=$!; sleep 1
{ echo "$(head_sql 3)"; echo "select app.save_size_bands('$(org 3)',1,'$PA'::jsonb)->>'layout_version';"; echo "commit;"; } | psql "$db" -v ON_ERROR_STOP=1 >"$OUT/3b.out" 2>&1; B_RC=$?
tB=$(now); wait $A
[ "$(cat "$OUT/3a.rc")" -eq 0 ] || { cat "$OUT/3a.out"; fail "case 2b line must succeed"; }
[ "$B_RC" -eq 0 ] || { cat "$OUT/3b.out"; fail "case 2b save must succeed after the line commits"; }
awk -v a="$(cat "$OUT/3a.t")" -v b="$tB" 'BEGIN{ if (b+0.25 < a) exit 1 }' || fail "case 2b save finished before the line committed (did not block)"
[ "$(q -c "select pet_size_snapshot||'/'||size_layout_version_snapshot||'/'||pet_size_label_snapshot from public.grooming_job_pet_services where organization_id='$(org 3)'")" = "extra_large/1/XL" ] || fail "case 2b line must keep the OLD layout snapshot"
[ "$(q -c "select layout_version from public.organization_size_band_settings where organization_id='$(org 3)'")" = 2 ] || fail "case 2b layout version"
echo "  OK: the save waited for the in-flight line; the line kept the old layout snapshot (extra_large @ v1), the layout is v2"

# ---------------------------------------------------------------- case 3a: save holds, package sale waits
echo "== case 3a: save (held) vs size-restricted package sale =="
seed 4
PA=$(payload_a 4)
( { echo "$(head_sql 4)"; echo "select app.save_size_bands('$(org 4)',1,'$PA'::jsonb)->>'layout_version';"; echo "select pg_sleep(3);"; echo "commit;"; } | psql "$db" -v ON_ERROR_STOP=1 >"$OUT/4a.out" 2>&1; echo $? >"$OUT/4a.rc"; now >"$OUT/4a.t" ) &
A=$!; sleep 1
psql "$db" -v ON_ERROR_STOP=1 -c "insert into public.customer_packages(organization_id,customer_id,package_id,pet_id,sessions_remaining) values ('$(org 4)','$(cust 4)','$(pkg 4)','$(pet 4)',2)" >"$OUT/4b.out" 2>&1; B_RC=$?
tB=$(now); wait $A
[ "$(cat "$OUT/4a.rc")" -eq 0 ] || { cat "$OUT/4a.out"; fail "case 3a save must succeed"; }
[ "$B_RC" -ne 0 ] && grep -q "package_size_mismatch" "$OUT/4b.out" || { cat "$OUT/4b.out"; fail "case 3a the sale must be refused with package_size_mismatch (pet is xxl after the save)"; }
awk -v a="$(cat "$OUT/4a.t")" -v b="$tB" 'BEGIN{ if (b+0.25 < a) exit 1 }' || fail "case 3a sale finished before the save committed (did not block)"
[ "$(q -c "select count(*) from public.customer_packages where organization_id='$(org 4)'")" = 0 ] || fail "case 3a no entitlement may exist"
echo "  OK: the sale waited for the layout commit and was refused against the new layout"

# ---------------------------------------------------------------- case 3b: sale holds, save waits
echo "== case 3b: package sale (held) vs save =="
seed 5
PA=$(payload_a 5)
( { echo "begin;"; echo "insert into public.customer_packages(organization_id,customer_id,package_id,pet_id,sessions_remaining) values ('$(org 5)','$(cust 5)','$(pkg 5)','$(pet 5)',2);"; echo "select pg_sleep(3);"; echo "commit;"; } | psql "$db" -v ON_ERROR_STOP=1 >"$OUT/5a.out" 2>&1; echo $? >"$OUT/5a.rc"; now >"$OUT/5a.t" ) &
A=$!; sleep 1
{ echo "$(head_sql 5)"; echo "select app.save_size_bands('$(org 5)',1,'$PA'::jsonb)->>'layout_version';"; echo "commit;"; } | psql "$db" -v ON_ERROR_STOP=1 >"$OUT/5b.out" 2>&1; B_RC=$?
tB=$(now); wait $A
[ "$(cat "$OUT/5a.rc")" -eq 0 ] || { cat "$OUT/5a.out"; fail "case 3b sale must succeed"; }
[ "$B_RC" -ne 0 ] && grep -q "active_package_size_would_change" "$OUT/5b.out" || { cat "$OUT/5b.out"; fail "case 3b the save must be refused because the just-sold entitlement would mismatch"; }
awk -v a="$(cat "$OUT/5a.t")" -v b="$tB" 'BEGIN{ if (b+0.25 < a) exit 1 }' || fail "case 3b save finished before the sale committed (did not block)"
[ "$(q -c "select (select layout_version from public.organization_size_band_settings where organization_id='$(org 5)')||'/'||(select count(*) from public.customer_packages where organization_id='$(org 5)')")" = "1/1" ] || fail "case 3b layout must be unchanged and the entitlement present"
echo "  OK: the save waited for the in-flight sale, saw the new entitlement, and was refused without any write"

grep -qiE "deadlock detected" "$OUT"/*.out && fail "deadlock detected"
echo "CONC PASS: same-version saves, save/line and save/sale (both orders) are serialized; no deadlock; no torn layout"
