-- P2 cash-control register: accounts, immutable movements, reversal, archive, position, RLS, grants.
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/20261031110000_test_cash_control_register.sql
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
  ('e2000000-0000-4000-8000-000000000001', 'Cash A', 'cash-a-test', 'active'),
  ('e2000000-0000-4000-8000-000000000002', 'Cash B', 'cash-b-test', 'active');
insert into public.subscriptions (organization_id, status, current_period_start, current_period_end)
  select o, 'active', now() - interval '1 day', now() + interval '1 year'
  from (values ('e2000000-0000-4000-8000-000000000001'::uuid), ('e2000000-0000-4000-8000-000000000002'::uuid)) t(o);
insert into public.organization_modules (organization_id, module_id, enabled, source)
  select o, m.id, true, 'override' from public.modules m,
  (values ('e2000000-0000-4000-8000-000000000001'::uuid), ('e2000000-0000-4000-8000-000000000002'::uuid)) t(o);
insert into public.branches (id, organization_id, name, is_default, status) values
  ('e2000000-0000-4000-8000-0000000000e1', 'e2000000-0000-4000-8000-000000000001', 'North', true, 'active'),
  ('e2000000-0000-4000-8000-0000000000e3', 'e2000000-0000-4000-8000-000000000001', 'South', false, 'active'),
  ('e2000000-0000-4000-8000-0000000000e2', 'e2000000-0000-4000-8000-000000000002', 'Main B', true, 'active');
insert into public.roles (id, organization_id, name) values
  ('e2000000-0000-4000-8000-000000000011', 'e2000000-0000-4000-8000-000000000001', 'Pemilik'),
  ('e2000000-0000-4000-8000-000000000012', 'e2000000-0000-4000-8000-000000000001', 'NorthMgr'),
  ('e2000000-0000-4000-8000-000000000013', 'e2000000-0000-4000-8000-000000000001', 'Reader'),
  ('e2000000-0000-4000-8000-000000000014', 'e2000000-0000-4000-8000-000000000001', 'Nothing'),
  ('e2000000-0000-4000-8000-000000000015', 'e2000000-0000-4000-8000-000000000002', 'Pemilik');
insert into public.role_permissions (organization_id, role_id, permission_id)
  select 'e2000000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-000000000011', id from public.permissions
   where key in ('finance.read','finance.manage','branches.all','settings.manage');
insert into public.role_permissions (organization_id, role_id, permission_id)
  select 'e2000000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-000000000012', id from public.permissions
   where key in ('finance.read','finance.manage');
insert into public.role_permissions (organization_id, role_id, permission_id)
  select 'e2000000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-000000000013', id from public.permissions
   where key in ('finance.read','branches.all');
insert into public.role_permissions (organization_id, role_id, permission_id)
  select 'e2000000-0000-4000-8000-000000000002', 'e2000000-0000-4000-8000-000000000015', id from public.permissions
   where key in ('finance.read','finance.manage','branches.all');
insert into auth.users (id, email, raw_user_meta_data) values
  ('e2000000-0000-4000-8000-000000000021', 'owner@cash.test', '{}'),
  ('e2000000-0000-4000-8000-000000000022', 'north@cash.test', '{}'),
  ('e2000000-0000-4000-8000-000000000023', 'reader@cash.test', '{}'),
  ('e2000000-0000-4000-8000-000000000024', 'nothing@cash.test', '{}'),
  ('e2000000-0000-4000-8000-000000000025', 'owner-b@cash.test', '{}');
update public.users set status = 'active' where id::text like 'e2000000-%';
insert into public.memberships (id, user_id, organization_id, role_id, status) values
  ('e2000000-0000-4000-8000-0000000000f1', 'e2000000-0000-4000-8000-000000000021', 'e2000000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-000000000011', 'active'),
  ('e2000000-0000-4000-8000-0000000000f2', 'e2000000-0000-4000-8000-000000000022', 'e2000000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-000000000012', 'active'),
  ('e2000000-0000-4000-8000-0000000000f3', 'e2000000-0000-4000-8000-000000000023', 'e2000000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-000000000013', 'active'),
  ('e2000000-0000-4000-8000-0000000000f4', 'e2000000-0000-4000-8000-000000000024', 'e2000000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-000000000014', 'active'),
  ('e2000000-0000-4000-8000-0000000000f5', 'e2000000-0000-4000-8000-000000000025', 'e2000000-0000-4000-8000-000000000002', 'e2000000-0000-4000-8000-000000000015', 'active');
