-- Stream 2 cash-account mappings and mapped cash on hand: resolution, dates, specificity, currencies, double-count guard, authorization, RLS, grants.
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/20261101110000_test_cash_account_mappings.sql
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
  ('e4000000-0000-4000-8000-000000000001', 'Map A', 'map-a-test', 'active'),
  ('e4000000-0000-4000-8000-000000000002', 'Map B', 'map-b-test', 'active');
insert into public.subscriptions (organization_id, status, current_period_start, current_period_end)
  select o, 'active', now() - interval '1 day', now() + interval '1 year'
  from (values ('e4000000-0000-4000-8000-000000000001'::uuid), ('e4000000-0000-4000-8000-000000000002'::uuid)) t(o);
insert into public.organization_modules (organization_id, module_id, enabled, source)
  select o, m.id, true, 'override' from public.modules m,
  (values ('e4000000-0000-4000-8000-000000000001'::uuid), ('e4000000-0000-4000-8000-000000000002'::uuid)) t(o);
insert into public.branches (id, organization_id, name, is_default, status) values
  ('e4000000-0000-4000-8000-0000000000e1', 'e4000000-0000-4000-8000-000000000001', 'North', true, 'active'),
  ('e4000000-0000-4000-8000-0000000000e3', 'e4000000-0000-4000-8000-000000000001', 'South', false, 'active'),
  ('e4000000-0000-4000-8000-0000000000e2', 'e4000000-0000-4000-8000-000000000002', 'Main B', true, 'active');
insert into public.roles (id, organization_id, name) values
  ('e4000000-0000-4000-8000-000000000011', 'e4000000-0000-4000-8000-000000000001', 'Pemilik'),
  ('e4000000-0000-4000-8000-000000000012', 'e4000000-0000-4000-8000-000000000001', 'NorthMgr'),
  ('e4000000-0000-4000-8000-000000000013', 'e4000000-0000-4000-8000-000000000001', 'Reader'),
  ('e4000000-0000-4000-8000-000000000014', 'e4000000-0000-4000-8000-000000000001', 'Nothing'),
  ('e4000000-0000-4000-8000-000000000015', 'e4000000-0000-4000-8000-000000000002', 'Pemilik');
insert into public.role_permissions (organization_id, role_id, permission_id)
  select 'e4000000-0000-4000-8000-000000000001', 'e4000000-0000-4000-8000-000000000011', id from public.permissions where key in ('finance.read','finance.manage','branches.all');
insert into public.role_permissions (organization_id, role_id, permission_id)
  select 'e4000000-0000-4000-8000-000000000001', 'e4000000-0000-4000-8000-000000000012', id from public.permissions where key in ('finance.read','finance.manage');
insert into public.role_permissions (organization_id, role_id, permission_id)
  select 'e4000000-0000-4000-8000-000000000001', 'e4000000-0000-4000-8000-000000000013', id from public.permissions where key in ('finance.read','branches.all');
insert into public.role_permissions (organization_id, role_id, permission_id)
  select 'e4000000-0000-4000-8000-000000000002', 'e4000000-0000-4000-8000-000000000015', id from public.permissions where key in ('finance.read','finance.manage','branches.all');
insert into auth.users (id, email, raw_user_meta_data) values
  ('e4000000-0000-4000-8000-000000000021', 'owner@map.test', '{}'),
  ('e4000000-0000-4000-8000-000000000022', 'north@map.test', '{}'),
  ('e4000000-0000-4000-8000-000000000023', 'reader@map.test', '{}'),
  ('e4000000-0000-4000-8000-000000000024', 'nothing@map.test', '{}'),
  ('e4000000-0000-4000-8000-000000000025', 'owner-b@map.test', '{}');
