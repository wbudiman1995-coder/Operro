-- Stream 1 marketing spend + source return: immutability, reversal, cohort rule, currencies, authorization, RLS, grants.
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/20261101100000_test_marketing_spend_roi.sql
\set ON_ERROR_STOP on
create or replace function pg_temp.act_as(u text, o text) returns void language plpgsql as $$
begin perform set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated', 'active_org_id', o)::text, true); end $$;
create or replace function pg_temp.expect(p_sql text, p_state text, p_label text) returns void language plpgsql as $$
begin
  begin execute p_sql; exception when others then
    if sqlstate = p_state then raise notice 'PASS: %', p_label; return; end if;
    raise exception 'FAIL: % (expected %, got % %)', p_label, p_state, sqlstate, sqlerrm;
  end;
  raise exception 'FAIL: % (statement succeeded)', p_label;
end $$;
create or replace function pg_temp.check(p_ok boolean, p_label text) returns void language plpgsql as $$
begin if p_ok is not true then raise exception 'FAIL: %', p_label; end if; raise notice 'PASS: %', p_label; end $$;

begin;
insert into public.organizations (id, name, slug, status) values
  ('e3000000-0000-4000-8000-000000000001', 'Spend A', 'spend-a-test', 'active'),
  ('e3000000-0000-4000-8000-000000000002', 'Spend B', 'spend-b-test', 'active');
insert into public.subscriptions (organization_id, status, current_period_start, current_period_end)
  select o, 'active', now() - interval '1 day', now() + interval '1 year'
  from (values ('e3000000-0000-4000-8000-000000000001'::uuid), ('e3000000-0000-4000-8000-000000000002'::uuid)) t(o);
insert into public.organization_modules (organization_id, module_id, enabled, source)
  select o, m.id, true, 'override' from public.modules m,
  (values ('e3000000-0000-4000-8000-000000000001'::uuid), ('e3000000-0000-4000-8000-000000000002'::uuid)) t(o);
insert into public.branches (id, organization_id, name, is_default, status) values
  ('e3000000-0000-4000-8000-0000000000e1', 'e3000000-0000-4000-8000-000000000001', 'North', true, 'active'),
  ('e3000000-0000-4000-8000-0000000000e2', 'e3000000-0000-4000-8000-000000000002', 'Main B', true, 'active');
insert into public.roles (id, organization_id, name) values
  ('e3000000-0000-4000-8000-000000000011', 'e3000000-0000-4000-8000-000000000001', 'Pemilik'),
  ('e3000000-0000-4000-8000-000000000012', 'e3000000-0000-4000-8000-000000000001', 'BranchMgr'),
  ('e3000000-0000-4000-8000-000000000013', 'e3000000-0000-4000-8000-000000000001', 'Reader'),
  ('e3000000-0000-4000-8000-000000000014', 'e3000000-0000-4000-8000-000000000001', 'Nothing'),
  ('e3000000-0000-4000-8000-000000000015', 'e3000000-0000-4000-8000-000000000001', 'Groomer'),
  ('e3000000-0000-4000-8000-000000000016', 'e3000000-0000-4000-8000-000000000002', 'Pemilik');
insert into public.role_permissions (organization_id, role_id, permission_id)
  select 'e3000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000011', id from public.permissions
   where key in ('finance.read','finance.manage','branches.all','customer.read');
-- manager without branches.all: finance rights but spend/ROI are organization-wide
insert into public.role_permissions (organization_id, role_id, permission_id)
  select 'e3000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000012', id from public.permissions
   where key in ('finance.read','finance.manage','customer.read');
-- reader: may read the return but not write spend
insert into public.role_permissions (organization_id, role_id, permission_id)
  select 'e3000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000013', id from public.permissions
   where key in ('finance.read','branches.all','customer.read');
-- groomer role with every relevant permission is still refused
insert into public.role_permissions (organization_id, role_id, permission_id)
  select 'e3000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000015', id from public.permissions
   where key in ('finance.read','finance.manage','branches.all','customer.read');
insert into public.role_permissions (organization_id, role_id, permission_id)
  select 'e3000000-0000-4000-8000-000000000002', 'e3000000-0000-4000-8000-000000000016', id from public.permissions
   where key in ('finance.read','finance.manage','branches.all','customer.read');
