-- Performance dashboard: card allowlist, period contract, operations / finance / source aggregates.
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/20261030100000_test_performance_dashboard.sql
-- Fixture time zone is Asia/Jakarta (UTC+7). Current period 2026-10-01..2026-10-10, previous 2026-09-21..2026-09-30.
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
create or replace function pg_temp.seed_settings(p_org uuid, p_settings jsonb) returns void
language sql security definer as $$ update public.organizations set settings = p_settings where id = p_org $$;

begin;
insert into public.organizations (id, name, slug, status) values
  ('d1000000-0000-4000-8000-000000000001', 'Perf A', 'perf-a-test', 'active'),
  ('d1000000-0000-4000-8000-000000000002', 'Perf B', 'perf-b-test', 'active');
insert into public.subscriptions (organization_id, status, current_period_start, current_period_end)
  select o, 'active', now() - interval '1 day', now() + interval '1 year'
  from (values ('d1000000-0000-4000-8000-000000000001'::uuid), ('d1000000-0000-4000-8000-000000000002'::uuid)) t(o);
insert into public.organization_modules (organization_id, module_id, enabled, source)
  select o, m.id, true, 'override' from public.modules m,
  (values ('d1000000-0000-4000-8000-000000000001'::uuid), ('d1000000-0000-4000-8000-000000000002'::uuid)) t(o);
insert into public.branches (id, organization_id, name, is_default, status) values
  ('d1000000-0000-4000-8000-0000000000e1', 'd1000000-0000-4000-8000-000000000001', 'North', true, 'active'),
  ('d1000000-0000-4000-8000-0000000000e3', 'd1000000-0000-4000-8000-000000000001', 'South', false, 'active'),
  ('d1000000-0000-4000-8000-0000000000e2', 'd1000000-0000-4000-8000-000000000002', 'Main B', true, 'active');

-- Roles: Owner (everything the dashboard reads + settings), NorthFin (branch limited), NoFin (bookings only),
-- CustOnly (customers, all branches, no booking/finance), Groomer (named role), Reader (no settings), OwnerB.
insert into public.roles (id, organization_id, name) values
  ('d1000000-0000-4000-8000-000000000011', 'd1000000-0000-4000-8000-000000000001', 'Pemilik'),
  ('d1000000-0000-4000-8000-000000000012', 'd1000000-0000-4000-8000-000000000001', 'NorthFin'),
  ('d1000000-0000-4000-8000-000000000013', 'd1000000-0000-4000-8000-000000000001', 'NoFin'),
  ('d1000000-0000-4000-8000-000000000014', 'd1000000-0000-4000-8000-000000000001', 'CustOnly'),
  ('d1000000-0000-4000-8000-000000000015', 'd1000000-0000-4000-8000-000000000001', 'Groomer'),
  ('d1000000-0000-4000-8000-000000000016', 'd1000000-0000-4000-8000-000000000001', 'Reader'),
  ('d1000000-0000-4000-8000-000000000017', 'd1000000-0000-4000-8000-000000000002', 'Pemilik');
insert into public.role_permissions (organization_id, role_id, permission_id)
  select 'd1000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000011', id from public.permissions
   where key in ('finance.read','branches.all','booking.read','customer.read','settings.manage');
insert into public.role_permissions (organization_id, role_id, permission_id)
  select 'd1000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000012', id from public.permissions
   where key in ('finance.read','booking.read','customer.read');
insert into public.role_permissions (organization_id, role_id, permission_id)
  select 'd1000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000013', id from public.permissions where key in ('booking.read');
insert into public.role_permissions (organization_id, role_id, permission_id)
  select 'd1000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000014', id from public.permissions where key in ('customer.read','branches.all');
insert into public.role_permissions (organization_id, role_id, permission_id)
  select 'd1000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000015', id from public.permissions
   where key in ('booking.read','customer.read','branches.all','finance.read');
insert into public.role_permissions (organization_id, role_id, permission_id)
  select 'd1000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000016', id from public.permissions where key in ('booking.read');
insert into public.role_permissions (organization_id, role_id, permission_id)
  select 'd1000000-0000-4000-8000-000000000002', 'd1000000-0000-4000-8000-000000000017', id from public.permissions
   where key in ('finance.read','branches.all','booking.read','customer.read','settings.manage');
insert into auth.users (id, email, raw_user_meta_data) values
  ('d1000000-0000-4000-8000-000000000021', 'owner-a@perf.test', '{}'),
  ('d1000000-0000-4000-8000-000000000022', 'north@perf.test', '{}'),
  ('d1000000-0000-4000-8000-000000000023', 'nofin@perf.test', '{}'),
  ('d1000000-0000-4000-8000-000000000024', 'custonly@perf.test', '{}'),
  ('d1000000-0000-4000-8000-000000000025', 'groomer@perf.test', '{}'),
  ('d1000000-0000-4000-8000-000000000026', 'reader@perf.test', '{}'),
  ('d1000000-0000-4000-8000-000000000027', 'owner-b@perf.test', '{}');
update public.users set status = 'active' where id::text like 'd1000000-%';
insert into public.memberships (id, user_id, organization_id, role_id, status) values
  ('d1000000-0000-4000-8000-0000000000f1', 'd1000000-0000-4000-8000-000000000021', 'd1000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000011', 'active'),
  ('d1000000-0000-4000-8000-0000000000f2', 'd1000000-0000-4000-8000-000000000022', 'd1000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000012', 'active'),
  ('d1000000-0000-4000-8000-0000000000f3', 'd1000000-0000-4000-8000-000000000023', 'd1000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000013', 'active'),
  ('d1000000-0000-4000-8000-0000000000f4', 'd1000000-0000-4000-8000-000000000024', 'd1000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000014', 'active'),
  ('d1000000-0000-4000-8000-0000000000f5', 'd1000000-0000-4000-8000-000000000025', 'd1000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000015', 'active'),
  ('d1000000-0000-4000-8000-0000000000f6', 'd1000000-0000-4000-8000-000000000026', 'd1000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000016', 'active'),
  ('d1000000-0000-4000-8000-0000000000f7', 'd1000000-0000-4000-8000-000000000027', 'd1000000-0000-4000-8000-000000000002', 'd1000000-0000-4000-8000-000000000017', 'active');