insert into public.membership_branch_access (organization_id, membership_id, branch_id) values
  ('e2000000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-0000000000f2', 'e2000000-0000-4000-8000-0000000000e1');

-- Existing authoritative rows a movement may point at.
insert into public.expenses (id, organization_id, branch_id, description, amount, currency, incurred_at) values
  ('e2000000-0000-4000-8000-0000000000a1', 'e2000000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-0000000000e1', 'Listrik', 150000, 'IDR', '2026-10-05'),
  ('e2000000-0000-4000-8000-0000000000a2', 'e2000000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-0000000000e3', 'Sewa South', 900000, 'IDR', '2026-10-05'),
  ('e2000000-0000-4000-8000-0000000000a3', 'e2000000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-0000000000e1', 'Alat USD', 10, 'USD', '2026-10-05'),
  ('e2000000-0000-4000-8000-0000000000b1', 'e2000000-0000-4000-8000-000000000002', 'e2000000-0000-4000-8000-0000000000e2', 'Other tenant', 5, 'IDR', '2026-10-05');
insert into public.payments (id, organization_id, branch_id, method, amount, currency, status, paid_at) values
  ('e2000000-0000-4000-8000-0000000000c1', 'e2000000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-0000000000e1', 'cash', 250000, 'IDR', 'succeeded', '2026-10-05 03:00Z'),
  ('e2000000-0000-4000-8000-0000000000c2', 'e2000000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-0000000000e1', 'cash', 111000, 'IDR', 'pending', '2026-10-05 03:00Z');
insert into public.refunds (id, organization_id, payment_id, amount, status, refunded_at) values
  ('e2000000-0000-4000-8000-0000000000d1', 'e2000000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-0000000000c1', 30000, 'succeeded', '2026-10-06 03:00Z');

set local role authenticated;

-- ===== Accounts ========================================================================================================
select pg_temp.act_as('e2000000-0000-4000-8000-000000000021', 'e2000000-0000-4000-8000-000000000001');
create temp table ids (k text primary key, v uuid);
grant all on ids to authenticated;
do $$
begin
  insert into ids values ('kas', app.create_cash_account('Kas toko', 'cash', 'idr', null));
  insert into ids values ('bca', app.create_cash_account('  BCA Operasional ', 'bank', 'IDR', 'e2000000-0000-4000-8000-0000000000e1'));
  insert into ids values ('usd', app.create_cash_account('USD box', 'other', 'USD', null));
  perform pg_temp.check((select currency from public.cash_accounts where id = (select v from ids where k = 'kas')) = 'IDR', 'currency upper-cased and stored once on the account');
  perform pg_temp.check((select name from public.cash_accounts where id = (select v from ids where k = 'bca')) = 'BCA Operasional', 'name trimmed');
  perform pg_temp.expect($q$select app.create_cash_account('kas TOKO', 'cash', 'IDR', null)$q$, '23505', 'duplicate name (case-insensitive) refused');
  perform pg_temp.expect($q$select app.create_cash_account('X', 'crypto', 'IDR', null)$q$, '22023', 'unknown kind refused');
  perform pg_temp.expect($q$select app.create_cash_account('X', 'cash', 'RP', null)$q$, '22023', 'bad currency refused');
  perform pg_temp.expect($q$select app.create_cash_account('', 'cash', 'IDR', null)$q$, '22023', 'empty name refused');
  perform pg_temp.expect($q$select app.create_cash_account(repeat('x', 81), 'cash', 'IDR', null)$q$, '22023', 'overlong name refused');
  perform pg_temp.expect($q$select app.create_cash_account('Foreign', 'cash', 'IDR', 'e2000000-0000-4000-8000-0000000000e2')$q$, 'P0002', 'a branch of another tenant is not found');