insert into auth.users (id, email, raw_user_meta_data) values
  ('e3000000-0000-4000-8000-000000000021', 'owner@spend.test', '{}'),
  ('e3000000-0000-4000-8000-000000000022', 'mgr@spend.test', '{}'),
  ('e3000000-0000-4000-8000-000000000023', 'reader@spend.test', '{}'),
  ('e3000000-0000-4000-8000-000000000024', 'nothing@spend.test', '{}'),
  ('e3000000-0000-4000-8000-000000000025', 'groomer@spend.test', '{}'),
  ('e3000000-0000-4000-8000-000000000026', 'owner-b@spend.test', '{}');
update public.users set status = 'active' where id::text like 'e3000000-%';
insert into public.memberships (id, user_id, organization_id, role_id, status) values
  ('e3000000-0000-4000-8000-0000000000f1', 'e3000000-0000-4000-8000-000000000021', 'e3000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000011', 'active'),
  ('e3000000-0000-4000-8000-0000000000f2', 'e3000000-0000-4000-8000-000000000022', 'e3000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000012', 'active'),
  ('e3000000-0000-4000-8000-0000000000f3', 'e3000000-0000-4000-8000-000000000023', 'e3000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000013', 'active'),
  ('e3000000-0000-4000-8000-0000000000f4', 'e3000000-0000-4000-8000-000000000024', 'e3000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000014', 'active'),
  ('e3000000-0000-4000-8000-0000000000f5', 'e3000000-0000-4000-8000-000000000025', 'e3000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000015', 'active'),
  ('e3000000-0000-4000-8000-0000000000f6', 'e3000000-0000-4000-8000-000000000026', 'e3000000-0000-4000-8000-000000000002', 'e3000000-0000-4000-8000-000000000016', 'active');
insert into public.membership_branch_access (organization_id, membership_id, branch_id) values
  ('e3000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-0000000000f2', 'e3000000-0000-4000-8000-0000000000e1');

-- Customers (period under test: 2026-09-01 .. 2026-09-30 in Asia/Jakarta; 2026-08-31 17:00Z is Jakarta midnight).
insert into public.customers (id, organization_id, display_name, source, status, created_at) values
  ('e3000000-0000-4000-8000-0000000000c1', 'e3000000-0000-4000-8000-000000000001', 'IG one',      'Instagram',    'active',   '2026-09-05 03:00Z'),
  ('e3000000-0000-4000-8000-0000000000c2', 'e3000000-0000-4000-8000-000000000001', 'IG two',      '  instagram ', 'active',   '2026-09-20 03:00Z'),
  ('e3000000-0000-4000-8000-0000000000c3', 'e3000000-0000-4000-8000-000000000001', 'Teman one',   'Teman',        'active',   '2026-09-10 03:00Z'),
  ('e3000000-0000-4000-8000-0000000000c4', 'e3000000-0000-4000-8000-000000000001', 'No source',   null,           'active',   '2026-09-10 03:00Z'),
  ('e3000000-0000-4000-8000-0000000000c5', 'e3000000-0000-4000-8000-000000000001', 'IG boundary', 'Instagram',    'active',   '2026-08-31 17:00:00Z'),
  ('e3000000-0000-4000-8000-0000000000c6', 'e3000000-0000-4000-8000-000000000001', 'IG too early','Instagram',    'active',   '2026-08-31 16:59:59Z'),
  ('e3000000-0000-4000-8000-0000000000c7', 'e3000000-0000-4000-8000-000000000001', 'IG archived', 'Instagram',    'archived', '2026-09-06 03:00Z'),
  ('e3000000-0000-4000-8000-0000000000c8', 'e3000000-0000-4000-8000-000000000001', 'Google usd',  'Google',       'active',   '2026-09-12 03:00Z'),
  ('e3000000-0000-4000-8000-0000000000b1', 'e3000000-0000-4000-8000-000000000002', 'Other tenant','Instagram',    'active',   '2026-09-05 03:00Z');