update public.users set status = 'active' where id::text like 'e4000000-%';
insert into public.memberships (id, user_id, organization_id, role_id, status) values
  ('e4000000-0000-4000-8000-0000000000f1', 'e4000000-0000-4000-8000-000000000021', 'e4000000-0000-4000-8000-000000000001', 'e4000000-0000-4000-8000-000000000011', 'active'),
  ('e4000000-0000-4000-8000-0000000000f2', 'e4000000-0000-4000-8000-000000000022', 'e4000000-0000-4000-8000-000000000001', 'e4000000-0000-4000-8000-000000000012', 'active'),
  ('e4000000-0000-4000-8000-0000000000f3', 'e4000000-0000-4000-8000-000000000023', 'e4000000-0000-4000-8000-000000000001', 'e4000000-0000-4000-8000-000000000013', 'active'),
  ('e4000000-0000-4000-8000-0000000000f4', 'e4000000-0000-4000-8000-000000000024', 'e4000000-0000-4000-8000-000000000001', 'e4000000-0000-4000-8000-000000000014', 'active'),
  ('e4000000-0000-4000-8000-0000000000f5', 'e4000000-0000-4000-8000-000000000025', 'e4000000-0000-4000-8000-000000000002', 'e4000000-0000-4000-8000-000000000015', 'active');
insert into public.membership_branch_access (organization_id, membership_id, branch_id) values
  ('e4000000-0000-4000-8000-000000000001', 'e4000000-0000-4000-8000-0000000000f2', 'e4000000-0000-4000-8000-0000000000e1');

-- Authoritative flows (September 2026; the clock of the test database is after them).
insert into public.payments (id, organization_id, branch_id, method, amount, currency, status, paid_at) values
  ('e4000000-0000-4000-8000-0000000000c1', 'e4000000-0000-4000-8000-000000000001', 'e4000000-0000-4000-8000-0000000000e1', 'cash',          100000, 'IDR', 'succeeded', '2026-09-05 03:00Z'),
  ('e4000000-0000-4000-8000-0000000000c2', 'e4000000-0000-4000-8000-000000000001', 'e4000000-0000-4000-8000-0000000000e3', 'cash',           50000, 'IDR', 'succeeded', '2026-09-06 03:00Z'),
  ('e4000000-0000-4000-8000-0000000000c3', 'e4000000-0000-4000-8000-000000000001', 'e4000000-0000-4000-8000-0000000000e1', 'bank_transfer', 200000, 'IDR', 'succeeded', '2026-09-07 03:00Z'),
  ('e4000000-0000-4000-8000-0000000000c4', 'e4000000-0000-4000-8000-000000000001', 'e4000000-0000-4000-8000-0000000000e3', 'bank_transfer', 300000, 'IDR', 'succeeded', '2026-09-07 03:00Z'),
  ('e4000000-0000-4000-8000-0000000000c5', 'e4000000-0000-4000-8000-000000000001', 'e4000000-0000-4000-8000-0000000000e1', 'card',           70000, 'IDR', 'succeeded', '2026-09-08 03:00Z'),
  ('e4000000-0000-4000-8000-0000000000c6', 'e4000000-0000-4000-8000-000000000001', 'e4000000-0000-4000-8000-0000000000e1', 'cash',          999, 'IDR', 'pending',   '2026-09-08 03:00Z'),
  ('e4000000-0000-4000-8000-0000000000c7', 'e4000000-0000-4000-8000-000000000001', 'e4000000-0000-4000-8000-0000000000e1', 'cash',           10000, 'IDR', 'succeeded', '2026-08-31 03:00Z'),
  ('e4000000-0000-4000-8000-0000000000c8', 'e4000000-0000-4000-8000-000000000001', 'e4000000-0000-4000-8000-0000000000e1', 'wallet',         25000, 'IDR', 'succeeded', '2026-09-09 03:00Z'),
  ('e4000000-0000-4000-8000-0000000000c9', 'e4000000-0000-4000-8000-000000000001', 'e4000000-0000-4000-8000-0000000000e1', 'cash',           40000, 'IDR', 'succeeded', '2026-09-10 03:00Z'),
  ('e4000000-0000-4000-8000-0000000000ca', 'e4000000-0000-4000-8000-000000000001', 'e4000000-0000-4000-8000-0000000000e1', 'cash',            1111, 'IDR', 'succeeded', '2026-09-25 03:00Z');