end $$;
select pg_temp.act_as('e2000000-0000-4000-8000-000000000022', 'e2000000-0000-4000-8000-000000000001');
do $$ begin
  perform pg_temp.expect($q$select app.create_cash_account('North org-wide', 'cash', 'IDR', null)$q$, '42501', 'branch-limited manager cannot create an organization-wide account');
  perform pg_temp.expect($q$select app.create_cash_account('South acct', 'cash', 'IDR', 'e2000000-0000-4000-8000-0000000000e3')$q$, '42501', 'branch-limited manager cannot create in a branch they lack');
  insert into ids values ('north', app.create_cash_account('North petty', 'cash', 'IDR', 'e2000000-0000-4000-8000-0000000000e1'));
  raise notice 'PASS: branch-limited manager creates an account in their own branch';
end $$;
select pg_temp.act_as('e2000000-0000-4000-8000-000000000021', 'e2000000-0000-4000-8000-000000000001');
do $$ begin
  insert into ids values ('south', app.create_cash_account('South petty', 'cash', 'IDR', 'e2000000-0000-4000-8000-0000000000e3'));
end $$;
select pg_temp.act_as('e2000000-0000-4000-8000-000000000023', 'e2000000-0000-4000-8000-000000000001');
do $$ begin
  perform pg_temp.expect($q$select app.create_cash_account('Reader acct', 'cash', 'IDR', null)$q$, '42501', 'finance.read alone cannot create an account');
end $$;
select pg_temp.act_as('e2000000-0000-4000-8000-000000000024', 'e2000000-0000-4000-8000-000000000001');
do $$ begin
  perform pg_temp.expect($q$select app.create_cash_account('Nothing acct', 'cash', 'IDR', null)$q$, '42501', 'no capability cannot create an account');
  perform pg_temp.check((select count(*) from public.cash_accounts) = 0, 'no capability sees no accounts (RLS)');
  perform pg_temp.expect($q$select * from app.cash_register_position()$q$, '42501', 'no capability: position refused, not an empty zero');
end $$;

-- ===== Movements =======================================================================================================
select pg_temp.act_as('e2000000-0000-4000-8000-000000000021', 'e2000000-0000-4000-8000-000000000001');
do $$
declare kas uuid := (select v from ids where k = 'kas'); usd uuid := (select v from ids where k = 'usd'); bca uuid := (select v from ids where k = 'bca');
  m1 uuid; m2 uuid; m3 uuid; again uuid;