insert into public.payments (id, organization_id, branch_id, customer_id, method, amount, currency, status, paid_at) values
  ('e3000000-0000-4000-8000-0000000000a1', 'e3000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-0000000000e1', 'e3000000-0000-4000-8000-0000000000c1', 'cash', 200000, 'IDR', 'succeeded', '2026-09-07 03:00Z'),
  ('e3000000-0000-4000-8000-0000000000a2', 'e3000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-0000000000e1', 'e3000000-0000-4000-8000-0000000000c1', 'cash', 100000, 'IDR', 'pending',   '2026-09-07 03:00Z'),
  ('e3000000-0000-4000-8000-0000000000a3', 'e3000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-0000000000e1', 'e3000000-0000-4000-8000-0000000000c2', 'cash', 300000, 'IDR', 'succeeded', '2026-09-25 03:00Z'),
  ('e3000000-0000-4000-8000-0000000000a4', 'e3000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-0000000000e1', 'e3000000-0000-4000-8000-0000000000c3', 'cash',  50000, 'IDR', 'succeeded', '2026-09-11 03:00Z'),
  ('e3000000-0000-4000-8000-0000000000a5', 'e3000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-0000000000e1', 'e3000000-0000-4000-8000-0000000000c4', 'cash',  70000, 'IDR', 'succeeded', '2026-09-11 03:00Z'),
  ('e3000000-0000-4000-8000-0000000000a6', 'e3000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-0000000000e1', 'e3000000-0000-4000-8000-0000000000c5', 'cash',  40000, 'IDR', 'succeeded', '2026-09-02 03:00Z'),
  ('e3000000-0000-4000-8000-0000000000a7', 'e3000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-0000000000e1', 'e3000000-0000-4000-8000-0000000000c6', 'cash', 999999, 'IDR', 'succeeded', '2026-09-02 03:00Z'),
  ('e3000000-0000-4000-8000-0000000000a8', 'e3000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-0000000000e1', 'e3000000-0000-4000-8000-0000000000c7', 'cash', 888888, 'IDR', 'succeeded', '2026-09-07 03:00Z'),
  ('e3000000-0000-4000-8000-0000000000a9', 'e3000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-0000000000e1', 'e3000000-0000-4000-8000-0000000000c8', 'card',     20, 'USD', 'succeeded', '2026-09-13 03:00Z'),
  ('e3000000-0000-4000-8000-0000000000aa', 'e3000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-0000000000e1', 'e3000000-0000-4000-8000-0000000000c1', 'cash', 500000, 'IDR', 'succeeded', '2026-10-02 03:00Z'),
  ('e3000000-0000-4000-8000-0000000000ab', 'e3000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-0000000000e1', 'e3000000-0000-4000-8000-0000000000c1', 'cash', 777777, 'IDR', 'succeeded', '2026-08-29 03:00Z');
insert into public.refunds (id, organization_id, payment_id, amount, status, refunded_at) values
  ('e3000000-0000-4000-8000-0000000000d1', 'e3000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-0000000000a1', 50000, 'succeeded', '2026-09-08 03:00Z'),
  ('e3000000-0000-4000-8000-0000000000d2', 'e3000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-0000000000a3', 12345, 'failed',    '2026-09-26 03:00Z');

set local role authenticated;
create temp table ids (k text primary key, v uuid);
grant all on ids to authenticated;