insert into public.membership_branch_access (organization_id, membership_id, branch_id) values
  ('d1000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-0000000000f2', 'd1000000-0000-4000-8000-0000000000e1');

-- Customers. c3 is "INSTAGRAM" in the previous period, c6 archived, c7 soft-deleted, c8/c9 older customers.
insert into public.customers (id, organization_id, display_name, source, status, created_at, deleted_at) values
  ('d1000000-0000-4000-8000-0000000000c1', 'd1000000-0000-4000-8000-000000000001', 'Cust 1', 'Instagram',      'active',   '2026-10-05 03:00Z', null),
  ('d1000000-0000-4000-8000-0000000000c2', 'd1000000-0000-4000-8000-000000000001', 'Cust 2', '  instagram  ',  'lead',     '2026-10-06 03:00Z', null),
  ('d1000000-0000-4000-8000-0000000000c3', 'd1000000-0000-4000-8000-000000000001', 'Cust 3', 'INSTAGRAM',      'active',   '2026-09-25 03:00Z', null),
  ('d1000000-0000-4000-8000-0000000000c4', 'd1000000-0000-4000-8000-000000000001', 'Cust 4', null,             'active',   '2026-10-07 03:00Z', null),
  ('d1000000-0000-4000-8000-0000000000c5', 'd1000000-0000-4000-8000-000000000001', 'Cust 5', '   ',            'active',   '2026-10-08 03:00Z', null),
  ('d1000000-0000-4000-8000-0000000000c6', 'd1000000-0000-4000-8000-000000000001', 'Cust 6', 'Google',         'archived', '2026-10-09 03:00Z', null),
  ('d1000000-0000-4000-8000-0000000000c7', 'd1000000-0000-4000-8000-000000000001', 'Cust 7', 'Google',         'active',   '2026-10-09 03:00Z', '2026-10-09 04:00Z'),
  ('d1000000-0000-4000-8000-0000000000c8', 'd1000000-0000-4000-8000-000000000001', 'Cust 8', 'Walk-in',        'active',   '2026-08-01 03:00Z', null),
  ('d1000000-0000-4000-8000-0000000000c9', 'd1000000-0000-4000-8000-000000000001', 'Cust 9', 'Teman',          'active',   '2026-10-02 03:00Z', null),
  ('d1000000-0000-4000-8000-0000000000b1', 'd1000000-0000-4000-8000-000000000002', 'B Cust', 'Instagram',      'active',   '2026-10-05 03:00Z', null);

insert into public.bookings (id, organization_id, branch_id, customer_id, booking_type, status, starts_at, ends_at, deleted_at) values
  -- current period
  ('d1000000-0000-4000-8000-00000000d001', 'd1000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-0000000000e1', 'd1000000-0000-4000-8000-0000000000c8', 'grooming', 'completed', '2026-10-03 04:00Z', '2026-10-03 05:00Z', null),
  ('d1000000-0000-4000-8000-00000000d002', 'd1000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-0000000000e1', 'd1000000-0000-4000-8000-0000000000c9', 'grooming', 'completed', '2026-10-04 04:00Z', '2026-10-04 05:00Z', null),
  ('d1000000-0000-4000-8000-00000000d003', 'd1000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-0000000000e1', 'd1000000-0000-4000-8000-0000000000c1', 'grooming', 'canceled',  '2026-10-05 04:00Z', '2026-10-05 05:00Z', null),
  ('d1000000-0000-4000-8000-00000000d004', 'd1000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-0000000000e3', 'd1000000-0000-4000-8000-0000000000c1', 'grooming', 'no_show',   '2026-10-06 04:00Z', '2026-10-06 05:00Z', null),
  ('d1000000-0000-4000-8000-00000000d005', 'd1000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-0000000000e3', 'd1000000-0000-4000-8000-0000000000c1', 'grooming', 'confirmed', '2026-10-07 04:00Z', '2026-10-07 05:00Z', null),
  ('d1000000-0000-4000-8000-00000000d006', 'd1000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-0000000000e1', 'd1000000-0000-4000-8000-0000000000c1', 'grooming', 'draft',     '2026-10-07 06:00Z', '2026-10-07 07:00Z', null),
  ('d1000000-0000-4000-8000-00000000d007', 'd1000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-0000000000e1', 'd1000000-0000-4000-8000-0000000000c1', 'grooming', 'completed', '2026-10-08 04:00Z', '2026-10-08 05:00Z', '2026-10-08 09:00Z'),
  -- 2026-09-30 17:30Z is 1 Oct 00:30 Jakarta: current. 2026-10-10 17:30Z is 11 Oct local: outside.
  ('d1000000-0000-4000-8000-00000000d010', 'd1000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-0000000000e1', 'd1000000-0000-4000-8000-0000000000c1', 'grooming', 'completed', '2026-09-30 17:30Z', '2026-09-30 18:30Z', null),
  ('d1000000-0000-4000-8000-00000000d011', 'd1000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-0000000000e1', 'd1000000-0000-4000-8000-0000000000c2', 'grooming', 'completed', '2026-10-10 17:30Z', '2026-10-10 18:30Z', null),
  -- previous period (2026-09-20 17:30Z is 21 Sep 00:30 Jakarta: previous)
  ('d1000000-0000-4000-8000-00000000d008', 'd1000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-0000000000e1', 'd1000000-0000-4000-8000-0000000000c3', 'grooming', 'completed', '2026-09-22 04:00Z', '2026-09-22 05:00Z', null),
  ('d1000000-0000-4000-8000-00000000d009', 'd1000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-0000000000e1', 'd1000000-0000-4000-8000-0000000000c3', 'grooming', 'requested', '2026-09-23 04:00Z', '2026-09-23 05:00Z', null),
  ('d1000000-0000-4000-8000-00000000d012', 'd1000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-0000000000e1', 'd1000000-0000-4000-8000-0000000000c4', 'grooming', 'completed', '2026-09-20 17:30Z', '2026-09-20 18:30Z', null),
  -- c9 had an earlier completed visit, so the October one is not a "first completed".
  ('d1000000-0000-4000-8000-00000000d013', 'd1000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-0000000000e1', 'd1000000-0000-4000-8000-0000000000c9', 'grooming', 'completed', '2026-08-10 04:00Z', '2026-08-10 05:00Z', null),
  -- other tenant
  ('d1000000-0000-4000-8000-00000000d0b1', 'd1000000-0000-4000-8000-000000000002', 'd1000000-0000-4000-8000-0000000000e2', 'd1000000-0000-4000-8000-0000000000b1', 'grooming', 'completed', '2026-10-05 04:00Z', '2026-10-05 05:00Z', null);

