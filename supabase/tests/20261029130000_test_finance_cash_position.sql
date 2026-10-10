-- E2.2 cash position: currency separation, refunds, period/time-zone boundaries, branch scope, tenant isolation.
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/20261029130000_test_finance_cash_position.sql
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

begin;
insert into public.organizations (id, name, slug, status) values
  ('c4f00000-0000-4000-8000-000000000001', 'Cash A', 'cash-a-test', 'active'),
  ('c4f00000-0000-4000-8000-000000000002', 'Cash B', 'cash-b-test', 'active');
insert into public.subscriptions (organization_id, status, current_period_start, current_period_end)
  select o, 'active', now() - interval '1 day', now() + interval '1 year'
  from (values ('c4f00000-0000-4000-8000-000000000001'::uuid), ('c4f00000-0000-4000-8000-000000000002'::uuid)) t(o);
insert into public.organization_modules (organization_id, module_id, enabled, source)
  select o, m.id, true, 'override' from public.modules m,
  (values ('c4f00000-0000-4000-8000-000000000001'::uuid), ('c4f00000-0000-4000-8000-000000000002'::uuid)) t(o);
insert into public.branches (id, organization_id, name, is_default, status) values
  ('c4f00000-0000-4000-8000-0000000000e1', 'c4f00000-0000-4000-8000-000000000001', 'North', true, 'active'),
  ('c4f00000-0000-4000-8000-0000000000e3', 'c4f00000-0000-4000-8000-000000000001', 'South', false, 'active'),
  ('c4f00000-0000-4000-8000-0000000000e2', 'c4f00000-0000-4000-8000-000000000002', 'Main B', true, 'active');
insert into public.roles (id, organization_id, name) values
  ('c4f00000-0000-4000-8000-000000000011', 'c4f00000-0000-4000-8000-000000000001', 'Pemilik'),
  ('c4f00000-0000-4000-8000-000000000012', 'c4f00000-0000-4000-8000-000000000001', 'NorthFinance'),
  ('c4f00000-0000-4000-8000-000000000013', 'c4f00000-0000-4000-8000-000000000001', 'NoFinance'),
  ('c4f00000-0000-4000-8000-000000000014', 'c4f00000-0000-4000-8000-000000000002', 'Pemilik');
insert into public.role_permissions (organization_id, role_id, permission_id)
  select 'c4f00000-0000-4000-8000-000000000001', 'c4f00000-0000-4000-8000-000000000011', id from public.permissions where key in ('finance.read','branches.all');
insert into public.role_permissions (organization_id, role_id, permission_id)
  select 'c4f00000-0000-4000-8000-000000000001', 'c4f00000-0000-4000-8000-000000000012', id from public.permissions where key in ('finance.read');
insert into public.role_permissions (organization_id, role_id, permission_id)
  select 'c4f00000-0000-4000-8000-000000000001', 'c4f00000-0000-4000-8000-000000000013', id from public.permissions where key in ('booking.read');
insert into public.role_permissions (organization_id, role_id, permission_id)
  select 'c4f00000-0000-4000-8000-000000000002', 'c4f00000-0000-4000-8000-000000000014', id from public.permissions where key in ('finance.read','branches.all');
insert into auth.users (id, email, raw_user_meta_data) values
  ('c4f00000-0000-4000-8000-000000000021', 'owner-a@cash.test', '{}'),
  ('c4f00000-0000-4000-8000-000000000022', 'north@cash.test', '{}'),
  ('c4f00000-0000-4000-8000-000000000023', 'nofin@cash.test', '{}'),
  ('c4f00000-0000-4000-8000-000000000024', 'owner-b@cash.test', '{}');
update public.users set status = 'active' where id::text like 'c4f00000-%';
insert into public.memberships (id, user_id, organization_id, role_id, status) values
  ('c4f00000-0000-4000-8000-0000000000f1', 'c4f00000-0000-4000-8000-000000000021', 'c4f00000-0000-4000-8000-000000000001', 'c4f00000-0000-4000-8000-000000000011', 'active'),
  ('c4f00000-0000-4000-8000-0000000000f2', 'c4f00000-0000-4000-8000-000000000022', 'c4f00000-0000-4000-8000-000000000001', 'c4f00000-0000-4000-8000-000000000012', 'active'),
  ('c4f00000-0000-4000-8000-0000000000f3', 'c4f00000-0000-4000-8000-000000000023', 'c4f00000-0000-4000-8000-000000000001', 'c4f00000-0000-4000-8000-000000000013', 'active'),
  ('c4f00000-0000-4000-8000-0000000000f4', 'c4f00000-0000-4000-8000-000000000024', 'c4f00000-0000-4000-8000-000000000002', 'c4f00000-0000-4000-8000-000000000014', 'active');