insert into public.refunds (id, organization_id, payment_id, amount, status, refunded_at) values
  ('e4000000-0000-4000-8000-0000000000d1', 'e4000000-0000-4000-8000-000000000001', 'e4000000-0000-4000-8000-0000000000c1', 20000, 'succeeded', '2026-09-12 03:00Z'),
  ('e4000000-0000-4000-8000-0000000000d2', 'e4000000-0000-4000-8000-000000000001', 'e4000000-0000-4000-8000-0000000000c3', 50000, 'succeeded', '2026-09-12 03:00Z'),
  ('e4000000-0000-4000-8000-0000000000d3', 'e4000000-0000-4000-8000-000000000001', 'e4000000-0000-4000-8000-0000000000c1',  7777, 'failed',    '2026-09-13 03:00Z');
insert into public.expenses (id, organization_id, branch_id, description, amount, currency, incurred_at, deleted_at) values
  ('e4000000-0000-4000-8000-0000000000a1', 'e4000000-0000-4000-8000-000000000001', 'e4000000-0000-4000-8000-0000000000e1', 'Listrik',     150000, 'IDR', '2026-09-11', null),
  ('e4000000-0000-4000-8000-0000000000a2', 'e4000000-0000-4000-8000-000000000001', null,                                   'Pusat',        30000, 'IDR', '2026-09-11', null),
  ('e4000000-0000-4000-8000-0000000000a3', 'e4000000-0000-4000-8000-000000000001', 'e4000000-0000-4000-8000-0000000000e1', 'Sebelum',       5000, 'IDR', '2026-08-30', null),
  ('e4000000-0000-4000-8000-0000000000a4', 'e4000000-0000-4000-8000-000000000001', 'e4000000-0000-4000-8000-0000000000e1', 'Dihapus',      99999, 'IDR', '2026-09-11', now()),
  ('e4000000-0000-4000-8000-0000000000a5', 'e4000000-0000-4000-8000-000000000001', 'e4000000-0000-4000-8000-0000000000e1', 'Alat USD',        10, 'USD', '2026-09-11', null),
  ('e4000000-0000-4000-8000-0000000000b1', 'e4000000-0000-4000-8000-000000000002', 'e4000000-0000-4000-8000-0000000000e2', 'Other tenant',    5, 'IDR', '2026-09-11', null);
insert into public.financial_ledger (organization_id, branch_id, entry_type, amount, currency, occurred_at) values
  ('e4000000-0000-4000-8000-000000000001', 'e4000000-0000-4000-8000-0000000000e1', 'payroll_paid', -500000, 'IDR', '2026-09-15 03:00Z'),
  ('e4000000-0000-4000-8000-000000000001', 'e4000000-0000-4000-8000-0000000000e1', 'payroll_paid',  100000, 'IDR', '2026-09-16 03:00Z'),
  ('e4000000-0000-4000-8000-000000000001', null,                                   'payroll_paid',   -7000, 'IDR', '2026-09-17 03:00Z');

set local role authenticated;
create temp table ids (k text primary key, v uuid);
grant all on ids to authenticated;