insert into public.invoices (id, organization_id, branch_id, customer_id, invoice_number, status, currency, subtotal, total, issued_at, due_at, paid_at) values
  ('d1000000-0000-4000-8000-00000000f001', 'd1000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-0000000000e1', 'd1000000-0000-4000-8000-0000000000c8', 'P-001', 'paid',   'IDR', 100000, 100000, '2026-10-02 03:00Z', null,                 '2026-10-02 03:00Z'),
  ('d1000000-0000-4000-8000-00000000f002', 'd1000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-0000000000e1', 'd1000000-0000-4000-8000-0000000000c1', 'P-002', 'issued', 'IDR', 250000, 250000, '2026-10-03 03:00Z', '2020-01-01 00:00Z', null),
  ('d1000000-0000-4000-8000-00000000f003', 'd1000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-0000000000e3', 'd1000000-0000-4000-8000-0000000000c2', 'P-003', 'issued', 'IDR', 400000, 400000, '2026-10-04 03:00Z', '2099-01-01 00:00Z', null),
  ('d1000000-0000-4000-8000-00000000f004', 'd1000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-0000000000e1', 'd1000000-0000-4000-8000-0000000000c4', 'P-004', 'void',   'IDR', 999000, 999000, '2026-10-05 03:00Z', null,                 null),
  ('d1000000-0000-4000-8000-00000000f005', 'd1000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-0000000000e1', 'd1000000-0000-4000-8000-0000000000c2', 'P-005', 'issued', 'USD',     50,     50, '2026-10-06 03:00Z', null,                 null),
  ('d1000000-0000-4000-8000-00000000f006', 'd1000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-0000000000e1', 'd1000000-0000-4000-8000-0000000000c8', 'P-006', 'issued', 'IDR',      0,      0, '2026-10-07 03:00Z', null,                 null),
  ('d1000000-0000-4000-8000-00000000f007', 'd1000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-0000000000e1', 'd1000000-0000-4000-8000-0000000000c9', 'P-007', 'paid',   'IDR',  80000,  80000, '2026-09-22 03:00Z', null,                 '2026-09-23 03:00Z'),
  ('d1000000-0000-4000-8000-00000000f008', 'd1000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-0000000000e1', 'd1000000-0000-4000-8000-0000000000c3', 'P-008', 'paid',   'IDR',  30000,  30000, '2026-09-23 03:00Z', null,                 '2026-09-24 03:00Z'),
  ('d1000000-0000-4000-8000-00000000f009', 'd1000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-0000000000e3', 'd1000000-0000-4000-8000-0000000000c2', 'P-009', 'paid',   'IDR', 900000, 900000, '2026-10-07 03:00Z', null,                 '2026-10-07 03:00Z'),
  ('d1000000-0000-4000-8000-00000000f000', 'd1000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-0000000000e1', 'd1000000-0000-4000-8000-0000000000c9', 'P-000', 'paid',   'IDR',  70000,  70000, '2026-08-10 03:00Z', null,                 '2026-08-11 03:00Z'),
  ('d1000000-0000-4000-8000-00000000f0b1', 'd1000000-0000-4000-8000-000000000002', 'd1000000-0000-4000-8000-0000000000e2', 'd1000000-0000-4000-8000-0000000000b1', 'PB-001', 'paid',  'IDR', 5000000, 5000000, '2026-10-05 03:00Z', null,               '2026-10-05 03:00Z');

insert into public.payments (id, organization_id, branch_id, invoice_id, method, amount, currency, status, paid_at) values
  ('d1000000-0000-4000-8000-00000000a001', 'd1000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-0000000000e1', 'd1000000-0000-4000-8000-00000000f001', 'cash',  100000, 'IDR', 'succeeded', '2026-10-02 03:00Z'),
  ('d1000000-0000-4000-8000-00000000a002', 'd1000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-0000000000e1', 'd1000000-0000-4000-8000-00000000f002', 'cash',  100000, 'IDR', 'succeeded', '2026-10-04 03:00Z'),
  ('d1000000-0000-4000-8000-00000000a003', 'd1000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-0000000000e1', 'd1000000-0000-4000-8000-00000000f004', 'cash',    5000, 'IDR', 'succeeded', '2026-10-06 03:00Z'),
  ('d1000000-0000-4000-8000-00000000a004', 'd1000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-0000000000e1', 'd1000000-0000-4000-8000-00000000f002', 'cash',  777000, 'IDR', 'pending',   '2026-10-08 03:00Z'),
  ('d1000000-0000-4000-8000-00000000a005', 'd1000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-0000000000e1', 'd1000000-0000-4000-8000-00000000f002', 'cash',  555000, 'IDR', 'failed',    '2026-10-09 03:00Z'),
  ('d1000000-0000-4000-8000-00000000a006', 'd1000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-0000000000e1', null,                                     'card',      40, 'USD', 'succeeded', '2026-10-06 03:00Z'),
  ('d1000000-0000-4000-8000-00000000a007', 'd1000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-0000000000e1', 'd1000000-0000-4000-8000-00000000f007', 'cash',   80000, 'IDR', 'succeeded', '2026-09-23 03:00Z'),
  ('d1000000-0000-4000-8000-00000000a008', 'd1000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-0000000000e1', 'd1000000-0000-4000-8000-00000000f000', 'cash',   70000, 'IDR', 'succeeded', '2026-08-11 03:00Z'),
  ('d1000000-0000-4000-8000-00000000a009', 'd1000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-0000000000e1', 'd1000000-0000-4000-8000-00000000f008', 'cash',   30000, 'IDR', 'succeeded', '2026-09-24 03:00Z'),
  ('d1000000-0000-4000-8000-00000000a010', 'd1000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-0000000000e3', 'd1000000-0000-4000-8000-00000000f009', 'cash',  900000, 'IDR', 'succeeded', '2026-10-07 03:00Z'),
  ('d1000000-0000-4000-8000-00000000a011', 'd1000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-0000000000e1', null,                                     'cash',   10000, 'IDR', 'succeeded', '2026-09-30 17:30Z'),
  ('d1000000-0000-4000-8000-00000000a012', 'd1000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-0000000000e1', null,                                     'cash',   20000, 'IDR', 'succeeded', '2026-10-10 17:30Z'),
  ('d1000000-0000-4000-8000-00000000a0b1', 'd1000000-0000-4000-8000-000000000002', 'd1000000-0000-4000-8000-0000000000e2', 'd1000000-0000-4000-8000-00000000f0b1', 'cash', 5000000, 'IDR', 'succeeded', '2026-10-05 03:00Z');