begin
  m1 := app.record_cash_movement(kas, 'opening_balance', 1000000, current_date - 10, null, 'Saldo awal', null, null, 'e2000000-0000-4000-8000-0000000fa001');
  m2 := app.record_cash_movement(kas, 'capital_contribution', 500000, current_date - 9, 'Winston', null, null, null, 'e2000000-0000-4000-8000-0000000fa002');
  m3 := app.record_cash_movement(kas, 'owner_withdrawal', 200000, current_date - 8, 'Henry', 'Prive', null, null, 'e2000000-0000-4000-8000-0000000fa003');
  insert into ids values ('m_open', m1), ('m_cap', m2), ('m_draw', m3);
  perform pg_temp.check((select currency from public.cash_movements where id = m2) = 'IDR' and (select direction from public.cash_movements where id = m3) = 'out',
    'currency comes from the account and direction from the kind');
  -- idempotent replay
  again := app.record_cash_movement(kas, 'capital_contribution', 500000, current_date - 9, 'Winston', null, null, null, 'e2000000-0000-4000-8000-0000000fa002');
  perform pg_temp.check(again = m2 and (select count(*) from public.cash_movements where account_id = kas) = 3, 'replay of the same request key returns the same movement and adds nothing');
  perform pg_temp.expect($q$select app.record_cash_movement((select v from ids where k='kas'), 'capital_contribution', 999, current_date - 9, 'Winston', null, null, null, 'e2000000-0000-4000-8000-0000000fa002')$q$, '22023', 'same key with a different payload is a conflict');
  perform pg_temp.expect($q$select app.record_cash_movement((select v from ids where k='kas'), 'opening_balance', 1, current_date, null, null, null, null, 'e2000000-0000-4000-8000-0000000fa009')$q$, '22023', 'a second live opening balance is refused');
  perform pg_temp.expect($q$select app.record_cash_movement((select v from ids where k='kas'), 'cash_in', 0, current_date, null, null, null, null, gen_random_uuid())$q$, '22023', 'zero amount refused');
  perform pg_temp.expect($q$select app.record_cash_movement((select v from ids where k='kas'), 'cash_in', -5, current_date, null, null, null, null, gen_random_uuid())$q$, '22023', 'negative amount refused');
  perform pg_temp.expect($q$select app.record_cash_movement((select v from ids where k='kas'), 'cash_in', 10.005, current_date, null, null, null, null, gen_random_uuid())$q$, '22023', 'more than two decimals refused');
  perform pg_temp.expect($q$select app.record_cash_movement((select v from ids where k='kas'), 'cash_in', 1000000000000, current_date, null, null, null, null, gen_random_uuid())$q$, '22023', 'amount beyond the column range refused');
  perform pg_temp.expect($q$select app.record_cash_movement((select v from ids where k='kas'), 'cash_in', 5, current_date + 5, null, null, null, null, gen_random_uuid())$q$, '22023', 'future date refused');
  perform pg_temp.expect($q$select app.record_cash_movement((select v from ids where k='kas'), 'capital_contribution', 5, current_date, null, null, null, null, gen_random_uuid())$q$, '22023', 'capital without a named contributor refused');
  perform pg_temp.expect($q$select app.record_cash_movement((select v from ids where k='kas'), 'reversal', 5, current_date, null, 'x', null, null, gen_random_uuid())$q$, '22023', 'reversal cannot be posted as a plain movement');
  perform pg_temp.expect($q$select app.record_cash_movement((select v from ids where k='kas'), 'cash_in', 5, current_date, null, E'bad\x01memo', null, null, gen_random_uuid())$q$, '22023', 'control characters refused');
  perform pg_temp.expect($q$select app.record_cash_movement(gen_random_uuid(), 'cash_in', 5, current_date, null, null, null, null, gen_random_uuid())$q$, 'P0002', 'unknown account not found');

  -- source links
  m1 := app.record_cash_movement(kas, 'cash_out', 150000, current_date - 5, null, 'Bayar listrik', 'expense', 'e2000000-0000-4000-8000-0000000000a1', 'e2000000-0000-4000-8000-0000000fa101');
  insert into ids values ('m_exp', m1);
  m2 := app.record_cash_movement(kas, 'cash_in', 250000, current_date - 5, null, null, 'payment', 'e2000000-0000-4000-8000-0000000000c1', 'e2000000-0000-4000-8000-0000000fa102');
  m3 := app.record_cash_movement(kas, 'cash_out', 30000, current_date - 4, null, null, 'refund', 'e2000000-0000-4000-8000-0000000000d1', 'e2000000-0000-4000-8000-0000000fa103');
  perform pg_temp.check((select source_type from public.cash_movements where id = m1) = 'expense' and (select source_type from public.cash_movements where id = m3) = 'refund', 'movements link to an existing expense, payment and refund');
  perform pg_temp.expect($q$select app.record_cash_movement((select v from ids where k='kas'), 'cash_out', 150000, current_date, null, null, 'expense', 'e2000000-0000-4000-8000-0000000000a1', gen_random_uuid())$q$, '22023', 'the same source cannot be linked twice');
  perform pg_temp.expect($q$select app.record_cash_movement((select v from ids where k='kas'), 'cash_in', 5, current_date, null, null, 'expense', 'e2000000-0000-4000-8000-0000000000a1', gen_random_uuid())$q$, '22023', 'an expense can only be money out');
  perform pg_temp.expect($q$select app.record_cash_movement((select v from ids where k='kas'), 'cash_out', 5, current_date, null, null, 'payment', 'e2000000-0000-4000-8000-0000000000c1', gen_random_uuid())$q$, '22023', 'a payment can only be money in');
  perform pg_temp.expect($q$select app.record_cash_movement((select v from ids where k='kas'), 'capital_contribution', 5, current_date, 'W', null, 'payment', 'e2000000-0000-4000-8000-0000000000c1', gen_random_uuid())$q$, '22023', 'capital cannot carry a source link');
  perform pg_temp.expect($q$select app.record_cash_movement((select v from ids where k='kas'), 'cash_in', 5, current_date, null, null, 'payment', 'e2000000-0000-4000-8000-0000000000c2', gen_random_uuid())$q$, 'P0002', 'a pending payment is not a source');
  perform pg_temp.expect($q$select app.record_cash_movement((select v from ids where k='kas'), 'cash_out', 5, current_date, null, null, 'expense', 'e2000000-0000-4000-8000-0000000000b1', gen_random_uuid())$q$, 'P0002', 'another tenant''s expense is not found');
  perform pg_temp.expect($q$select app.record_cash_movement((select v from ids where k='kas'), 'cash_out', 5, current_date, null, null, 'expense', 'e2000000-0000-4000-8000-0000000000a3', gen_random_uuid())$q$, '22023', 'a USD expense cannot be linked to an IDR account');
  perform pg_temp.expect($q$select app.record_cash_movement((select v from ids where k='kas'), 'cash_out', 5, current_date, null, null, 'bribe', gen_random_uuid(), gen_random_uuid())$q$, '22023', 'unknown source type refused');
  perform pg_temp.expect($q$select app.record_cash_movement((select v from ids where k='kas'), 'cash_out', 5, current_date, null, null, 'expense', null, gen_random_uuid())$q$, '22023', 'source type without id refused');
  -- the USD account stays in USD, never merged
  perform app.record_cash_movement(usd, 'opening_balance', 100, current_date - 3, null, null, null, null, 'e2000000-0000-4000-8000-0000000fa201');
  perform app.record_cash_movement(usd, 'cash_out', 10, current_date - 2, null, null, 'expense', 'e2000000-0000-4000-8000-0000000000a3', 'e2000000-0000-4000-8000-0000000fa202');
  perform app.record_cash_movement(bca, 'opening_balance', 7000000, current_date - 3, null, null, null, null, 'e2000000-0000-4000-8000-0000000fa301');
