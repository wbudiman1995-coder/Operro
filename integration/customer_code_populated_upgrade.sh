#!/usr/bin/env bash
# Disposable PostgreSQL 16 populated-upgrade regression for customer codes.
set -euo pipefail
export PGHOST="${PGHOST:-127.0.0.1}"
export PGPORT="${PGPORT:-54322}"
export PGUSER="${PGUSER:-postgres}"
export PGPASSWORD="${PGPASSWORD:-postgres}"
DB="${1:-operro_customer_code_upgrade}"
TARGET='supabase/migrations/20261022110000_customer_codes.sql'

[ -f "$TARGET" ] || { echo "Run from the Operro repository root" >&2; exit 1; }
dropdb --if-exists "$DB"
createdb "$DB"
psql -d "$DB" -q -v ON_ERROR_STOP=1 -c \
  "create schema if not exists extensions; create extension if not exists pgcrypto with schema extensions; create schema if not exists auth; create table if not exists auth.users(id uuid primary key, email text, raw_user_meta_data jsonb); create or replace function auth.uid() returns uuid language sql stable as \$\$ select nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'sub', '')::uuid \$\$; create schema if not exists storage; create table if not exists storage.buckets(id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]); create table if not exists storage.objects(id uuid, bucket_id text, name text, metadata jsonb); create or replace function storage.foldername(name text) returns text[] language sql immutable as \$\$ select string_to_array(name, '/') \$\$; do \$\$ begin create role anon nologin noinherit; exception when duplicate_object then null; end \$\$; do \$\$ begin create role service_role nologin noinherit; exception when duplicate_object then null; end \$\$; do \$\$ begin create role supabase_auth_admin nologin noinherit; exception when duplicate_object then null; end \$\$; do \$\$ begin create role authenticated nologin noinherit; exception when duplicate_object then null; end \$\$; grant usage on schema auth to authenticated;"
psql -d "$DB" -q -v ON_ERROR_STOP=1 -f integration/gate_bootstrap_extensions.sql

mapfile -t migrations < <(find supabase/migrations -maxdepth 1 -type f -name '*.sql' -print | sort)
for migration in "${migrations[@]}"; do
  [ "$migration" = "$TARGET" ] && break
  psql -d "$DB" -q -v ON_ERROR_STOP=1 -f "$migration"
done

psql -d "$DB" -v ON_ERROR_STOP=1 <<'SQL'
insert into auth.users(id,email,email_confirmed_at) values
  ('c5000000-0000-4000-8000-000000000001','upgrade-staff@example.test',now());
insert into public.users(id,full_name,email,status) values
  ('c5000000-0000-4000-8000-000000000001','Upgrade Staff','upgrade-staff@example.test','active')
on conflict (id) do update set full_name=excluded.full_name;

insert into public.organizations(id,name,slug,status) values
  ('0c500000-0000-4000-8000-000000000001','Upgrade A','customer-code-upgrade-a','active'),
  ('0c500000-0000-4000-8000-000000000002','Upgrade B','customer-code-upgrade-b','active'),
  ('0c500000-0000-4000-8000-000000000003','Upgrade Boundary','customer-code-upgrade-boundary','active');
insert into public.branches(id,organization_id,name,is_default,status) values
  ('0c500000-0000-4000-8000-0000000000a1','0c500000-0000-4000-8000-000000000001','Main',true,'active'),
  ('0c500000-0000-4000-8000-0000000000a2','0c500000-0000-4000-8000-000000000002','Main',true,'active'),
  ('0c500000-0000-4000-8000-0000000000a3','0c500000-0000-4000-8000-000000000003','Main',true,'active');
insert into public.roles(id,organization_id,name,is_system) values
  ('0c500000-0000-4000-8000-0000000000e1','0c500000-0000-4000-8000-000000000001','Staff',true);