insert into public.refunds (id, organization_id, payment_id, amount, status, refunded_at) values
  ('d1000000-0000-4000-8000-00000000b001', 'd1000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-00000000a001',  30000, 'succeeded', '2026-10-08 03:00Z'),
  ('d1000000-0000-4000-8000-00000000b002', 'd1000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-00000000a002',  99999, 'failed',    '2026-10-08 03:00Z'),
  ('d1000000-0000-4000-8000-00000000b003', 'd1000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-00000000a006',      5, 'succeeded', '2026-10-09 03:00Z'),
  ('d1000000-0000-4000-8000-00000000b004', 'd1000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-00000000a010', 100000, 'succeeded', '2026-10-09 03:00Z'),
  ('d1000000-0000-4000-8000-00000000b005', 'd1000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-00000000a007',  20000, 'succeeded', '2026-09-25 03:00Z');

-- ===== Card settings ==================================================================================================
set local role authenticated;
select pg_temp.act_as('d1000000-0000-4000-8000-000000000021', 'd1000000-0000-4000-8000-000000000001');
do $$
declare v jsonb;
  all7 constant jsonb := '{"booking_today":true,"revenue_today":true,"active_customers":true,"open_tasks":true,"performance_operations":false,"performance_finance":true,"performance_sources":false}';
  legacy constant jsonb := '{"booking_today":false,"revenue_today":true,"active_customers":true,"open_tasks":true}';
begin
  if not app.has_permission('settings.manage') then raise exception 'owner fixture lacks settings.manage'; end if;
  -- complete new allowlist is stored as sent
  perform app.update_dashboard_card_settings(all7);
  select settings #> '{dashboard,cards}' into v from public.organizations where id = app.fn_active_organization();
  if v is distinct from all7 then raise exception 'FAIL complete allowlist not stored: %', v; end if;
  -- legacy payload keeps the stored values of the new keys
  perform app.update_dashboard_card_settings(legacy);
  select settings #> '{dashboard,cards}' into v from public.organizations where id = app.fn_active_organization();
  if v is distinct from (legacy || '{"performance_operations":false,"performance_finance":true,"performance_sources":false}'::jsonb) then
    raise exception 'FAIL legacy payload altered the new keys: %', v; end if;
  raise notice 'PASS: complete allowlist stored; legacy four-key payload preserves the three performance keys';
  -- tenants that never saved the new keys keep them absent (the application reads absent as visible)
  perform pg_temp.seed_settings(app.fn_active_organization(), '{"documents":{"tagline":"hi"},"dashboard":{"layout":"compact","cards":{"open_tasks":true}}}'::jsonb);
  perform app.update_dashboard_card_settings(legacy);
  select settings into v from public.organizations where id = app.fn_active_organization();
  if v #> '{dashboard,cards}' is distinct from legacy or v #>> '{documents,tagline}' <> 'hi' or v #>> '{dashboard,layout}' <> 'compact' then
    raise exception 'FAIL legacy payload on an old tenant / sibling preservation: %', v; end if;
  raise notice 'PASS: old tenant keeps new keys absent; unrelated settings preserved';
end $$;
do $$ begin
  perform pg_temp.expect($q$select app.update_dashboard_card_settings('{"booking_today":true,"revenue_today":true,"active_customers":true,"open_tasks":true,"performance_operations":true}')$q$, '22023', 'partial new-key set rejected');
  perform pg_temp.expect($q$select app.update_dashboard_card_settings('{"booking_today":true,"revenue_today":true,"active_customers":true,"open_tasks":true,"performance_operations":true,"performance_finance":true,"performance_sources":"yes"}')$q$, '22023', 'non-boolean new key rejected');
  perform pg_temp.expect($q$select app.update_dashboard_card_settings('{"booking_today":true,"revenue_today":true,"active_customers":true,"open_tasks":true,"performance_operations":true,"performance_finance":true,"performance_sources":true,"extra":true}')$q$, '22023', 'unknown key rejected');
  perform pg_temp.expect($q$select app.update_dashboard_card_settings('{"performance_operations":true,"performance_finance":true,"performance_sources":true}')$q$, '22023', 'legacy keys still required');
  perform pg_temp.expect($q$select app.update_dashboard_card_settings('{"booking_today":true,"revenue_today":true,"active_customers":true,"open_tasks":null}')$q$, '22023', 'null legacy value rejected');
  perform pg_temp.expect($q$select app.update_dashboard_card_settings('[]')$q$, '22023', 'array rejected');