insert into public.membership_branch_access (organization_id, membership_id, branch_id) values
  ('c4f00000-0000-4000-8000-000000000001', 'c4f00000-0000-4000-8000-0000000000f2', 'c4f00000-0000-4000-8000-0000000000e1');

-- Payments (immutable table: insert as owner). Asia/Jakarta is UTC+7, so 2026-09-30 17:30Z is 01 Oct 00:30 local.
insert into public.payments (id, organization_id, branch_id, method, amount, currency, status, paid_at) values
  ('c4f00000-0000-4000-8000-00000000a001', 'c4f00000-0000-4000-8000-000000000001', 'c4f00000-0000-4000-8000-0000000000e1', 'cash',          100000, 'IDR', 'succeeded', '2026-10-05 03:00Z'),
  ('c4f00000-0000-4000-8000-00000000a002', 'c4f00000-0000-4000-8000-000000000001', 'c4f00000-0000-4000-8000-0000000000e1', 'bank_transfer', 250000, 'IDR', 'succeeded', '2026-10-20 03:00Z'),
  ('c4f00000-0000-4000-8000-00000000a003', 'c4f00000-0000-4000-8000-000000000001', 'c4f00000-0000-4000-8000-0000000000e1', 'card',             40, 'USD', 'succeeded', '2026-10-06 03:00Z'),
  ('c4f00000-0000-4000-8000-00000000a004', 'c4f00000-0000-4000-8000-000000000001', 'c4f00000-0000-4000-8000-0000000000e3', 'cash',          900000, 'IDR', 'succeeded', '2026-10-07 03:00Z'),
  ('c4f00000-0000-4000-8000-00000000a005', 'c4f00000-0000-4000-8000-000000000001', 'c4f00000-0000-4000-8000-0000000000e1', 'cash',          777000, 'IDR', 'pending',   '2026-10-08 03:00Z'),
  ('c4f00000-0000-4000-8000-00000000a006', 'c4f00000-0000-4000-8000-000000000001', 'c4f00000-0000-4000-8000-0000000000e1', 'cash',          555000, 'IDR', 'failed',    '2026-10-09 03:00Z'),
  -- tz boundary: 30 Sep 17:30Z is already October in Jakarta, and 31 Oct 17:30Z is already November.
  ('c4f00000-0000-4000-8000-00000000a007', 'c4f00000-0000-4000-8000-000000000001', 'c4f00000-0000-4000-8000-0000000000e1', 'cash',           10000, 'IDR', 'succeeded', '2026-09-30 17:30Z'),
  ('c4f00000-0000-4000-8000-00000000a008', 'c4f00000-0000-4000-8000-000000000001', 'c4f00000-0000-4000-8000-0000000000e1', 'cash',           20000, 'IDR', 'succeeded', '2026-10-31 17:30Z'),
  ('c4f00000-0000-4000-8000-00000000a009', 'c4f00000-0000-4000-8000-000000000002', 'c4f00000-0000-4000-8000-0000000000e2', 'cash',         5000000, 'IDR', 'succeeded', '2026-10-05 03:00Z');
insert into public.refunds (id, organization_id, payment_id, amount, status, refunded_at) values
  ('c4f00000-0000-4000-8000-00000000b001', 'c4f00000-0000-4000-8000-000000000001', 'c4f00000-0000-4000-8000-00000000a001', 30000, 'succeeded', '2026-10-10 03:00Z'),
  ('c4f00000-0000-4000-8000-00000000b002', 'c4f00000-0000-4000-8000-000000000001', 'c4f00000-0000-4000-8000-00000000a003',     5, 'succeeded', '2026-10-11 03:00Z'),
  ('c4f00000-0000-4000-8000-00000000b003', 'c4f00000-0000-4000-8000-000000000001', 'c4f00000-0000-4000-8000-00000000a004', 100000, 'succeeded', '2026-10-12 03:00Z'),
  ('c4f00000-0000-4000-8000-00000000b004', 'c4f00000-0000-4000-8000-000000000001', 'c4f00000-0000-4000-8000-00000000a002', 99999, 'failed',    '2026-10-13 03:00Z'),
  -- refund in a later month for a payment in October: counted in its own refund month.
  ('c4f00000-0000-4000-8000-00000000b005', 'c4f00000-0000-4000-8000-000000000001', 'c4f00000-0000-4000-8000-00000000a002', 50000, 'succeeded', '2026-11-02 03:00Z');