-- ===== Spend writer =========================================================================================================
select pg_temp.act_as('e3000000-0000-4000-8000-000000000021', 'e3000000-0000-4000-8000-000000000001');
do $$
declare s1 uuid; s2 uuid; again uuid;
begin
  s1 := app.record_marketing_spend('Instagram', '2026-09-03', 100000, 'idr', 'Iklan minggu 1', 'e3000000-0000-4000-8000-0000000fb001');
  s2 := app.record_marketing_spend('  INSTAGRAM ', '2026-09-15', 150000, 'IDR', null, 'e3000000-0000-4000-8000-0000000fb002');
  insert into ids values ('s1', s1), ('s2', s2);
  perform pg_temp.check((select source_key from public.marketing_spend_entries where id = s2) = 'instagram'
                        and (select source_label from public.marketing_spend_entries where id = s2) = 'INSTAGRAM', 'label trimmed; source key normalized the dashboard way');
  perform pg_temp.check((select currency from public.marketing_spend_entries where id = s1) = 'IDR', 'currency upper-cased');
  again := app.record_marketing_spend('Instagram', '2026-09-03', 100000, 'IDR', 'Iklan minggu 1', 'e3000000-0000-4000-8000-0000000fb001');
  perform pg_temp.check(again = s1 and (select count(*) from public.marketing_spend_entries) = 2, 'replay of the same request key returns the same entry and adds nothing');
  perform pg_temp.expect($q$select app.record_marketing_spend('Instagram', '2026-09-03', 999, 'IDR', null, 'e3000000-0000-4000-8000-0000000fb001')$q$, '22023', 'same key with a different payload is a conflict');
  perform pg_temp.expect($q$select app.record_marketing_spend('', '2026-09-03', 10, 'IDR', null, gen_random_uuid())$q$, '22023', 'empty source refused');
  perform pg_temp.expect($q$select app.record_marketing_spend('   ', '2026-09-03', 10, 'IDR', null, gen_random_uuid())$q$, '22023', 'blank source refused');
  perform pg_temp.expect($q$select app.record_marketing_spend(repeat('x', 81), '2026-09-03', 10, 'IDR', null, gen_random_uuid())$q$, '22023', 'overlong source refused');
  perform pg_temp.expect($q$select app.record_marketing_spend(E'bad\x01', '2026-09-03', 10, 'IDR', null, gen_random_uuid())$q$, '22023', 'control character in source refused');
  perform pg_temp.expect($q$select app.record_marketing_spend('X', '2026-09-03', 0, 'IDR', null, gen_random_uuid())$q$, '22023', 'zero amount refused');
  perform pg_temp.expect($q$select app.record_marketing_spend('X', '2026-09-03', -5, 'IDR', null, gen_random_uuid())$q$, '22023', 'negative amount refused');
  perform pg_temp.expect($q$select app.record_marketing_spend('X', '2026-09-03', 10.005, 'IDR', null, gen_random_uuid())$q$, '22023', 'sub-cent amount refused');
  perform pg_temp.expect($q$select app.record_marketing_spend('X', '2026-09-03', 1000000000000, 'IDR', null, gen_random_uuid())$q$, '22023', 'amount beyond range refused');
  perform pg_temp.expect($q$select app.record_marketing_spend('X', '2026-09-03', 10, 'RP', null, gen_random_uuid())$q$, '22023', 'bad currency refused');
  perform pg_temp.expect($q$select app.record_marketing_spend('X', '1999-12-31', 10, 'IDR', null, gen_random_uuid())$q$, '22023', 'date before 2000 refused');
  perform pg_temp.expect($q$select app.record_marketing_spend('X', current_date + 30, 10, 'IDR', null, gen_random_uuid())$q$, '22023', 'a date weeks in the future is refused');
  perform pg_temp.expect($q$select app.record_marketing_spend('X', '2026-09-03', 10, 'IDR', repeat('n', 201), gen_random_uuid())$q$, '22023', 'overlong note refused');
  perform pg_temp.expect($q$select app.record_marketing_spend('X', '2026-09-03', 10, 'IDR', null, null)$q$, '22023', 'null request key refused');
  insert into ids values ('s_old', app.record_marketing_spend('Instagram', '2026-08-31', 99999, 'IDR', 'Sebelum periode', 'e3000000-0000-4000-8000-0000000fb003'));
  insert into ids values ('s_usd', app.record_marketing_spend('Instagram', '2026-09-04', 5, 'USD', null, 'e3000000-0000-4000-8000-0000000fb004'));
end $$;