end $$;
select pg_temp.act_as('d1000000-0000-4000-8000-000000000026', 'd1000000-0000-4000-8000-000000000001');
do $$ begin
  perform pg_temp.expect($q$select app.update_dashboard_card_settings('{"booking_today":true,"revenue_today":true,"active_customers":true,"open_tasks":true,"performance_operations":true,"performance_finance":true,"performance_sources":true}')$q$, '42501', 'role without settings.manage refused');
end $$;
select pg_temp.act_as('d1000000-0000-4000-8000-000000000021', 'd1000000-0000-4000-8000-000000000002');
do $$ begin
  perform pg_temp.expect($q$select app.update_dashboard_card_settings('{"booking_today":true,"revenue_today":true,"active_customers":true,"open_tasks":true,"performance_operations":true,"performance_finance":true,"performance_sources":true}')$q$, '42501', 'forged organization cannot write settings');
end $$;
reset role;
do $$ begin
  if (select settings from public.organizations where id = 'd1000000-0000-4000-8000-000000000002') is distinct from '{}'::jsonb then
    raise exception 'FAIL other tenant settings changed'; end if;
  raise notice 'PASS: other tenant settings untouched';
end $$;

-- ===== Operations =====================================================================================================
set local role authenticated;
select pg_temp.act_as('d1000000-0000-4000-8000-000000000021', 'd1000000-0000-4000-8000-000000000001');
do $$
declare r record; n integer; z integer;
begin
  select * into r from app.dashboard_operations_performance('2026-10-01','2026-10-10','2026-09-21','2026-09-30','Asia/Jakarta') where period = 'current';
  -- completed d001 d002 d010 (d007 deleted, d011 outside by a Jakarta hour); open d005 (d006 draft excluded); canceled d003; no_show d004
  if r.completed <> 3 or r.open_count <> 1 or r.canceled <> 1 or r.no_show <> 1 then raise exception 'FAIL operations current %', row_to_json(r); end if;
  select * into r from app.dashboard_operations_performance('2026-10-01','2026-10-10','2026-09-21','2026-09-30','Asia/Jakarta') where period = 'previous';
  if r.completed <> 2 or r.open_count <> 1 or r.canceled <> 0 or r.no_show <> 0 then raise exception 'FAIL operations previous %', row_to_json(r); end if;
  raise notice 'PASS: operations current/previous, draft + soft-deleted excluded, Jakarta day boundaries';
  select count(*), max(completed) into n, z from app.dashboard_operations_performance('2025-01-01','2025-01-10','2024-12-22','2024-12-31','Asia/Jakarta');
  if n <> 2 or z <> 0 then raise exception 'FAIL empty period must return two zero rows'; end if;
  raise notice 'PASS: empty period returns two zero rows';
  perform 1 from app.dashboard_operations_performance('2025-10-10','2026-10-10','2024-10-09','2025-10-09','Asia/Jakarta');
  raise notice 'PASS: a 366-day range is accepted';
end $$;
do $$ begin
  perform pg_temp.expect($q$select * from app.dashboard_operations_performance('2025-10-09','2026-10-10','2024-10-07','2025-10-08')$q$, '22023', '367-day range rejected (equal-length comparison supplied)');
  perform pg_temp.expect($q$select * from app.dashboard_operations_performance('2026-10-10','2026-10-01','2026-09-21','2026-09-30')$q$, '22023', 'inverted range rejected');
  perform pg_temp.expect($q$select * from app.dashboard_operations_performance('2026-10-01','2026-10-10','2026-09-20','2026-09-29')$q$, '22023', 'non-adjacent comparison rejected');
  perform pg_temp.expect($q$select * from app.dashboard_operations_performance('2026-10-01','2026-10-10','2026-09-22','2026-09-30')$q$, '22023', 'unequal-length comparison rejected');
  perform pg_temp.expect($q$select * from app.dashboard_operations_performance(null,'2026-10-10','2026-09-21','2026-09-30')$q$, '22023', 'null date rejected');
  perform pg_temp.expect($q$select * from app.dashboard_operations_performance('2026-10-01','2026-10-10','2026-09-21','2026-09-30','Mars/Olympus')$q$, '22023', 'unknown time zone rejected');
  perform pg_temp.expect($q$select * from app.dashboard_operations_performance('1999-12-01','1999-12-10','1999-11-21','1999-11-30')$q$, '22023', 'out-of-range dates rejected');
end $$;

-- ===== Finance ========================================================================================================
do $$
declare r record; n integer;
begin
  select * into r from app.dashboard_finance_performance('2026-10-01','2026-10-10','2026-09-21','2026-09-30') where period = 'current' and currency = 'IDR';
  if r.issued_total <> 1650000 or r.issued_count <> 5 then raise exception 'FAIL IDR issued (void excluded, zero-total counted): %', row_to_json(r); end if;
  if r.collected_total <> 1115000 or r.collected_count <> 5 or r.collected_on_void_count <> 1 then raise exception 'FAIL IDR collected (pending/failed excluded): %', row_to_json(r); end if;
  if r.refunded_total <> 130000 or r.refunded_count <> 2 then raise exception 'FAIL IDR refunds (failed excluded): %', row_to_json(r); end if;
  select * into r from app.dashboard_finance_performance('2026-10-01','2026-10-10','2026-09-21','2026-09-30') where period = 'current' and currency = 'USD';
  if r.issued_total <> 50 or r.collected_total <> 40 or r.refunded_total <> 5 then raise exception 'FAIL USD kept separate: %', row_to_json(r); end if;
  select * into r from app.dashboard_finance_performance('2026-10-01','2026-10-10','2026-09-21','2026-09-30') where period = 'previous' and currency = 'IDR';
  if r.issued_total <> 110000 or r.issued_count <> 2 or r.collected_total <> 110000 or r.refunded_total <> 20000 then raise exception 'FAIL IDR previous: %', row_to_json(r); end if;
  if exists (select 1 from app.dashboard_finance_performance('2026-10-01','2026-10-10','2026-09-21','2026-09-30') where period = 'previous' and currency = 'USD') then
    raise exception 'FAIL no USD activity in the previous period, so no row'; end if;
  raise notice 'PASS: issued / collected / refunded per currency and period; void, pending, failed excluded';
  select * into r from app.dashboard_finance_performance('2026-10-01','2026-10-10','2026-09-21','2026-09-30','UTC') where period = 'current' and currency = 'IDR';
  if r.collected_total <> 1115000 - 10000 + 20000 then raise exception 'FAIL UTC boundary: % (a011 leaves, a012 enters the current period)', r.collected_total; end if;
  raise notice 'PASS: finance boundaries follow the requested time zone';
  select * into r from app.dashboard_finance_performance('2026-10-01','2026-10-10','2026-09-21','2026-09-30') where period = 'snapshot' and currency = 'IDR';
  if r.outstanding_total <> 550000 or r.outstanding_count <> 2 or r.overdue_count <> 1 then raise exception 'FAIL IDR outstanding (partial payment netted, zero-due ignored): %', row_to_json(r); end if;
  select * into r from app.dashboard_finance_performance('2026-10-01','2026-10-10','2026-09-21','2026-09-30') where period = 'snapshot' and currency = 'USD';
  if r.outstanding_total <> 50 or r.outstanding_count <> 1 or r.overdue_count <> 0 then raise exception 'FAIL USD outstanding: %', row_to_json(r); end if;
  raise notice 'PASS: outstanding snapshot nets partial payments, ignores zero-due invoices, separates currency';
  select count(*) into n from app.dashboard_finance_performance('2025-01-01','2025-01-10','2024-12-22','2024-12-31') where period <> 'snapshot';
  if n <> 0 then raise exception 'FAIL empty period must have no period rows'; end if;
  raise notice 'PASS: empty period returns no period rows (never invented zeros)';