end $$;

-- ===== Position =========================================================================================================
do $$
declare r record;
begin
  select * into r from app.cash_register_position() where account_name = 'Kas toko';
  -- 1,000,000 + 500,000 - 200,000 - 150,000 + 250,000 - 30,000
  perform pg_temp.check(r.balance = 1370000 and r.total_in = 1750000 and r.total_out = 380000 and r.movement_count = 6, 'Kas toko balance = in - out over its own movements');
  perform pg_temp.check(r.currency = 'IDR' and r.version = 1, 'position carries the account currency and version');
  select * into r from app.cash_register_position() where account_name = 'USD box';
  perform pg_temp.check(r.balance = 90 and r.currency = 'USD', 'USD account is its own currency');
  select * into r from app.cash_register_position(current_date - 9) where account_name = 'Kas toko';
  perform pg_temp.check(r.balance = 1500000 and r.movement_count = 2, 'as-of date limits to movements on or before it');
  perform pg_temp.check((select count(*) from app.cash_register_position()) = 5, 'owner sees all five accounts');
  perform pg_temp.expect($q$select * from app.cash_register_position(date '1999-01-01')$q$, '22023', 'out-of-range as-of date refused');
end $$;

-- ===== Reversal ============================================================================================================
do $$
declare kas uuid := (select v from ids where k = 'kas'); rv uuid; r record;
begin
  rv := app.reverse_cash_movement((select v from ids where k = 'm_draw'), 'Salah catat prive', current_date, 'e2000000-0000-4000-8000-0000000fb001');
  select * into r from public.cash_movements where id = rv;
  perform pg_temp.check(r.kind = 'reversal' and r.direction = 'in' and r.amount = 200000 and r.reversal_of = (select v from ids where k = 'm_draw') and r.memo = 'Salah catat prive', 'reversal is the opposite entry of the same amount and carries the reason');
  perform pg_temp.check((select balance from app.cash_register_position() where account_id = kas) = 1570000, 'balance restored by the reversal');
  perform pg_temp.check(app.reverse_cash_movement((select v from ids where k = 'm_draw'), 'Salah catat prive', current_date, 'e2000000-0000-4000-8000-0000000fb001') = rv, 'replay of the reversal request is idempotent');
  perform pg_temp.expect($q$select app.reverse_cash_movement((select v from ids where k='m_draw'), 'again', current_date, gen_random_uuid())$q$, '22023', 'a movement is reversed once');
  perform pg_temp.expect($q$select app.reverse_cash_movement((select id from public.cash_movements where reversal_of is not null limit 1), 'undo undo', current_date, gen_random_uuid())$q$, '22023', 'a reversal cannot be reversed');
  perform pg_temp.expect($q$select app.reverse_cash_movement((select v from ids where k='m_cap'), 'xx', current_date, gen_random_uuid())$q$, '22023', 'reason shorter than three characters refused');
  perform pg_temp.expect($q$select app.reverse_cash_movement((select v from ids where k='m_cap'), 'Alasan', current_date - 30, gen_random_uuid())$q$, '22023', 'reversal dated before the original refused');
  perform pg_temp.expect($q$select app.reverse_cash_movement(gen_random_uuid(), 'Alasan', current_date, gen_random_uuid())$q$, 'P0002', 'unknown movement not found');
  -- reversing the expense-linked movement frees the source for a corrected re-link
  perform app.reverse_cash_movement((select v from ids where k = 'm_exp'), 'Salah akun', current_date, 'e2000000-0000-4000-8000-0000000fb002');
  perform app.record_cash_movement((select v from ids where k = 'usd'), 'cash_in', 1, current_date, null, null, null, null, gen_random_uuid());
  perform pg_temp.expect($q$select app.record_cash_movement((select v from ids where k='usd'), 'cash_out', 150000, current_date, null, null, 'expense', 'e2000000-0000-4000-8000-0000000000a1', gen_random_uuid())$q$, '22023', 'relinking to a different-currency account still refused');
  perform app.record_cash_movement(kas, 'cash_out', 150000, current_date, null, 'Relink', 'expense', 'e2000000-0000-4000-8000-0000000000a1', 'e2000000-0000-4000-8000-0000000fb003');
  perform pg_temp.check(true, 'after reversal the same source can be linked again');