-- ===== Immutability and reversal ===========================================================================================
do $$
declare r uuid; r2 uuid; s1 uuid := (select v from ids where k = 's1');
begin
  perform pg_temp.expect($q$update public.marketing_spend_entries set amount = 1$q$, '42501', 'authenticated cannot UPDATE entries');
  perform pg_temp.expect($q$delete from public.marketing_spend_entries$q$, '42501', 'authenticated cannot DELETE entries');
  perform pg_temp.expect($q$insert into public.marketing_spend_entries(organization_id, kind, source_key, source_label, spent_on, amount, currency, request_key) values ('e3000000-0000-4000-8000-000000000001','spend','x','x','2026-09-01',1,'IDR',gen_random_uuid())$q$, '42501', 'authenticated cannot INSERT entries directly');
  perform pg_temp.expect($q$select app.reverse_marketing_spend((select v from ids where k='s1'), 'x', gen_random_uuid())$q$, '22023', 'a reason shorter than three characters is refused');
  perform pg_temp.expect($q$select app.reverse_marketing_spend(gen_random_uuid(), 'Salah catat', gen_random_uuid())$q$, 'P0002', 'unknown entry not found');
  insert into ids values ('r_usd', app.reverse_marketing_spend((select v from ids where k = 's_usd'), 'Salah mata uang', 'e3000000-0000-4000-8000-0000000fc001'));
  r := app.reverse_marketing_spend(s1, 'Duplikat tagihan', 'e3000000-0000-4000-8000-0000000fc002');
  insert into ids values ('r1', r);
  r2 := app.reverse_marketing_spend(s1, 'Duplikat tagihan', 'e3000000-0000-4000-8000-0000000fc002');
  perform pg_temp.check(r2 = r, 'replay of the reversal request is idempotent');
  perform pg_temp.check((select spent_on from public.marketing_spend_entries where id = r) = date '2026-09-03' and (select amount from public.marketing_spend_entries where id = r) = 100000,
    'a reversal carries the original day and amount');
  perform pg_temp.expect($q$select app.reverse_marketing_spend((select v from ids where k='s1'), 'Sekali lagi', gen_random_uuid())$q$, '22023', 'an entry cannot be reversed twice');
  perform pg_temp.expect($q$select app.reverse_marketing_spend((select v from ids where k='r1'), 'Batalkan pembatalan', gen_random_uuid())$q$, '22023', 'a reversal cannot be reversed');
end $$;
-- put the reversed spend back so the cohort numbers below are easy to read
do $$ begin
  insert into ids values ('s1b', app.record_marketing_spend('Instagram', '2026-09-03', 100000, 'IDR', 'Iklan minggu 1 (benar)', 'e3000000-0000-4000-8000-0000000fb005'));
end $$;

-- ===== Return =======================================================================================================================
do $$
declare r record; n integer;
begin
  select * into r from app.dashboard_source_roi('2026-09-01', '2026-09-30') where source_key = 'instagram' and currency = 'IDR';
  perform pg_temp.check(r.spend = 250000 and r.spend_entries = 3, 'Instagram IDR spend is the two live entries plus the re-entered one minus the reversed one (100000 + 150000)');
  perform pg_temp.check(r.cohort_customers = 3, 'cohort = customers created in the period with that source (boundary customer in, too-early and archived out)');
  perform pg_temp.check(r.paying_customers = 3 and r.collected = 540000, 'collected counts only succeeded payments inside the period by cohort customers');
  perform pg_temp.check(r.refunded = 50000, 'succeeded refund of a cohort payment is subtracted; a failed refund is ignored');
  perform pg_temp.check(r.net_revenue = 490000 and r.net_result = 240000 and r.ratio = 1.96 and r.has_spend, 'net revenue, net result and ratio');
  select * into r from app.dashboard_source_roi('2026-09-01', '2026-09-30') where source_key = 'instagram' and currency = 'USD';
  perform pg_temp.check(r.spend = 0 and r.has_spend is false and r.ratio is null and r.spend_entries = 1, 'a reversed USD spend nets to zero and shows no ratio');
  select * into r from app.dashboard_source_roi('2026-09-01', '2026-09-30') where source_key = 'teman';
  perform pg_temp.check(r.collected = 50000 and r.spend = 0 and r.ratio is null and r.has_spend is false, 'revenue without recorded spend has no ratio');
  select * into r from app.dashboard_source_roi('2026-09-01', '2026-09-30') where source_key = 'google' and currency = 'USD';
  perform pg_temp.check(r.collected = 20 and r.ratio is null, 'another currency is its own row');
  perform pg_temp.check(not exists (select 1 from app.dashboard_source_roi('2026-09-01', '2026-09-30') where source_key = 'google' and currency = 'IDR'), 'currencies are never combined');
  select count(*) into n from app.dashboard_source_roi('2026-09-01', '2026-09-30') where source_key is null or source_key = '';
  perform pg_temp.check(n = 0, 'customers without a source never appear');
  perform pg_temp.check(not exists (select 1 from app.dashboard_source_roi('2026-09-01', '2026-09-30') where collected = 70000), 'a payment from a customer without a source is not attributed');
  perform pg_temp.check((select spend from app.dashboard_source_roi('2026-08-01', '2026-08-31') where source_key = 'instagram' and currency = 'IDR') = 99999,
    'a spend dated before the period belongs to the earlier period');
  perform pg_temp.check((select spend from app.dashboard_source_roi('2026-09-01', '2026-09-30') where source_key = 'instagram' and currency = 'IDR') = 250000, 'and does not leak into this one');
  perform pg_temp.expect($q$select * from app.dashboard_source_roi('2026-09-30', '2026-09-01')$q$, '22023', 'reversed dates refused');
  perform pg_temp.expect($q$select * from app.dashboard_source_roi('2025-01-01', '2026-09-30')$q$, '22023', 'a period longer than 366 days is refused');
  perform pg_temp.expect($q$select * from app.dashboard_source_roi('2026-09-01', '2026-09-30', 'Mars/Phobos')$q$, '22023', 'unknown time zone refused');
  perform pg_temp.expect($q$select * from app.dashboard_source_roi(null, '2026-09-30')$q$, '22023', 'null date refused');