end $$;

-- Branch-limited finance user: only North rows; South refunds/payments never leak.
select pg_temp.act_as('d1000000-0000-4000-8000-000000000022', 'd1000000-0000-4000-8000-000000000001');
do $$
declare r record;
begin
  select * into r from app.dashboard_finance_performance('2026-10-01','2026-10-10','2026-09-21','2026-09-30') where period = 'current' and currency = 'IDR';
  if r.issued_total <> 350000 or r.issued_count <> 3 or r.collected_total <> 215000 or r.collected_count <> 4 or r.refunded_total <> 30000 or r.refunded_count <> 1 then
    raise exception 'FAIL branch-scoped finance: %', row_to_json(r); end if;
  select * into r from app.dashboard_finance_performance('2026-10-01','2026-10-10','2026-09-21','2026-09-30') where period = 'snapshot' and currency = 'IDR';
  if r.outstanding_total <> 150000 or r.outstanding_count <> 1 then raise exception 'FAIL branch-scoped outstanding: %', row_to_json(r); end if;
  raise notice 'PASS: branch-restricted finance sees only its own branch, including refunds and outstanding';
  select * into r from app.dashboard_operations_performance('2026-10-01','2026-10-10','2026-09-21','2026-09-30','Asia/Jakarta') where period = 'current';
  if r.completed <> 3 or r.open_count <> 0 or r.canceled <> 1 or r.no_show <> 0 then raise exception 'FAIL branch-scoped operations: %', row_to_json(r); end if;
  raise notice 'PASS: branch-restricted operations see only their own branch';
end $$;
do $$ begin
  perform pg_temp.expect($q$select * from app.dashboard_source_performance('2026-10-01','2026-10-10','2026-09-21','2026-09-30','Asia/Jakarta')$q$, '42501', 'branch-restricted caller refused source performance (customers have no branch)');
end $$;

-- Capability denial: no query result, a loud 42501.
select pg_temp.act_as('d1000000-0000-4000-8000-000000000023', 'd1000000-0000-4000-8000-000000000001');
do $$ begin
  perform pg_temp.expect($q$select * from app.dashboard_finance_performance('2026-10-01','2026-10-10','2026-09-21','2026-09-30')$q$, '42501', 'no finance.read: finance refused');
  perform pg_temp.expect($q$select * from app.dashboard_source_performance('2026-10-01','2026-10-10','2026-09-21','2026-09-30','Asia/Jakarta')$q$, '42501', 'no customer.read: sources refused');
  perform 1 from app.dashboard_operations_performance('2026-10-01','2026-10-10','2026-09-21','2026-09-30');
  raise notice 'PASS: booking.read alone still gets operations';
end $$;
select pg_temp.act_as('d1000000-0000-4000-8000-000000000024', 'd1000000-0000-4000-8000-000000000001');
do $$ begin
  perform pg_temp.expect($q$select * from app.dashboard_finance_performance('2026-10-01','2026-10-10','2026-09-21','2026-09-30')$q$, '42501', 'customers-only role: finance refused');
  perform pg_temp.expect($q$select * from app.dashboard_operations_performance('2026-10-01','2026-10-10','2026-09-21','2026-09-30')$q$, '42501', 'customers-only role: operations refused');
end $$;
select pg_temp.act_as('d1000000-0000-4000-8000-000000000025', 'd1000000-0000-4000-8000-000000000001');
do $$ begin
  perform pg_temp.expect($q$select * from app.dashboard_source_performance('2026-10-01','2026-10-10','2026-09-21','2026-09-30','Asia/Jakarta')$q$, '42501', 'Groomer role refused (RLS would silently truncate)');
  perform pg_temp.expect($q$select * from app.dashboard_operations_performance('2026-10-01','2026-10-10','2026-09-21','2026-09-30')$q$, '42501', 'Groomer role refused operations');
end $$;