-- ===== Setup as owner: accounts, declared movements, mappings ==========================================================
select pg_temp.act_as('e4000000-0000-4000-8000-000000000021', 'e4000000-0000-4000-8000-000000000001');
do $$
declare kas uuid; bca uuid; usd uuid; south uuid;
begin
  kas := app.create_cash_account('Kas toko', 'cash', 'IDR', null);
  bca := app.create_cash_account('BCA North', 'bank', 'IDR', 'e4000000-0000-4000-8000-0000000000e1');
  usd := app.create_cash_account('USD box', 'other', 'USD', null);
  south := app.create_cash_account('South petty', 'cash', 'IDR', 'e4000000-0000-4000-8000-0000000000e3');
  insert into ids values ('kas', kas), ('bca', bca), ('usd', usd), ('south', south);
  perform app.record_cash_movement(kas, 'opening_balance', 1000000, '2026-09-01', null, 'Saldo awal', null, null, 'e4000000-0000-4000-8000-0000000fa001');
  perform app.record_cash_movement(bca, 'opening_balance', 2000000, '2026-09-01', null, 'Saldo awal', null, null, 'e4000000-0000-4000-8000-0000000fa002');
  -- a payment the owner already declared by hand: the mapped flow must not count it a second time
  perform app.record_cash_movement(kas, 'cash_in', 40000, '2026-09-10', null, 'Dicatat manual', 'payment', 'e4000000-0000-4000-8000-0000000000c9', 'e4000000-0000-4000-8000-0000000fa003');

  insert into ids values ('m_cash', app.set_cash_account_mapping('payment', 'cash', null, kas, '2026-09-01', 'e4000000-0000-4000-8000-0000000fb001'));
  insert into ids values ('m_bank', app.set_cash_account_mapping('payment', 'bank_transfer', 'e4000000-0000-4000-8000-0000000000e1', bca, '2026-09-01', 'e4000000-0000-4000-8000-0000000fb002'));
  perform app.set_cash_account_mapping('expense', null, null, kas, '2026-09-01', 'e4000000-0000-4000-8000-0000000fb003');
  perform app.set_cash_account_mapping('payroll', null, null, kas, '2026-09-01', 'e4000000-0000-4000-8000-0000000fb004');
  perform app.set_cash_account_mapping('payment', 'wallet', null, usd, '2026-09-01', 'e4000000-0000-4000-8000-0000000fb005');
  -- South's cash goes to its own account from the 6th: a branch rule wins over the organization-wide one
  perform app.set_cash_account_mapping('payment', 'cash', 'e4000000-0000-4000-8000-0000000000e3', south, '2026-09-06', 'e4000000-0000-4000-8000-0000000fb006');
  perform pg_temp.check((select count(*) from public.cash_account_mappings) = 6, 'six mappings recorded');
end $$;

-- ===== Position =============================================================================================================
do $$
declare r record;
begin
  select * into r from app.cash_on_hand('2026-09-24') where account_name = 'Kas toko';
  perform pg_temp.check(r.declared_balance = 1040000, 'declared balance = opening + the hand-declared linked payment');
  perform pg_temp.check(r.payments_in = 100000, 'mapped payments: the cash payment of North; South cash goes to its own account; the already-declared one is not counted twice');
  perform pg_temp.check(r.refunds_out = 20000, 'a succeeded refund follows its payment''s method and account; a failed refund is ignored');
  perform pg_temp.check(r.expenses_out = 180000, 'mapped expenses (a branch one and an organization-wide one); deleted, earlier-than-cutover and other-currency ones excluded');
  perform pg_temp.check(r.payroll_out = 407000, 'payroll paid from the ledger nets its compensating entry (500000 - 100000 + 7000)');
  perform pg_temp.check(r.balance = 533000 and r.mapped_complete and r.mapped_flows = 7, 'balance = declared + payments - refunds - expenses - payroll');
  perform pg_temp.check(r.first_effective = date '2026-09-01', 'first effective date reported');
  select * into r from app.cash_on_hand('2026-09-24') where account_name = 'BCA North';
  perform pg_temp.check(r.balance = 2150000 and r.payments_in = 200000 and r.refunds_out = 50000 and r.expenses_out = 0, 'a branch account receives its branch mapping''s payments and their refunds');
  select * into r from app.cash_on_hand('2026-09-24') where account_name = 'South petty';
  perform pg_temp.check(r.balance = 50000 and r.declared_balance = 0 and r.payments_in = 50000, 'the more specific branch mapping applies from its own effective date');
  select * into r from app.cash_on_hand('2026-09-24') where account_name = 'USD box';
  perform pg_temp.check(r.balance = 0 and r.mapped_flows = 0, 'a flow in another currency than its account never lands in it');
  select * into r from app.cash_on_hand('2026-09-08') where account_name = 'Kas toko';
  perform pg_temp.check(r.declared_balance = 1000000 and r.payments_in = 100000 and r.refunds_out = 0 and r.expenses_out = 0 and r.balance = 1100000, 'as-of limits both declared movements and flows (South cash of the 6th belongs to its own account)');
  perform pg_temp.check((select count(*) from app.cash_on_hand('2026-09-24')) = 4, 'every visible account is listed once');
  perform pg_temp.expect($q$select * from app.cash_on_hand('2026-09-24', 'Mars/Phobos')$q$, '22023', 'unknown time zone refused');
  perform pg_temp.expect($q$select * from app.cash_on_hand('1999-01-01')$q$, '22023', 'a date before 2000 is refused');