insert into public.expenses (id, organization_id, branch_id, description, amount, currency, status, incurred_at, deleted_at) values
  ('c4f00000-0000-4000-8000-00000000c001', 'c4f00000-0000-4000-8000-000000000001', 'c4f00000-0000-4000-8000-0000000000e1', '=cmd|calc', 70000, 'IDR', 'recorded', '2026-10-15', null),
  ('c4f00000-0000-4000-8000-00000000c002', 'c4f00000-0000-4000-8000-000000000001', 'c4f00000-0000-4000-8000-0000000000e3', 'south rent', 300000, 'IDR', 'approved', '2026-10-16', null),
  ('c4f00000-0000-4000-8000-00000000c003', 'c4f00000-0000-4000-8000-000000000001', null, 'org-wide', 15000, 'IDR', 'reimbursed', '2026-10-17', null),
  ('c4f00000-0000-4000-8000-00000000c004', 'c4f00000-0000-4000-8000-000000000001', 'c4f00000-0000-4000-8000-0000000000e1', 'deleted', 999999, 'IDR', 'recorded', '2026-10-18', now()),
  ('c4f00000-0000-4000-8000-00000000c005', 'c4f00000-0000-4000-8000-000000000001', 'c4f00000-0000-4000-8000-0000000000e1', 'usd tool', 12, 'USD', 'recorded', '2026-10-19', null),
  ('c4f00000-0000-4000-8000-00000000c006', 'c4f00000-0000-4000-8000-000000000001', 'c4f00000-0000-4000-8000-0000000000e1', 'sept', 1000, 'IDR', 'recorded', '2026-09-30', null);

set local role authenticated;
select pg_temp.act_as('c4f00000-0000-4000-8000-000000000021', 'c4f00000-0000-4000-8000-000000000001');
do $$
declare r record; n integer;
begin
  -- October 2026 in Jakarta, all branches.
  select * into r from app.finance_cash_position('2026-10-01', '2026-10-31', 'Asia/Jakarta') where period = '2026-10' and currency = 'IDR';
  -- IDR payments: 100000 + 250000 + 900000 + 10000 (30 Sep 17:30Z = 1 Oct local) + 20000? (31 Oct 17:30Z = 1 Nov local -> excluded)
  if r.payments_in <> 1260000 or r.payments_count <> 4 then raise exception 'FAIL IDR payments: % / %', r.payments_in, r.payments_count; end if;
  if r.refunds_out <> 130000 or r.refunds_count <> 2 then raise exception 'FAIL IDR refunds (failed and Nov refunds excluded): % / %', r.refunds_out, r.refunds_count; end if;
  if r.expenses_out <> 385000 or r.expenses_count <> 3 then raise exception 'FAIL IDR expenses (deleted/Sept excluded): % / %', r.expenses_out, r.expenses_count; end if;
  if r.net <> 1260000 - 130000 - 385000 then raise exception 'FAIL IDR net %', r.net; end if;
  if r.excluded_payments <> 2 then raise exception 'FAIL excluded pending/failed payments %', r.excluded_payments; end if;
  raise notice 'PASS: IDR october totals, tz boundary, failed/deleted/other-month exclusion';

  -- USD is its own row, never merged with IDR; refund currency comes from the payment.
  select * into r from app.finance_cash_position('2026-10-01', '2026-10-31', 'Asia/Jakarta') where period = '2026-10' and currency = 'USD';
  if r.payments_in <> 40 or r.refunds_out <> 5 or r.expenses_out <> 12 or r.net <> 23 then raise exception 'FAIL USD row %', row_to_json(r); end if;
  select count(*) into n from app.finance_cash_position('2026-10-01', '2026-10-31', 'Asia/Jakarta') where period = '2026-10';
  if n <> 2 then raise exception 'FAIL expected exactly 2 currency rows, got %', n; end if;
  raise notice 'PASS: mixed currency kept separate';

  -- Multi-month window: November has the 20000 payment (Jakarta) and the late refund.
  select * into r from app.finance_cash_position('2026-09-01', '2026-11-30', 'Asia/Jakarta') where period = '2026-11' and currency = 'IDR';
  if r.payments_in <> 20000 or r.refunds_out <> 50000 or r.net <> -30000 then raise exception 'FAIL november %', row_to_json(r); end if;
  select * into r from app.finance_cash_position('2026-09-01', '2026-11-30', 'Asia/Jakarta') where period = '2026-09' and currency = 'IDR';
  if r.payments_in <> 0 or r.expenses_out <> 1000 then raise exception 'FAIL september (expense only) %', row_to_json(r); end if;
  if (select count(*) from app.finance_cash_position('2026-09-01', '2026-11-30', 'Asia/Jakarta')) <> 4 then raise exception 'FAIL multi-month row count'; end if;
  raise notice 'PASS: multi-month grouping; refunds counted in the month they were refunded';

  -- Same instants in UTC shift the boundary payments.
  select * into r from app.finance_cash_position('2026-10-01', '2026-10-31', 'UTC') where period = '2026-10' and currency = 'IDR';
  if r.payments_in <> 100000 + 250000 + 900000 + 20000 then raise exception 'FAIL UTC boundary %', r.payments_in; end if;
  raise notice 'PASS: period boundaries follow the requested time zone';

  -- Empty period: no rows at all (the UI states "no activity", it never invents zero rows).
  if (select count(*) from app.finance_cash_position('2025-01-01', '2025-01-31', 'Asia/Jakarta')) <> 0 then raise exception 'FAIL empty period'; end if;
  raise notice 'PASS: empty period returns nothing';

  perform pg_temp.expect($q$select * from app.finance_cash_position('2026-10-31', '2026-10-01')$q$, '22023', 'reversed period rejected');
  perform pg_temp.expect($q$select * from app.finance_cash_position('2025-01-01', '2026-10-31')$q$, '22023', 'period longer than 366 days rejected');
  perform pg_temp.expect($q$select * from app.finance_cash_position(null, '2026-10-31')$q$, '22023', 'null period rejected');
  perform pg_temp.expect($q$select * from app.finance_cash_position('2026-10-01', '2026-10-31', 'Mars/Olympus')$q$, '22023', 'unknown time zone rejected');
  perform pg_temp.expect($q$select * from app.finance_cash_position('1999-01-01', '1999-02-01')$q$, '22023', 'out-of-range dates rejected');