-- ===== Sources ========================================================================================================
select pg_temp.act_as('d1000000-0000-4000-8000-000000000021', 'd1000000-0000-4000-8000-000000000001');
do $$
declare r record; n integer;
begin
  -- Instagram bucket merges 'Instagram', '  instagram  ' and 'INSTAGRAM' (case + whitespace folding).
  select * into r from app.dashboard_source_performance('2026-10-01','2026-10-10','2026-09-21','2026-09-30','Asia/Jakarta') where period = 'current' and lower(source_label) = 'instagram';
  if r.new_customers <> 2 or r.first_completed <> 1 or r.first_paid <> 2 or r.is_missing or r.is_other then raise exception 'FAIL instagram current: %', row_to_json(r); end if;
  select * into r from app.dashboard_source_performance('2026-10-01','2026-10-10','2026-09-21','2026-09-30','Asia/Jakarta') where period = 'previous' and lower(source_label) = 'instagram';
  if r.new_customers <> 1 or r.first_completed <> 1 or r.first_paid <> 1 then raise exception 'FAIL instagram previous: %', row_to_json(r); end if;
  raise notice 'PASS: sources are normalized; first completed / first paid counted once per customer in the right period';
  select * into r from app.dashboard_source_performance('2026-10-01','2026-10-10','2026-09-21','2026-09-30','Asia/Jakarta') where period = 'current' and is_missing;
  if r.new_customers <> 2 or r.first_completed <> 0 or r.first_paid <> 0 or r.source_label is not null then raise exception 'FAIL missing-source bucket (null and blank, void-invoice payment ignored): %', row_to_json(r); end if;
  select * into r from app.dashboard_source_performance('2026-10-01','2026-10-10','2026-09-21','2026-09-30','Asia/Jakarta') where period = 'previous' and is_missing;
  if r.new_customers <> 0 or r.first_completed <> 1 then raise exception 'FAIL missing-source previous: %', row_to_json(r); end if;
  raise notice 'PASS: missing source reported honestly; payments on void invoices are not a first payment';
  select * into r from app.dashboard_source_performance('2026-10-01','2026-10-10','2026-09-21','2026-09-30','Asia/Jakarta') where period = 'current' and lower(source_label) = 'walk-in';
  if r.new_customers <> 0 then raise exception 'FAIL walk-in registered before the period: %', row_to_json(r); end if;
  if r.first_completed <> 1 or r.first_paid <> 1 then raise exception 'FAIL walk-in first business: %', row_to_json(r); end if;
  select * into r from app.dashboard_source_performance('2026-10-01','2026-10-10','2026-09-21','2026-09-30','Asia/Jakarta') where period = 'current' and lower(source_label) = 'teman';
  if r.new_customers <> 1 or r.first_completed <> 0 or r.first_paid <> 0 then raise exception 'FAIL teman (earlier visit and payment exist): %', row_to_json(r); end if;
  if exists (select 1 from app.dashboard_source_performance('2026-10-01','2026-10-10','2026-09-21','2026-09-30','Asia/Jakarta') where lower(coalesce(source_label,'')) = 'google') then
    raise exception 'FAIL archived / deleted customers must not appear'; end if;
  raise notice 'PASS: customers registered earlier count only for first business; archived and deleted customers excluded';
  select count(*) into n from app.dashboard_source_performance('2026-10-01','2026-10-10','2026-09-21','2026-09-30','Asia/Jakarta') where lower(coalesce(source_label,'')) = 'instagram' and period = 'current';
  if n <> 1 then raise exception 'FAIL one row per bucket and period'; end if;
  -- Output shape: no identity, contact or amount columns.
  if exists (select 1 from pg_proc p, unnest(p.proargnames) a where p.oid = 'app.dashboard_source_performance(date,date,date,date,text)'::regprocedure
             and a ~* '^(customer_id|customer_name|display_name|phone|email|address|notes?|amount|total|proof)') then
    raise exception 'FAIL source function exposes a forbidden column'; end if;
  raise notice 'PASS: source function returns counts only';
end $$;

-- Customers-only role: counts available, booking/finance-derived columns are NULL (unavailable, not zero).
select pg_temp.act_as('d1000000-0000-4000-8000-000000000024', 'd1000000-0000-4000-8000-000000000001');
do $$
declare r record;
begin
  select * into r from app.dashboard_source_performance('2026-10-01','2026-10-10','2026-09-21','2026-09-30','Asia/Jakarta') where period = 'current' and lower(source_label) = 'instagram';
  if r.new_customers <> 2 or r.first_completed is not null or r.first_paid is not null then raise exception 'FAIL capability-gated columns: %', row_to_json(r); end if;
  raise notice 'PASS: without booking.read / finance.read the dependent columns are NULL, not zero';
end $$;

-- Tenant isolation and forged context.
select pg_temp.act_as('d1000000-0000-4000-8000-000000000027', 'd1000000-0000-4000-8000-000000000002');
do $$
declare r record;
begin
  select * into r from app.dashboard_finance_performance('2026-10-01','2026-10-10','2026-09-21','2026-09-30') where period = 'current' and currency = 'IDR';
  if r.collected_total <> 5000000 or r.issued_total <> 5000000 or r.refunded_total <> 0 then raise exception 'FAIL tenant B finance %', row_to_json(r); end if;
  select * into r from app.dashboard_operations_performance('2026-10-01','2026-10-10','2026-09-21','2026-09-30') where period = 'current';
  if r.completed <> 1 then raise exception 'FAIL tenant B operations %', row_to_json(r); end if;
  select * into r from app.dashboard_source_performance('2026-10-01','2026-10-10','2026-09-21','2026-09-30','Asia/Jakarta') where period = 'current';
  if r.new_customers <> 1 or r.first_completed <> 1 or r.first_paid <> 1 then raise exception 'FAIL tenant B sources %', row_to_json(r); end if;
  raise notice 'PASS: tenant B sees only tenant B';
end $$;
select pg_temp.act_as('d1000000-0000-4000-8000-000000000027', 'd1000000-0000-4000-8000-000000000001');
do $$ begin
  perform pg_temp.expect($q$select * from app.dashboard_finance_performance('2026-10-01','2026-10-10','2026-09-21','2026-09-30')$q$, '42501', 'forged organization: finance refused');
  perform pg_temp.expect($q$select * from app.dashboard_operations_performance('2026-10-01','2026-10-10','2026-09-21','2026-09-30')$q$, '42501', 'forged organization: operations refused');
  perform pg_temp.expect($q$select * from app.dashboard_source_performance('2026-10-01','2026-10-10','2026-09-21','2026-09-30','Asia/Jakarta')$q$, '42501', 'forged organization: sources refused');