end $$;

-- ===== What the position leaves out =========================================================================================
do $$
declare r record;
begin
  select * into r from app.cash_unmapped_flows('2026-09-24') where kind = 'payment' and reason = 'not_mapped';
  perform pg_temp.check(r.currency = 'IDR' and r.flow_count = 2 and r.total_amount = 370000, 'payments with no mapping (South bank transfer, card) are listed, not dropped');
  select * into r from app.cash_unmapped_flows('2026-09-24') where kind = 'payment' and reason = 'already_declared';
  perform pg_temp.check(r.flow_count = 1 and r.total_amount = 40000, 'a payment already declared by hand is reported as such');
  select * into r from app.cash_unmapped_flows('2026-09-24') where kind = 'payment' and reason = 'currency_mismatch';
  perform pg_temp.check(r.flow_count = 1 and r.total_amount = 25000, 'a currency mismatch is reported');
  select * into r from app.cash_unmapped_flows('2026-09-24') where kind = 'expense' and reason = 'currency_mismatch';
  perform pg_temp.check(r.currency = 'USD' and r.total_amount = 10, 'a USD expense mapped to an IDR account is reported in USD');
  perform pg_temp.check(not exists (select 1 from app.cash_unmapped_flows('2026-09-24') where kind = 'refund'), 'refunds of mapped payments are fully mapped');
  perform pg_temp.check(not exists (select 1 from app.cash_unmapped_flows('2026-09-24') where total_amount in (10000, 5000, 99999, 999)), 'flows before the first mapping, deleted expenses and pending payments are neither counted nor reported');
end $$;

-- ===== Dates, stopping and history ==========================================================================================
do $$
declare r record;
begin
  perform pg_temp.expect($q$select app.set_cash_account_mapping('payment', 'cash', null, (select v from ids where k='kas'), '2026-08-15', gen_random_uuid())$q$, '22023', 'a mapping cannot be dated before the previous one for the same key');
  insert into ids values ('stop', app.set_cash_account_mapping('payment', 'cash', null, null, '2026-09-20', 'e4000000-0000-4000-8000-0000000fb007'));
  select * into r from app.cash_on_hand('2026-09-30') where account_name = 'Kas toko';
  perform pg_temp.check(r.payments_in = 100000 and r.balance = 533000, 'a stop mapping changes nothing before its date');
  perform pg_temp.check((select flow_count from app.cash_unmapped_flows('2026-09-30') where kind = 'payment' and reason = 'not_mapped') = 3, 'after a stop date the cash payment of 25 Sept is reported as unmapped');
  perform pg_temp.check((select total_amount from app.cash_unmapped_flows('2026-09-30') where kind = 'payment' and reason = 'not_mapped') = 371111, 'with its amount');
  perform pg_temp.check((select count(*) from public.cash_account_mappings) = 7, 'history is kept: the stop is a new row');
end $$;