insert into public.memberships(id,user_id,organization_id,role_id,status) values
  ('0c500000-0000-4000-8000-0000000000d1','c5000000-0000-4000-8000-000000000001','0c500000-0000-4000-8000-000000000001','0c500000-0000-4000-8000-0000000000e1','active');

insert into public.customers(id,organization_id,display_name,created_at,deleted_at) values
  ('0c500000-0000-4000-8000-00000000c001','0c500000-0000-4000-8000-000000000001','A old','2026-01-01T00:00:00Z',null),
  ('0c500000-0000-4000-8000-00000000c002','0c500000-0000-4000-8000-000000000001','A tie first','2026-01-02T00:00:00Z',null),
  ('0c500000-0000-4000-8000-00000000c003','0c500000-0000-4000-8000-000000000001','A tie second','2026-01-02T00:00:00Z',null),
  ('0c500000-0000-4000-8000-00000000c004','0c500000-0000-4000-8000-000000000001','A deleted','2026-01-03T00:00:00Z',now()),
  ('0c500000-0000-4000-8000-00000000c005','0c500000-0000-4000-8000-000000000002','B old','2026-01-01T00:00:00Z',null);
insert into public.customers(organization_id,display_name,created_at)
select '0c500000-0000-4000-8000-000000000003','Boundary ' || g,'2026-02-01T00:00:00Z'::timestamptz + g * interval '1 second'
  from generate_series(1,1000) g;

insert into public.bookings(id,organization_id,branch_id,customer_id,booking_type,status,starts_at,ends_at,service_name_snapshot,price_snapshot,currency) values
  ('0c500000-0000-4000-8000-00000000b001','0c500000-0000-4000-8000-000000000001','0c500000-0000-4000-8000-0000000000a1','0c500000-0000-4000-8000-00000000c001','grooming','completed','2026-03-01T01:00:00Z','2026-03-01T02:00:00Z','Historic Groom',125000,'IDR');
insert into public.invoices(id,organization_id,branch_id,customer_id,invoice_number,status,currency,subtotal,total,issued_at) values
  ('0c500000-0000-4000-8000-00000000f001','0c500000-0000-4000-8000-000000000001','0c500000-0000-4000-8000-0000000000a1','0c500000-0000-4000-8000-00000000c001','UPGRADE-INV-1','issued','IDR',125000,125000,'2026-03-01T02:00:00Z');
insert into public.packages(id,organization_id,name,total_sessions,price,currency) values
  ('0c500000-0000-4000-8000-00000000a001','0c500000-0000-4000-8000-000000000001','Historic Package',5,500000,'IDR');
insert into public.customer_packages(id,organization_id,customer_id,package_id,sessions_remaining,purchased_at,status,source_ref) values
  ('0c500000-0000-4000-8000-00000000a002','0c500000-0000-4000-8000-000000000001','0c500000-0000-4000-8000-00000000c001','0c500000-0000-4000-8000-00000000a001',0,'2026-03-01T02:00:00Z','active','upgrade-fixture');
insert into public.customer_package_ledger(id,organization_id,customer_package_id,delta,reason,notes,occurred_at) values
  ('0c500000-0000-4000-8000-00000000a003','0c500000-0000-4000-8000-000000000001','0c500000-0000-4000-8000-00000000a002',5,'purchase','historic purchase','2026-03-01T02:00:00Z');
insert into public.payroll_runs(id,organization_id,branch_id,period_start,period_end,status,currency,total_gross,total_net) values
  ('0c500000-0000-4000-8000-00000000d001','0c500000-0000-4000-8000-000000000001','0c500000-0000-4000-8000-0000000000a1','2026-03-01','2026-03-31','draft','IDR',2000000,1800000);
insert into public.payroll_items(id,organization_id,payroll_run_id,membership_id,base_pay,gross_pay,net_pay,breakdown) values
  ('0c500000-0000-4000-8000-00000000d002','0c500000-0000-4000-8000-000000000001','0c500000-0000-4000-8000-00000000d001','0c500000-0000-4000-8000-0000000000d1',2000000,2000000,1800000,'{"fixture":true}');