end $$;

-- ===== Immutability ============================================================================================================
do $$ begin
  perform pg_temp.expect($q$update public.cash_movements set amount = 1$q$, '42501', 'authenticated cannot UPDATE movements directly');
  perform pg_temp.expect($q$delete from public.cash_movements$q$, '42501', 'authenticated cannot DELETE movements directly');
  perform pg_temp.expect($q$insert into public.cash_movements(organization_id, account_id, kind, direction, amount, currency, occurred_on, request_key) values (app.fn_active_organization(), gen_random_uuid(), 'cash_in', 'in', 1, 'IDR', current_date, gen_random_uuid())$q$, '42501', 'authenticated cannot INSERT movements directly');
  perform pg_temp.expect($q$update public.cash_accounts set currency = 'USD'$q$, '42501', 'authenticated cannot UPDATE accounts directly');
  perform pg_temp.expect($q$insert into public.cash_accounts(organization_id, name, kind, currency) values (app.fn_active_organization(), 'Z', 'cash', 'IDR')$q$, '42501', 'authenticated cannot INSERT accounts directly');
end $$;
reset role;
do $$ begin
  perform pg_temp.expect($q$update public.cash_movements set amount = 1$q$, '23001', 'even the table owner cannot UPDATE a movement (trigger)');
  perform pg_temp.expect($q$delete from public.cash_movements$q$, '23001', 'even the table owner cannot DELETE a movement (trigger)');
  perform pg_temp.check((select count(*) from app.audit_log where entity_table = 'cash_movements' and action = 'INSERT') >= 10, 'every movement insert is audited');
  perform pg_temp.check((select count(*) from app.audit_log where entity_table = 'cash_accounts' and action = 'INSERT') = 5, 'every account creation is audited');