-- ===== Validation ===========================================================================================================
do $$
declare kas uuid := (select v from ids where k = 'kas'); bca uuid := (select v from ids where k = 'bca'); again uuid;
begin
  perform pg_temp.expect($q$select app.set_cash_account_mapping('invoice', null, null, (select v from ids where k='kas'), '2026-09-21', gen_random_uuid())$q$, '22023', 'unknown flow refused');
  perform pg_temp.expect($q$select app.set_cash_account_mapping('payment', null, null, (select v from ids where k='kas'), '2026-09-21', gen_random_uuid())$q$, '22023', 'a payment mapping needs a method');
  perform pg_temp.expect($q$select app.set_cash_account_mapping('expense', 'cash', null, (select v from ids where k='kas'), '2026-09-21', gen_random_uuid())$q$, '22023', 'an expense mapping takes no method');
  perform pg_temp.expect($q$select app.set_cash_account_mapping('payment', 'crypto', null, (select v from ids where k='kas'), '2026-09-21', gen_random_uuid())$q$, '22023', 'unknown method refused');
  perform pg_temp.expect($q$select app.set_cash_account_mapping('expense', null, null, (select v from ids where k='kas'), current_date + 5, gen_random_uuid())$q$, '22023', 'a date in the future is refused');
  perform pg_temp.expect($q$select app.set_cash_account_mapping('expense', null, null, (select v from ids where k='kas'), '1999-01-01', gen_random_uuid())$q$, '22023', 'a date before 2000 is refused');
  perform pg_temp.expect($q$select app.set_cash_account_mapping('expense', null, null, (select v from ids where k='kas'), '2026-09-21', null)$q$, '22023', 'a null request key is refused');
  perform pg_temp.expect($q$select app.set_cash_account_mapping('expense', null, null, gen_random_uuid(), '2026-09-21', gen_random_uuid())$q$, 'P0002', 'an unknown account is not found');
  perform pg_temp.expect($q$select app.set_cash_account_mapping('expense', null, 'e4000000-0000-4000-8000-0000000000e2', (select v from ids where k='kas'), '2026-09-21', gen_random_uuid())$q$, 'P0002', 'a branch of another tenant is not found');
  perform pg_temp.expect($q$select app.set_cash_account_mapping('expense', null, 'e4000000-0000-4000-8000-0000000000e3', (select v from ids where k='bca'), '2026-09-21', gen_random_uuid())$q$, '22023', 'a branch account only receives its own branch''s flows');
  perform pg_temp.expect($q$select app.set_cash_account_mapping('expense', null, null, (select v from ids where k='bca'), '2026-09-21', gen_random_uuid())$q$, '22023', 'an organization-wide rule cannot feed a branch account');
  again := app.set_cash_account_mapping('payment', 'bank_transfer', 'e4000000-0000-4000-8000-0000000000e1', bca, '2026-09-01', 'e4000000-0000-4000-8000-0000000fb002');
  perform pg_temp.check(again = (select v from ids where k = 'm_bank') and (select count(*) from public.cash_account_mappings) = 7, 'replay of the same request key returns the same mapping and adds nothing');
  perform pg_temp.expect($q$select app.set_cash_account_mapping('payment', 'bank_transfer', null, (select v from ids where k='kas'), '2026-09-01', 'e4000000-0000-4000-8000-0000000fb002')$q$, '22023', 'the same key with a different payload is a conflict');
  perform app.set_cash_account_archived(kas, false, 1);
  insert into ids values ('old', app.create_cash_account('Arsip', 'cash', 'IDR', null));
  perform app.set_cash_account_archived((select v from ids where k = 'old'), true, 1);
  perform pg_temp.expect($q$select app.set_cash_account_mapping('expense', null, null, (select v from ids where k='old'), '2026-09-21', gen_random_uuid())$q$, '22023', 'an archived account cannot be a target');
end $$;

-- ===== Immutability =========================================================================================================
do $$ begin
  perform pg_temp.expect($q$update public.cash_account_mappings set effective_from = '2026-01-01'$q$, '42501', 'authenticated cannot UPDATE mappings');
  perform pg_temp.expect($q$delete from public.cash_account_mappings$q$, '42501', 'authenticated cannot DELETE mappings');
  perform pg_temp.expect($q$insert into public.cash_account_mappings(organization_id, flow, effective_from, request_key) values ('e4000000-0000-4000-8000-000000000001','expense','2026-09-01',gen_random_uuid())$q$, '42501', 'authenticated cannot INSERT mappings directly');