end $$;

-- ===== Authorization =================================================================================================================
select pg_temp.act_as('e3000000-0000-4000-8000-000000000022', 'e3000000-0000-4000-8000-000000000001');
do $$ begin
  perform pg_temp.expect($q$select app.record_marketing_spend('Instagram', '2026-09-03', 10, 'IDR', null, gen_random_uuid())$q$, '42501', 'a branch-limited manager cannot record organization-wide spend');
  perform pg_temp.expect($q$select * from app.dashboard_source_roi('2026-09-01', '2026-09-30')$q$, '42501', 'a branch-limited manager cannot read the return');
  perform pg_temp.check((select count(*) from public.marketing_spend_entries) = 0, 'and sees no spend rows (RLS)');
end $$;
select pg_temp.act_as('e3000000-0000-4000-8000-000000000023', 'e3000000-0000-4000-8000-000000000001');
do $$ begin
  perform pg_temp.expect($q$select app.record_marketing_spend('Instagram', '2026-09-03', 10, 'IDR', null, gen_random_uuid())$q$, '42501', 'finance.read alone cannot record spend');
  perform pg_temp.expect($q$select app.reverse_marketing_spend((select v from ids where k='s2'), 'Tidak boleh', gen_random_uuid())$q$, '42501', 'finance.read alone cannot reverse spend');
  perform pg_temp.check((select count(*) from public.marketing_spend_entries) >= 5, 'the reader sees the spend rows');
  perform pg_temp.check((select count(*) from app.dashboard_source_roi('2026-09-01', '2026-09-30')) >= 3, 'and can read the return');
end $$;
select pg_temp.act_as('e3000000-0000-4000-8000-000000000024', 'e3000000-0000-4000-8000-000000000001');
do $$ begin
  perform pg_temp.expect($q$select app.record_marketing_spend('Instagram', '2026-09-03', 10, 'IDR', null, gen_random_uuid())$q$, '42501', 'no capability cannot record spend');
  perform pg_temp.expect($q$select * from app.dashboard_source_roi('2026-09-01', '2026-09-30')$q$, '42501', 'no capability: the return is refused, not an empty list');
  perform pg_temp.check((select count(*) from public.marketing_spend_entries) = 0, 'no capability sees no spend rows');
end $$;
select pg_temp.act_as('e3000000-0000-4000-8000-000000000025', 'e3000000-0000-4000-8000-000000000001');
do $$ begin
  perform pg_temp.expect($q$select app.record_marketing_spend('Instagram', '2026-09-03', 10, 'IDR', null, gen_random_uuid())$q$, '42501', 'a Groomer-role member cannot record spend even with every permission');
  perform pg_temp.expect($q$select * from app.dashboard_source_roi('2026-09-01', '2026-09-30')$q$, '42501', 'a Groomer-role member cannot read the return');
  perform pg_temp.check((select count(*) from public.marketing_spend_entries) = 0, 'a Groomer-role member sees no spend rows');