SQL

history_hash() {
  psql -d "$DB" -tAc "
    select md5(string_agg(kind || ':' || payload, '|' order by kind))
    from (
      select 'booking' kind, to_jsonb(t)::text payload from public.bookings t where id='0c500000-0000-4000-8000-00000000b001'
      union all select 'invoice', to_jsonb(t)::text from public.invoices t where id='0c500000-0000-4000-8000-00000000f001'
      union all select 'package', to_jsonb(t)::text from public.packages t where id='0c500000-0000-4000-8000-00000000a001'
      union all select 'customer_package', to_jsonb(t)::text from public.customer_packages t where id='0c500000-0000-4000-8000-00000000a002'
      union all select 'package_ledger', to_jsonb(t)::text from public.customer_package_ledger t where id='0c500000-0000-4000-8000-00000000a003'
      union all select 'payroll_run', to_jsonb(t)::text from public.payroll_runs t where id='0c500000-0000-4000-8000-00000000d001'
      union all select 'payroll_item', to_jsonb(t)::text from public.payroll_items t where id='0c500000-0000-4000-8000-00000000d002'
    ) history_rows;" | tr -d '[:space:]'
}

before_hash=$(history_hash)
[ -n "$before_hash" ] || { echo 'Failed to hash populated history' >&2; exit 1; }
psql -d "$DB" -q -v ON_ERROR_STOP=1 -f "$TARGET"
after_hash=$(history_hash)
[ "$before_hash" = "$after_hash" ] || { echo "Historical rows changed: $before_hash -> $after_hash" >&2; exit 1; }

psql -d "$DB" -v ON_ERROR_STOP=1 <<'SQL'
do $$
declare v_code text; v_count integer;
begin
  if exists (select 1 from public.customers where customer_code is null) then
    raise exception 'NULL customer_code after populated upgrade';
  end if;
  if exists (select 1 from public.customers where customer_code !~ '^CUST-[0-9]+$') then
    raise exception 'invalid customer_code after populated upgrade';
  end if;

  select customer_code into v_code from public.customers where id='0c500000-0000-4000-8000-00000000c001';
  if v_code <> 'CUST-001' then raise exception 'oldest A code %', v_code; end if;
  select customer_code into v_code from public.customers where id='0c500000-0000-4000-8000-00000000c002';
  if v_code <> 'CUST-002' then raise exception 'first tied A code %', v_code; end if;
  select customer_code into v_code from public.customers where id='0c500000-0000-4000-8000-00000000c003';
  if v_code <> 'CUST-003' then raise exception 'second tied A code %', v_code; end if;
  select customer_code into v_code from public.customers where id='0c500000-0000-4000-8000-00000000c004' and deleted_at is not null;
  if v_code <> 'CUST-004' then raise exception 'soft-deleted A code %', v_code; end if;
  select customer_code into v_code from public.customers where id='0c500000-0000-4000-8000-00000000c005';
  if v_code <> 'CUST-001' then raise exception 'org B did not restart: %', v_code; end if;

  select count(distinct customer_code) into v_count from public.customers
   where organization_id='0c500000-0000-4000-8000-000000000003';
  if v_count <> 1000 then raise exception 'boundary org distinct code count %', v_count; end if;
  if not exists (select 1 from public.customers where organization_id='0c500000-0000-4000-8000-000000000003' and customer_code='CUST-1000') then
    raise exception 'CUST-1000 missing after backfill';
  end if;

  insert into public.customers(organization_id,display_name)
    values ('0c500000-0000-4000-8000-000000000001','After Upgrade')
    returning customer_code into v_code;
  if v_code <> 'CUST-005' then raise exception 'soft-deleted code was reused; next=%', v_code; end if;

  raise notice 'CUSTOMER CODE POPULATED UPGRADE PASS';
end $$;
SQL

echo "CUSTOMER CODE POPULATED UPGRADE PASS history_hash=$after_hash"