end $$;
set local role authenticated;

-- ===== Archive ===================================================================================================================
select pg_temp.act_as('e2000000-0000-4000-8000-000000000021', 'e2000000-0000-4000-8000-000000000001');
do $$
declare south uuid := (select v from ids where k = 'south'); kas uuid := (select v from ids where k = 'kas'); ver integer;
begin
  perform pg_temp.expect($q$select app.set_cash_account_archived((select v from ids where k='kas'), true, 1)$q$, '22023', 'archiving an account with a balance is refused');
  perform pg_temp.expect($q$select app.set_cash_account_archived((select v from ids where k='south'), true, 9)$q$, '40001', 'stale version refused');
  ver := app.set_cash_account_archived(south, true, 1);
  perform pg_temp.check(ver = 2 and (select status from public.cash_accounts where id = south) = 'archived', 'a zero-balance account archives and the version moves');
  perform pg_temp.check(app.set_cash_account_archived(south, true, 2) = 2, 'archiving again is a no-op');
  perform pg_temp.expect($q$select app.record_cash_movement((select v from ids where k='south'), 'cash_in', 5, current_date, null, null, null, null, gen_random_uuid())$q$, '22023', 'an archived account takes no movements');
  ver := app.set_cash_account_archived(south, false, 2);
  perform pg_temp.check(ver = 3, 'unarchive moves the version again');
  perform pg_temp.expect($q$select app.set_cash_account_archived(gen_random_uuid(), true, 1)$q$, 'P0002', 'unknown account not found');
end $$;

-- ===== Branch and tenant isolation ================================================================================================
select pg_temp.act_as('e2000000-0000-4000-8000-000000000022', 'e2000000-0000-4000-8000-000000000001');
do $$
declare north uuid := (select v from ids where k = 'north'); r record;
begin
  perform pg_temp.check((select count(*) from public.cash_accounts) = 4, 'north-limited manager sees org-wide accounts plus north, never south (Kas, USD, BCA north, North petty)');
  perform pg_temp.check(not exists (select 1 from public.cash_accounts where name in ('South petty')), 'south account invisible');
  perform pg_temp.check(not exists (select 1 from public.cash_movements where account_id = (select v from ids where k = 'south')), 'south movements invisible');
  perform pg_temp.check((select count(*) from app.cash_register_position()) = 4, 'position lists only visible accounts');
  perform pg_temp.check(app.record_cash_movement(north, 'opening_balance', 5000, current_date, null, null, null, null, 'e2000000-0000-4000-8000-0000000fc001') is not null, 'manager posts to an account of their own branch');
  perform pg_temp.expect($q$select app.record_cash_movement((select v from ids where k='kas'), 'cash_in', 5, current_date, null, null, null, null, gen_random_uuid())$q$, '42501', 'branch-limited manager cannot post to an organization-wide account');
  perform pg_temp.expect($q$select app.record_cash_movement((select v from ids where k='south'), 'cash_in', 5, current_date, null, null, null, null, gen_random_uuid())$q$, 'P0002', 'south account is not found for a north-only manager');
  perform pg_temp.expect($q$select app.reverse_cash_movement((select v from ids where k='m_cap'), 'Alasan', current_date, gen_random_uuid())$q$, '42501', 'branch-limited manager cannot reverse an organization-wide movement');
  perform pg_temp.expect($q$select app.record_cash_movement((select v from ids where k='north'), 'cash_out', 5, current_date, null, null, 'expense', 'e2000000-0000-4000-8000-0000000000a2', gen_random_uuid())$q$, 'P0002', 'an expense of a branch the manager cannot see is not a valid source');