end $$;
select pg_temp.act_as('e3000000-0000-4000-8000-000000000026', 'e3000000-0000-4000-8000-000000000002');
do $$ begin
  perform pg_temp.check((select count(*) from public.marketing_spend_entries) = 0, 'tenant B sees none of tenant A''s spend');
  perform pg_temp.expect($q$select app.reverse_marketing_spend((select v from ids where k='s2'), 'Bukan milik saya', gen_random_uuid())$q$, 'P0002', 'tenant B cannot reverse tenant A''s entry');
  insert into ids values ('b1', app.record_marketing_spend('Instagram', '2026-09-03', 777, 'IDR', null, gen_random_uuid()));
  perform pg_temp.check((select spend from app.dashboard_source_roi('2026-09-01', '2026-09-30') where source_key = 'instagram' and currency = 'IDR') = 777
                        and (select cohort_customers from app.dashboard_source_roi('2026-09-01', '2026-09-30') where source_key = 'instagram' and currency = 'IDR') = 1,
    'tenant B''s return is its own: its spend and its one customer, none of tenant A''s');
end $$;
select pg_temp.act_as('e3000000-0000-4000-8000-000000000021', 'e3000000-0000-4000-8000-000000000002');
do $$ begin
  perform pg_temp.expect($q$select app.record_marketing_spend('Forged', '2026-09-03', 10, 'IDR', null, gen_random_uuid())$q$, '42501', 'forged active organization refused');
  perform pg_temp.expect($q$select * from app.dashboard_source_roi('2026-09-01', '2026-09-30')$q$, '42501', 'forged active organization: the return is refused');
end $$;

-- ===== Grants / structure ===========================================================================================================
reset role;
do $$ begin
  perform pg_temp.check((select count(*) from app.audit_log where entity_table = 'marketing_spend_entries' and action = 'INSERT') >= 8, 'every spend insert (including reversals) is audited');
end $$;
do $$
declare f text; v_def boolean; v_cfg text[];
begin
  foreach f in array array['record_marketing_spend','reverse_marketing_spend','dashboard_source_roi'] loop
    select p.prosecdef, p.proconfig into v_def, v_cfg from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'app' and p.proname = f;
    perform pg_temp.check(v_def and v_cfg && array['search_path=""', 'search_path='], f || ' is SECURITY DEFINER with an empty search_path');
  end loop;
  perform pg_temp.check(not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
     where n.nspname = 'app' and p.proname in ('record_marketing_spend','reverse_marketing_spend','dashboard_source_roi','tg_marketing_spend_immutable','normalize_source_key')
       and (a.grantee = 0 or a.grantee = 'anon'::regrole)), 'anon and PUBLIC cannot execute any spend function');
  perform pg_temp.check(not has_function_privilege('authenticated', 'app.tg_marketing_spend_immutable()', 'execute'), 'the trigger function is not client-callable');
  perform pg_temp.check(not has_table_privilege('authenticated', 'public.marketing_spend_entries', 'insert') and not has_table_privilege('authenticated', 'public.marketing_spend_entries', 'update')
    and not has_table_privilege('authenticated', 'public.marketing_spend_entries', 'delete') and not has_table_privilege('anon', 'public.marketing_spend_entries', 'select'), 'clients hold SELECT only; anon nothing');
  perform pg_temp.check((select relrowsecurity from pg_class where oid = 'public.marketing_spend_entries'::regclass), 'RLS is enabled');
  -- immutability holds even for the table owner
  perform pg_temp.expect($q$update public.marketing_spend_entries set amount = amount$q$, '23001', 'the owner cannot UPDATE an entry either');
  perform pg_temp.expect($q$delete from public.marketing_spend_entries$q$, '23001', 'the owner cannot DELETE an entry either');
  perform pg_temp.check(app.schema_version() >= '20261101100000', 'schema version moved to (or past) this migration');
end $$;
rollback;