end $$;

-- ===== Authorization ========================================================================================================
select pg_temp.act_as('e4000000-0000-4000-8000-000000000022', 'e4000000-0000-4000-8000-000000000001');
do $$
declare r record;
begin
  perform pg_temp.expect($q$select app.set_cash_account_mapping('expense', null, null, (select v from ids where k='kas'), '2026-09-21', gen_random_uuid())$q$, '42501', 'a branch-limited manager cannot set an organization-wide mapping');
  perform pg_temp.expect($q$select app.set_cash_account_mapping('payment', 'card', 'e4000000-0000-4000-8000-0000000000e1', (select v from ids where k='kas'), '2026-09-21', gen_random_uuid())$q$, '42501', 'nor feed an organization-wide account');
  perform pg_temp.expect($q$select app.set_cash_account_mapping('payment', 'card', 'e4000000-0000-4000-8000-0000000000e3', (select v from ids where k='south'), '2026-09-21', gen_random_uuid())$q$, '42501', 'nor map a branch they lack');
  insert into ids values ('north_card', app.set_cash_account_mapping('payment', 'card', 'e4000000-0000-4000-8000-0000000000e1', (select v from ids where k='bca'), '2026-09-21', 'e4000000-0000-4000-8000-0000000fb010'));
  raise notice 'PASS: a branch-limited manager maps their own branch to their own branch account';
  select * into r from app.cash_on_hand('2026-09-30') where account_name = 'Kas toko';
  perform pg_temp.check(r.mapped_complete is false and r.balance is null and r.payments_in is null and r.declared_balance = 1040000,
    'an organization-wide account shows no mapped total to someone who cannot see every branch (it would omit branches)');
  select * into r from app.cash_on_hand('2026-09-30') where account_name = 'BCA North';
  perform pg_temp.check(r.mapped_complete and r.balance = 2150000, 'a branch account is complete for a caller with that branch');
  perform pg_temp.check(not exists (select 1 from app.cash_on_hand('2026-09-30') where account_name = 'South petty'), 'accounts of other branches are not listed');
  perform pg_temp.check(not exists (select 1 from app.cash_unmapped_flows('2026-09-30') where reason = 'not_mapped' and total_amount >= 300000), 'unmapped flows are limited to the caller''s branches (South''s 300000 is not visible)');
  perform pg_temp.check((select count(*) from public.cash_account_mappings where branch_id is not null and branch_id <> 'e4000000-0000-4000-8000-0000000000e1') = 0, 'mapping rows of other branches are not visible');
end $$;
select pg_temp.act_as('e4000000-0000-4000-8000-000000000023', 'e4000000-0000-4000-8000-000000000001');
do $$ begin
  perform pg_temp.expect($q$select app.set_cash_account_mapping('expense', null, null, (select v from ids where k='kas'), '2026-09-22', gen_random_uuid())$q$, '42501', 'finance.read alone cannot set a mapping');
  perform pg_temp.check((select balance from app.cash_on_hand('2026-09-30') where account_name = 'Kas toko') = 533000, 'the reader sees the same position as the owner');
  perform pg_temp.check((select count(*) from public.cash_account_mappings) >= 8, 'and every mapping');
end $$;
select pg_temp.act_as('e4000000-0000-4000-8000-000000000024', 'e4000000-0000-4000-8000-000000000001');
do $$ begin
  perform pg_temp.expect($q$select app.set_cash_account_mapping('expense', null, null, (select v from ids where k='kas'), '2026-09-22', gen_random_uuid())$q$, '42501', 'no capability cannot set a mapping');
  perform pg_temp.expect($q$select * from app.cash_on_hand('2026-09-30')$q$, '42501', 'no capability: the position is refused, not an empty list');
  perform pg_temp.expect($q$select * from app.cash_unmapped_flows('2026-09-30')$q$, '42501', 'no capability: the unmapped report is refused');
  perform pg_temp.check((select count(*) from public.cash_account_mappings) = 0, 'no capability sees no mappings');