end $$;

-- anon / no context.
set local role anon;
do $$ begin
  perform pg_temp.expect($q$select * from app.dashboard_finance_performance('2026-10-01','2026-10-10','2026-09-21','2026-09-30')$q$, '42501', 'anon cannot execute finance aggregate');
  perform pg_temp.expect($q$select * from app.dashboard_operations_performance('2026-10-01','2026-10-10','2026-09-21','2026-09-30')$q$, '42501', 'anon cannot execute operations aggregate');
  perform pg_temp.expect($q$select * from app.dashboard_source_performance('2026-10-01','2026-10-10','2026-09-21','2026-09-30','Asia/Jakarta')$q$, '42501', 'anon cannot execute source aggregate');
  perform pg_temp.expect($q$select app.update_dashboard_card_settings('{}')$q$, '42501', 'anon cannot save card settings');
end $$;

-- ===== Top-N folding ==================================================================================================
reset role;
insert into public.customers (organization_id, display_name, source, status, created_at)
  select 'd1000000-0000-4000-8000-000000000001', 'Ovf ' || g, 'ovf-' || lpad(g::text, 2, '0'), 'active', '2026-10-03 03:00Z'
  from generate_series(1, 12) g;
set local role authenticated;
select pg_temp.act_as('d1000000-0000-4000-8000-000000000021', 'd1000000-0000-4000-8000-000000000001');
do $$
declare named integer; oth record; miss integer;
begin
  select count(*) filter (where not is_other and not is_missing), count(*) filter (where is_missing) into named, miss
    from app.dashboard_source_performance('2026-10-01','2026-10-10','2026-09-21','2026-09-30','Asia/Jakarta') where period = 'current';
  select * into oth from app.dashboard_source_performance('2026-10-01','2026-10-10','2026-09-21','2026-09-30','Asia/Jakarta') where period = 'current' and is_other;
  -- instagram, walk-in, teman, ovf-01..12 = 15 named sources: 10 kept, 5 folded.
  if named <> 10 or miss <> 1 or oth.source_count <> 5 or oth.source_label is not null then raise exception 'FAIL top-N folding: named %, missing %, other %', named, miss, row_to_json(oth); end if;
  if (select sum(new_customers) from app.dashboard_source_performance('2026-10-01','2026-10-10','2026-09-21','2026-09-30','Asia/Jakarta') where period = 'current') <> 5 + 12 then
    raise exception 'FAIL folding must preserve the total'; end if;
  raise notice 'PASS: output bounded to ten named sources plus one other and one missing row; totals preserved';
end $$;

-- ===== Definer safety: branch scope without any grant, and a revoked membership ======================================
-- The aggregates bypass row-level security, so these prove their own branch / membership checks.
select pg_temp.act_as('d1000000-0000-4000-8000-000000000023', 'd1000000-0000-4000-8000-000000000001');
do $$
declare r record;
begin
  -- booking.read but NO branch grant and no branches.all: sees nothing, even though 9 bookings exist this period.
  select * into r from app.dashboard_operations_performance('2026-10-01','2026-10-10','2026-09-21','2026-09-30','Asia/Jakarta') where period = 'current';
  if r.completed <> 0 or r.open_count <> 0 or r.canceled <> 0 or r.no_show <> 0 then raise exception 'FAIL branchless caller saw bookings: %', row_to_json(r); end if;
  raise notice 'PASS: a caller with no branch grant sees no bookings through the aggregate';
end $$;
reset role;
update public.memberships set deleted_at = now() where id = 'd1000000-0000-4000-8000-0000000000f1';
set local role authenticated;
select pg_temp.act_as('d1000000-0000-4000-8000-000000000021', 'd1000000-0000-4000-8000-000000000001');
do $$ begin
  perform pg_temp.expect($q$select * from app.dashboard_operations_performance('2026-10-01','2026-10-10','2026-09-21','2026-09-30')$q$, '42501', 'revoked membership: operations refused');
  perform pg_temp.expect($q$select * from app.dashboard_finance_performance('2026-10-01','2026-10-10','2026-09-21','2026-09-30')$q$, '42501', 'revoked membership: finance refused');
  perform pg_temp.expect($q$select * from app.dashboard_source_performance('2026-10-01','2026-10-10','2026-09-21','2026-09-30')$q$, '42501', 'revoked membership: sources refused');
end $$;

-- ===== Grants and shape ===============================================================================================
reset role;
do $$
declare f text;
begin
  foreach f in array array[
    'app.dashboard_operations_performance(date,date,date,date,text)', 'app.dashboard_finance_performance(date,date,date,date,text)',
    'app.dashboard_source_performance(date,date,date,date,text)', 'app.dashboard_check_periods(date,date,date,date,text)'] loop
    -- the three aggregates are definers on purpose (see the migration header); the validator is a pure invoker
    if (select prosecdef from pg_proc where oid = f::regprocedure) is distinct from (f not like '%check_periods%')
       or (select provolatile from pg_proc where oid = f::regprocedure) <> 's'
       or (select proconfig from pg_proc where oid = f::regprocedure) is distinct from array['search_path=""'] then
      raise exception 'FAIL % must be stable with an empty search_path (aggregates definer, validator invoker)', f; end if;
    if has_function_privilege('anon', f, 'execute') or has_function_privilege('public', f, 'execute') or not has_function_privilege('authenticated', f, 'execute') then
      raise exception 'FAIL grant shape %', f; end if;
  end loop;
  if (select proconfig from pg_proc where oid = 'app.update_dashboard_card_settings(jsonb)'::regprocedure) is distinct from array['search_path=""']
     or has_function_privilege('anon', 'app.update_dashboard_card_settings(jsonb)', 'execute') then
    raise exception 'FAIL card settings function grant/search_path'; end if;
  if app.schema_version() <> '20261030110000' then raise exception 'FAIL schema version %', app.schema_version(); end if;
  raise notice 'PASS: read-only (stable, empty search_path), no anon/public execute, schema version bumped';
end $$;
rollback;