end $$;

-- Branch scope: finance.read limited to North only sees North payments/expenses, and refunds only through visible payments.
select pg_temp.act_as('c4f00000-0000-4000-8000-000000000022', 'c4f00000-0000-4000-8000-000000000001');
do $$
declare r record;
begin
  select * into r from app.finance_cash_position('2026-10-01', '2026-10-31', 'Asia/Jakarta') where period = '2026-10' and currency = 'IDR';
  -- North-only IDR payments: 100000 + 250000 + 10000 ; refunds: 30000 (a001) ; expenses: 70000 + 15000(org-wide, branch null)
  if r.payments_in <> 360000 then raise exception 'FAIL branch-scoped payments %', r.payments_in; end if;
  if r.refunds_out <> 30000 then raise exception 'FAIL refund of an invisible (South) payment leaked: %', r.refunds_out; end if;
  if r.expenses_out <> 85000 then raise exception 'FAIL branch-scoped expenses %', r.expenses_out; end if;
  raise notice 'PASS: branch-restricted user sees only own branches; invisible-payment refunds do not leak';
end $$;

-- A role without finance.read is refused loudly (not an RLS-emptied zero).
select pg_temp.act_as('c4f00000-0000-4000-8000-000000000023', 'c4f00000-0000-4000-8000-000000000001');
do $$ begin
  perform pg_temp.expect($q$select * from app.finance_cash_position('2026-10-01', '2026-10-31')$q$, '42501', 'role without finance.read refused');
end $$;

-- Tenant isolation: org B sees only its own money; a forged org claim sees nothing / is refused.
select pg_temp.act_as('c4f00000-0000-4000-8000-000000000024', 'c4f00000-0000-4000-8000-000000000002');
do $$
declare r record;
begin
  select * into r from app.finance_cash_position('2026-10-01', '2026-10-31') where currency = 'IDR';
  if r.payments_in <> 5000000 or r.refunds_out <> 0 or r.expenses_out <> 0 then raise exception 'FAIL org B totals %', row_to_json(r); end if;
  raise notice 'PASS: tenant B sees only tenant B money';
end $$;
select pg_temp.act_as('c4f00000-0000-4000-8000-000000000024', 'c4f00000-0000-4000-8000-000000000001');
do $$ begin
  perform pg_temp.expect($q$select * from app.finance_cash_position('2026-10-01', '2026-10-31')$q$, '42501', 'forged active organization refused');
end $$;

reset role;
do $$ declare v_before bigint; begin
  select count(*) into v_before from public.payments;
  -- The function is read-only: STABLE, invoker, no ledger table added.
  if (select provolatile from pg_proc where proname = 'finance_cash_position') <> 's' or (select prosecdef from pg_proc where proname = 'finance_cash_position') then
    raise exception 'FAIL function must be stable security invoker'; end if;
  if has_function_privilege('anon', 'app.finance_cash_position(date,date,text)', 'execute') or has_function_privilege('public', 'app.finance_cash_position(date,date,text)', 'execute') then
    raise exception 'FAIL anon/public grant'; end if;
  raise notice 'PASS: read-only (stable, invoker) and not callable by anon/public';
end $$;
rollback;