end $$;
select pg_temp.act_as('e4000000-0000-4000-8000-000000000025', 'e4000000-0000-4000-8000-000000000002');
do $$ begin
  perform pg_temp.check((select count(*) from public.cash_account_mappings) = 0, 'tenant B sees none of tenant A''s mappings');
  perform pg_temp.expect($q$select app.set_cash_account_mapping('expense', null, null, (select v from ids where k='kas'), '2026-09-22', gen_random_uuid())$q$, 'P0002', 'tenant B cannot map to tenant A''s account');
  perform pg_temp.check((select count(*) from app.cash_on_hand('2026-09-30')) = 0, 'tenant B has no accounts and so no position');
  perform pg_temp.check((select count(*) from app.cash_unmapped_flows('2026-09-30')) = 0, 'and nothing unmapped');
end $$;
select pg_temp.act_as('e4000000-0000-4000-8000-000000000021', 'e4000000-0000-4000-8000-000000000002');
do $$ begin
  perform pg_temp.expect($q$select * from app.cash_on_hand('2026-09-30')$q$, '42501', 'forged active organization refused');
end $$;

-- ===== Grants / structure ===================================================================================================
reset role;
do $$
declare f text; v_def boolean; v_cfg text[];
begin
  perform pg_temp.check((select count(*) from app.audit_log where entity_table = 'cash_account_mappings' and action = 'INSERT') >= 8, 'every mapping insert is audited');
  foreach f in array array['set_cash_account_mapping','cash_flow_resolution','cash_on_hand','cash_unmapped_flows'] loop
    select p.prosecdef, p.proconfig into v_def, v_cfg from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'app' and p.proname = f;
    perform pg_temp.check(v_def and v_cfg && array['search_path=""', 'search_path='], f || ' is SECURITY DEFINER with an empty search_path');
  end loop;
  perform pg_temp.check(not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
     where n.nspname = 'app' and p.proname in ('set_cash_account_mapping','cash_flow_resolution','cash_on_hand','cash_unmapped_flows','tg_cash_account_mappings_immutable')
       and (a.grantee = 0 or a.grantee = 'anon'::regrole)), 'anon and PUBLIC cannot execute any mapping function');
  perform pg_temp.check(not has_function_privilege('authenticated', 'app.cash_flow_resolution(date, text)', 'execute'), 'the internal resolution helper is not client-callable');
  perform pg_temp.check(not has_function_privilege('authenticated', 'app.tg_cash_account_mappings_immutable()', 'execute'), 'the trigger function is not client-callable');
  perform pg_temp.check(has_function_privilege('authenticated', 'app.cash_on_hand(date, text)', 'execute') and has_function_privilege('authenticated', 'app.set_cash_account_mapping(text, text, uuid, uuid, date, uuid)', 'execute'), 'the public entry points are granted to authenticated');
  perform pg_temp.check(not has_table_privilege('authenticated', 'public.cash_account_mappings', 'insert') and not has_table_privilege('authenticated', 'public.cash_account_mappings', 'update')
    and not has_table_privilege('authenticated', 'public.cash_account_mappings', 'delete') and not has_table_privilege('anon', 'public.cash_account_mappings', 'select'), 'clients hold SELECT only; anon nothing');
  perform pg_temp.check((select relrowsecurity from pg_class where oid = 'public.cash_account_mappings'::regclass), 'RLS is enabled');
  perform pg_temp.expect($q$update public.cash_account_mappings set effective_from = effective_from$q$, '23001', 'the owner cannot UPDATE a mapping either');
  perform pg_temp.expect($q$delete from public.cash_account_mappings$q$, '23001', 'the owner cannot DELETE a mapping either');
  perform pg_temp.check(app.schema_version() >= '20261101110000', 'schema version moved to (or past) this migration');
end $$;
rollback;