end $$;
select pg_temp.act_as('e2000000-0000-4000-8000-000000000023', 'e2000000-0000-4000-8000-000000000001');
do $$ begin
  perform pg_temp.check((select count(*) from app.cash_register_position()) = 5, 'finance.read + branches.all reads every account');
  perform pg_temp.expect($q$select app.record_cash_movement((select v from ids where k='kas'), 'cash_in', 5, current_date, null, null, null, null, gen_random_uuid())$q$, '42501', 'reader cannot post');
  perform pg_temp.expect($q$select app.reverse_cash_movement((select v from ids where k='m_cap'), 'Alasan', current_date, gen_random_uuid())$q$, '42501', 'reader cannot reverse');
  perform pg_temp.expect($q$select app.set_cash_account_archived((select v from ids where k='usd'), true, 1)$q$, '42501', 'reader cannot archive');
end $$;
select pg_temp.act_as('e2000000-0000-4000-8000-000000000025', 'e2000000-0000-4000-8000-000000000002');
do $$ begin
  perform pg_temp.check((select count(*) from public.cash_accounts) = 0 and (select count(*) from public.cash_movements) = 0, 'tenant B sees none of tenant A');
  perform pg_temp.check((select count(*) from app.cash_register_position()) = 0, 'tenant B position is empty (measured, not hidden)');
  perform pg_temp.expect($q$select app.record_cash_movement((select v from ids where k='kas'), 'cash_in', 5, current_date, null, null, null, null, gen_random_uuid())$q$, 'P0002', 'tenant B cannot post to tenant A''s account');
  perform pg_temp.expect($q$select app.reverse_cash_movement((select v from ids where k='m_cap'), 'Alasan', current_date, gen_random_uuid())$q$, 'P0002', 'tenant B cannot reverse tenant A''s movement');
  perform pg_temp.expect($q$select app.set_cash_account_archived((select v from ids where k='usd'), true, 1)$q$, 'P0002', 'tenant B cannot archive tenant A''s account');
  perform pg_temp.check(app.create_cash_account('Kas toko', 'cash', 'IDR', null) is not null, 'the same account name is free in another tenant');
end $$;
select pg_temp.act_as('e2000000-0000-4000-8000-000000000021', 'e2000000-0000-4000-8000-000000000002');
do $$ begin
  perform pg_temp.expect($q$select app.create_cash_account('Forged', 'cash', 'IDR', null)$q$, '42501', 'forged active organization refused');
  perform pg_temp.expect($q$select * from app.cash_register_position()$q$, '42501', 'forged active organization: position refused');
end $$;

-- ===== Grants / structure ==========================================================================================================
reset role;
do $$
declare f text; v_def boolean; v_cfg text[];
begin
  foreach f in array array['create_cash_account','record_cash_movement','reverse_cash_movement','set_cash_account_archived','cash_register_position'] loop
    select p.prosecdef, p.proconfig into v_def, v_cfg from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'app' and p.proname = f;
    perform pg_temp.check(v_def and v_cfg && array['search_path=""', 'search_path='], f || ' is SECURITY DEFINER with an empty search_path');
  end loop;
  perform pg_temp.check(not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
     where n.nspname = 'app' and p.proname in ('create_cash_account','record_cash_movement','reverse_cash_movement','set_cash_account_archived','cash_register_position','tg_cash_movements_immutable')
       and (a.grantee = 0 or a.grantee = 'anon'::regrole)), 'anon and PUBLIC cannot execute any register function');
  perform pg_temp.check(not has_function_privilege('authenticated', 'app.tg_cash_movements_immutable()', 'execute'), 'the trigger function is not client-callable');
  perform pg_temp.check(not has_table_privilege('authenticated', 'public.cash_movements', 'insert') and not has_table_privilege('authenticated', 'public.cash_movements', 'update')
    and not has_table_privilege('authenticated', 'public.cash_accounts', 'update') and not has_table_privilege('anon', 'public.cash_movements', 'select'), 'clients hold SELECT only; anon nothing');
  perform pg_temp.check((select relrowsecurity from pg_class where oid = 'public.cash_movements'::regclass) and (select relrowsecurity from pg_class where oid = 'public.cash_accounts'::regclass), 'RLS on both tables');
  perform pg_temp.check(app.schema_version() >= '20261031110000', 'schema version moved to (or past) this migration');
end $$;
rollback;
