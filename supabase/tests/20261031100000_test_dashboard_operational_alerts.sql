-- P1 operational alerts: optional card key, bounded alert reader, tenant / branch / capability denial, grants.
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/20261031100000_test_dashboard_operational_alerts.sql
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
  ('e1000000-0000-4000-8000-000000000001', 'Alert A', 'alert-a-test', 'active'),
  ('e1000000-0000-4000-8000-000000000002', 'Alert B', 'alert-b-test', 'active');
insert into public.subscriptions (organization_id, status, current_period_start, current_period_end)
  select o, 'active', now() - interval '1 day', now() + interval '1 year'
  from (values ('e1000000-0000-4000-8000-000000000001'::uuid), ('e1000000-0000-4000-8000-000000000002'::uuid)) t(o);
insert into public.organization_modules (organization_id, module_id, enabled, source)
  select o, m.id, true, 'override' from public.modules m,
  (values ('e1000000-0000-4000-8000-000000000001'::uuid), ('e1000000-0000-4000-8000-000000000002'::uuid)) t(o);
insert into public.branches (id, organization_id, name, is_default, status) values
  ('e1000000-0000-4000-8000-0000000000e1', 'e1000000-0000-4000-8000-000000000001', 'North', true, 'active'),
  ('e1000000-0000-4000-8000-0000000000e3', 'e1000000-0000-4000-8000-000000000001', 'South', false, 'active'),
  ('e1000000-0000-4000-8000-0000000000e2', 'e1000000-0000-4000-8000-000000000002', 'Main B', true, 'active');
insert into public.roles (id, organization_id, name) values
  ('e1000000-0000-4000-8000-000000000011', 'e1000000-0000-4000-8000-000000000001', 'Pemilik'),
  ('e1000000-0000-4000-8000-000000000012', 'e1000000-0000-4000-8000-000000000001', 'NorthAll'),
  ('e1000000-0000-4000-8000-000000000013', 'e1000000-0000-4000-8000-000000000001', 'Nothing'),
  ('e1000000-0000-4000-8000-000000000014', 'e1000000-0000-4000-8000-000000000001', 'Groomer'),
  ('e1000000-0000-4000-8000-000000000015', 'e1000000-0000-4000-8000-000000000001', 'Manager'),
  ('e1000000-0000-4000-8000-000000000016', 'e1000000-0000-4000-8000-000000000002', 'Pemilik');
insert into public.role_permissions (organization_id, role_id, permission_id)
  select 'e1000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000011', id from public.permissions
   where key in ('finance.read','branches.all','booking.read','membership.read','settings.manage');
insert into public.role_permissions (organization_id, role_id, permission_id)
  select 'e1000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000012', id from public.permissions
   where key in ('finance.read','booking.read','membership.read');
insert into public.role_permissions (organization_id, role_id, permission_id)
  select 'e1000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000014', id from public.permissions
   where key in ('booking.read','finance.read');
insert into public.role_permissions (organization_id, role_id, permission_id)
  select 'e1000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000015', id from public.permissions
   where key in ('finance.read','branches.all','booking.read','membership.read','settings.manage');
insert into public.role_permissions (organization_id, role_id, permission_id)
  select 'e1000000-0000-4000-8000-000000000002', 'e1000000-0000-4000-8000-000000000016', id from public.permissions
   where key in ('finance.read','branches.all','booking.read','membership.read');
insert into auth.users (id, email, raw_user_meta_data) values
  ('e1000000-0000-4000-8000-000000000021', 'owner@alert.test', '{}'),
  ('e1000000-0000-4000-8000-000000000022', 'north@alert.test', '{}'),
  ('e1000000-0000-4000-8000-000000000023', 'nothing@alert.test', '{}'),
  ('e1000000-0000-4000-8000-000000000024', 'groomer@alert.test', '{}'),
  ('e1000000-0000-4000-8000-000000000025', 'manager@alert.test', '{}'),
  ('e1000000-0000-4000-8000-000000000026', 'owner-b@alert.test', '{}');
update public.users set status = 'active' where id::text like 'e1000000-%';
insert into public.memberships (id, user_id, organization_id, role_id, status) values
  ('e1000000-0000-4000-8000-0000000000f1', 'e1000000-0000-4000-8000-000000000021', 'e1000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000011', 'active'),
  ('e1000000-0000-4000-8000-0000000000f2', 'e1000000-0000-4000-8000-000000000022', 'e1000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000012', 'active'),
  ('e1000000-0000-4000-8000-0000000000f3', 'e1000000-0000-4000-8000-000000000023', 'e1000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000013', 'active'),
  ('e1000000-0000-4000-8000-0000000000f4', 'e1000000-0000-4000-8000-000000000024', 'e1000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000014', 'active'),
  ('e1000000-0000-4000-8000-0000000000f5', 'e1000000-0000-4000-8000-000000000025', 'e1000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000015', 'active'),
  ('e1000000-0000-4000-8000-0000000000f6', 'e1000000-0000-4000-8000-000000000026', 'e1000000-0000-4000-8000-000000000002', 'e1000000-0000-4000-8000-000000000016', 'active');
insert into public.membership_branch_access (organization_id, membership_id, branch_id) values
  ('e1000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-0000000000f2', 'e1000000-0000-4000-8000-0000000000e1'),
  ('e1000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-0000000000f4', 'e1000000-0000-4000-8000-0000000000e1');
insert into public.customers (id, organization_id, display_name) values
  ('e1000000-0000-4000-8000-0000000000c1', 'e1000000-0000-4000-8000-000000000001', 'Cust 1'),
  ('e1000000-0000-4000-8000-0000000000b1', 'e1000000-0000-4000-8000-000000000002', 'B Cust');

-- Invoices. North IDR 250000 (100000 paid, a pending 50000 ignored) overdue since 2020 -> remaining 150000.
-- South IDR 100000 overdue since 2021. North USD 50 overdue. Excluded: void, paid status, zero total, fully paid but still
-- 'issued', future due date, no due date.
insert into public.invoices (id, organization_id, branch_id, customer_id, invoice_number, status, currency, subtotal, total, issued_at, due_at, paid_at) values
  ('e1000000-0000-4000-8000-00000000f001', 'e1000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-0000000000e1', 'e1000000-0000-4000-8000-0000000000c1', 'A-001', 'issued', 'IDR', 250000, 250000, '2019-12-01 03:00Z', '2020-01-01 00:00Z', null),
  ('e1000000-0000-4000-8000-00000000f002', 'e1000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-0000000000e3', 'e1000000-0000-4000-8000-0000000000c1', 'A-002', 'issued', 'IDR', 100000, 100000, '2020-12-01 03:00Z', '2021-01-01 00:00Z', null),
  ('e1000000-0000-4000-8000-00000000f003', 'e1000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-0000000000e1', 'e1000000-0000-4000-8000-0000000000c1', 'A-003', 'issued', 'USD', 50, 50, '2021-12-01 03:00Z', '2022-01-01 00:00Z', null),
  ('e1000000-0000-4000-8000-00000000f004', 'e1000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-0000000000e1', 'e1000000-0000-4000-8000-0000000000c1', 'A-004', 'void',   'IDR', 999000, 999000, '2020-01-01 03:00Z', '2020-02-01 00:00Z', null),
  ('e1000000-0000-4000-8000-00000000f005', 'e1000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-0000000000e1', 'e1000000-0000-4000-8000-0000000000c1', 'A-005', 'paid',   'IDR',  80000,  80000, '2020-01-01 03:00Z', '2020-02-01 00:00Z', '2020-01-02 03:00Z'),
  ('e1000000-0000-4000-8000-00000000f006', 'e1000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-0000000000e1', 'e1000000-0000-4000-8000-0000000000c1', 'A-006', 'issued', 'IDR',      0,      0, '2020-01-01 03:00Z', '2020-02-01 00:00Z', null),
  ('e1000000-0000-4000-8000-00000000f007', 'e1000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-0000000000e1', 'e1000000-0000-4000-8000-0000000000c1', 'A-007', 'issued', 'IDR',  60000,  60000, '2020-01-01 03:00Z', '2020-02-01 00:00Z', null),
  ('e1000000-0000-4000-8000-00000000f008', 'e1000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-0000000000e1', 'e1000000-0000-4000-8000-0000000000c1', 'A-008', 'issued', 'IDR',  70000,  70000, '2020-01-01 03:00Z', '2099-01-01 00:00Z', null),
  ('e1000000-0000-4000-8000-00000000f009', 'e1000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-0000000000e1', 'e1000000-0000-4000-8000-0000000000c1', 'A-009', 'issued', 'IDR',  70000,  70000, '2020-01-01 03:00Z', null, null),
  ('e1000000-0000-4000-8000-00000000f0b1', 'e1000000-0000-4000-8000-000000000002', 'e1000000-0000-4000-8000-0000000000e2', 'e1000000-0000-4000-8000-0000000000b1', 'B-001', 'issued', 'IDR', 5000000, 5000000, '2020-01-01 03:00Z', '2020-02-01 00:00Z', null);
insert into public.payments (id, organization_id, branch_id, invoice_id, method, amount, currency, status, paid_at) values
  ('e1000000-0000-4000-8000-00000000a001', 'e1000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-0000000000e1', 'e1000000-0000-4000-8000-00000000f001', 'cash', 100000, 'IDR', 'succeeded', '2020-01-02 03:00Z'),
  ('e1000000-0000-4000-8000-00000000a002', 'e1000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-0000000000e1', 'e1000000-0000-4000-8000-00000000f001', 'cash',  50000, 'IDR', 'pending',   '2020-01-03 03:00Z'),
  ('e1000000-0000-4000-8000-00000000a003', 'e1000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-0000000000e1', 'e1000000-0000-4000-8000-00000000f007', 'cash',  60000, 'IDR', 'succeeded', '2020-01-02 03:00Z');

-- Packages: one expiring in 3 days (counted), one expiring in 10 days, one already expired, one with 0 sessions,
-- one not active, one soft-deleted, one without expiry. Another tenant has one expiring too.
insert into public.packages (id, organization_id, name, total_sessions, price, currency) values
  ('e1000000-0000-4000-8000-00000000a0a1', 'e1000000-0000-4000-8000-000000000001', 'P3', 3, 100, 'IDR'),
  ('e1000000-0000-4000-8000-00000000a0b1', 'e1000000-0000-4000-8000-000000000002', 'PB', 3, 100, 'IDR');
insert into public.customer_packages (id, organization_id, customer_id, package_id, sessions_remaining, status, expires_at, deleted_at) values
  ('e1000000-0000-4000-8000-0000000ca001', 'e1000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-0000000000c1', 'e1000000-0000-4000-8000-00000000a0a1', 2, 'active', now() + interval '3 days', null),
  ('e1000000-0000-4000-8000-0000000ca002', 'e1000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-0000000000c1', 'e1000000-0000-4000-8000-00000000a0a1', 2, 'active', now() + interval '10 days', null),
  ('e1000000-0000-4000-8000-0000000ca003', 'e1000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-0000000000c1', 'e1000000-0000-4000-8000-00000000a0a1', 2, 'active', now() - interval '1 day', null),
  ('e1000000-0000-4000-8000-0000000ca004', 'e1000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-0000000000c1', 'e1000000-0000-4000-8000-00000000a0a1', 0, 'active', now() + interval '2 days', null),
  ('e1000000-0000-4000-8000-0000000ca005', 'e1000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-0000000000c1', 'e1000000-0000-4000-8000-00000000a0a1', 2, 'canceled', now() + interval '2 days', null),
  ('e1000000-0000-4000-8000-0000000ca006', 'e1000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-0000000000c1', 'e1000000-0000-4000-8000-00000000a0a1', 2, 'active', now() + interval '2 days', now()),
  ('e1000000-0000-4000-8000-0000000ca007', 'e1000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-0000000000c1', 'e1000000-0000-4000-8000-00000000a0a1', 2, 'active', null, null),
  ('e1000000-0000-4000-8000-0000000cb001', 'e1000000-0000-4000-8000-000000000002', 'e1000000-0000-4000-8000-0000000000b1', 'e1000000-0000-4000-8000-00000000a0b1', 2, 'active', now() + interval '2 days', null);

-- Bookings: stale = requested/confirmed/in_progress that started 2 days ago. North 2 stale (requested, in_progress), South 1 stale,
-- excluded: completed, canceled, started only 2 hours ago, started 120 days ago, soft-deleted, draft.
insert into public.bookings (id, organization_id, branch_id, customer_id, booking_type, status, starts_at, ends_at, deleted_at) values
  ('e1000000-0000-4000-8000-00000000d001', 'e1000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-0000000000e1', 'e1000000-0000-4000-8000-0000000000c1', 'grooming', 'requested',   now() - interval '2 days',   now() - interval '2 days' + interval '1 hour', null),
  ('e1000000-0000-4000-8000-00000000d002', 'e1000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-0000000000e1', 'e1000000-0000-4000-8000-0000000000c1', 'grooming', 'in_progress', now() - interval '3 days',   now() - interval '3 days' + interval '1 hour', null),
  ('e1000000-0000-4000-8000-00000000d003', 'e1000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-0000000000e3', 'e1000000-0000-4000-8000-0000000000c1', 'grooming', 'confirmed',   now() - interval '4 days',   now() - interval '4 days' + interval '1 hour', null),
  ('e1000000-0000-4000-8000-00000000d004', 'e1000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-0000000000e1', 'e1000000-0000-4000-8000-0000000000c1', 'grooming', 'completed',   now() - interval '2 days',   now() - interval '2 days' + interval '1 hour', null),
  ('e1000000-0000-4000-8000-00000000d005', 'e1000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-0000000000e1', 'e1000000-0000-4000-8000-0000000000c1', 'grooming', 'canceled',    now() - interval '2 days',   now() - interval '2 days' + interval '1 hour', null),
  ('e1000000-0000-4000-8000-00000000d006', 'e1000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-0000000000e1', 'e1000000-0000-4000-8000-0000000000c1', 'grooming', 'confirmed',   now() - interval '2 hours',  now() - interval '1 hour', null),
  ('e1000000-0000-4000-8000-00000000d007', 'e1000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-0000000000e1', 'e1000000-0000-4000-8000-0000000000c1', 'grooming', 'confirmed',   now() - interval '120 days', now() - interval '120 days' + interval '1 hour', null),
  ('e1000000-0000-4000-8000-00000000d008', 'e1000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-0000000000e1', 'e1000000-0000-4000-8000-0000000000c1', 'grooming', 'confirmed',   now() - interval '2 days',   now() - interval '2 days' + interval '1 hour', now()),
  ('e1000000-0000-4000-8000-00000000d009', 'e1000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-0000000000e1', 'e1000000-0000-4000-8000-0000000000c1', 'grooming', 'draft',       now() - interval '2 days',   now() - interval '2 days' + interval '1 hour', null),
  ('e1000000-0000-4000-8000-00000000d0b1', 'e1000000-0000-4000-8000-000000000002', 'e1000000-0000-4000-8000-0000000000e2', 'e1000000-0000-4000-8000-0000000000b1', 'grooming', 'confirmed',   now() - interval '2 days',   now() - interval '2 days' + interval '1 hour', null);

-- Maintenance: A has a failed export (3 d), a stale running export (5 h), a fine completed export, a partial apply run (2 d),
-- a lapsed-lease running run, a preview-mode failed run (ignored), and an old failed export (40 d, ignored). B has one failed.
insert into public.organization_export_jobs (id, organization_id, status, storage_prefix, created_by, created_at, completed_at, failed_reason) values
  ('e1000000-0000-4000-8000-0000000000a1', 'e1000000-0000-4000-8000-000000000001', 'failed', 'a/exports/1', 'e1000000-0000-4000-8000-000000000021', now() - interval '3 days', null, 'raw reason'),
  ('e1000000-0000-4000-8000-0000000000a2', 'e1000000-0000-4000-8000-000000000001', 'completed', 'a/exports/2', 'e1000000-0000-4000-8000-000000000021', now() - interval '3 days', now() - interval '3 days', null),
  ('e1000000-0000-4000-8000-0000000000a3', 'e1000000-0000-4000-8000-000000000001', 'failed', 'a/exports/3', 'e1000000-0000-4000-8000-000000000021', now() - interval '40 days', null, 'old'),
  ('e1000000-0000-4000-8000-0000000000a5', 'e1000000-0000-4000-8000-000000000002', 'failed', 'b/exports/1', 'e1000000-0000-4000-8000-000000000026', now() - interval '1 day', null, 'other');
insert into public.organization_export_jobs (id, organization_id, status, storage_prefix, created_by, created_at) values
  ('e1000000-0000-4000-8000-0000000000a4', 'e1000000-0000-4000-8000-000000000001', 'running', 'a/exports/4', 'e1000000-0000-4000-8000-000000000021', now() - interval '5 hours');
insert into public.storage_cleanup_runs (id, organization_id, mode, status, lease_expires_at, started_at) values
  ('e1000000-0000-4000-8000-0000000000c1', 'e1000000-0000-4000-8000-000000000001', 'apply', 'partial', null, now() - interval '2 days'),
  ('e1000000-0000-4000-8000-0000000000c2', 'e1000000-0000-4000-8000-000000000001', 'apply', 'running', now() - interval '1 hour', now() - interval '3 hours'),
  ('e1000000-0000-4000-8000-0000000000c3', 'e1000000-0000-4000-8000-000000000001', 'dry_run', 'completed', null, now() - interval '1 day'),
  ('e1000000-0000-4000-8000-0000000000c4', 'e1000000-0000-4000-8000-000000000002', 'apply', 'failed', null, now() - interval '1 day');

set local role authenticated;

-- ===== Card key =========================================================================================================
select pg_temp.act_as('e1000000-0000-4000-8000-000000000021', 'e1000000-0000-4000-8000-000000000001');
do $$
declare v jsonb;
  legacy constant jsonb := '{"booking_today":true,"revenue_today":true,"active_customers":true,"open_tasks":true}';
begin
  perform app.update_dashboard_card_settings(legacy || '{"operational_alerts":false}');
  select settings #> '{dashboard,cards}' into v from public.organizations where id = app.fn_active_organization();
  perform pg_temp.check(v = legacy || '{"operational_alerts":false}', 'operational_alerts stored when sent');
  perform app.update_dashboard_card_settings(legacy);
  select settings #> '{dashboard,cards}' into v from public.organizations where id = app.fn_active_organization();
  perform pg_temp.check(v = legacy || '{"operational_alerts":false}', 'omitting operational_alerts preserves its stored value');
  perform app.update_dashboard_card_settings(legacy || '{"performance_operations":true,"performance_finance":true,"performance_sources":false,"operational_alerts":true}');
  perform app.update_dashboard_card_settings(legacy || '{"operational_alerts":true}');
  select settings #> '{dashboard,cards}' into v from public.organizations where id = app.fn_active_organization();
  perform pg_temp.check(v = legacy || '{"performance_operations":true,"performance_finance":true,"performance_sources":false,"operational_alerts":true}',
    'alerts-only payload preserves the three performance keys');
  perform pg_temp.expect($q$select app.update_dashboard_card_settings('{"booking_today":true,"revenue_today":true,"active_customers":true,"open_tasks":true,"operational_alerts":"yes"}')$q$, '22023', 'non-boolean operational_alerts rejected');
  perform pg_temp.expect($q$select app.update_dashboard_card_settings('{"booking_today":true,"revenue_today":true,"active_customers":true,"open_tasks":true,"operational_alerts":true,"nope":true}')$q$, '22023', 'unknown key still rejected');
  perform pg_temp.expect($q$select app.update_dashboard_card_settings('{"booking_today":true,"revenue_today":true,"active_customers":true,"open_tasks":true,"performance_operations":true,"operational_alerts":true}')$q$, '22023', 'performance keys still all-or-none');
end $$;

-- ===== Owner: all four alerts ===========================================================================================
do $$
declare r record; n integer;
begin
  select * into r from app.dashboard_operational_alerts(array['overdue_invoices']) where currency = 'IDR';
  perform pg_temp.check(r.item_count = 2 and r.amount = 250000 and r.oldest_at = '2020-01-01 00:00Z', 'overdue IDR: north remaining 150000 + south 100000, oldest 2020-01-01');
  select * into r from app.dashboard_operational_alerts(array['overdue_invoices']) where currency = 'USD';
  perform pg_temp.check(r.item_count = 1 and r.amount = 50, 'overdue USD kept separate');
  select count(*) into n from app.dashboard_operational_alerts(array['overdue_invoices']);
  perform pg_temp.check(n = 2, 'void, paid, zero-total, fully paid, future and undated invoices are not overdue; currencies not merged');
  select * into r from app.dashboard_operational_alerts(array['expiring_packages']);
  perform pg_temp.check(r.item_count = 1 and r.currency is null and r.amount is null, 'one package expires within 7 days (expired, empty, canceled, deleted, undated, 10-day excluded)');
  select * into r from app.dashboard_operational_alerts(array['stale_open_bookings']);
  perform pg_temp.check(r.item_count = 3, 'three stale open bookings across both branches (completed, canceled, draft, fresh, 120-day, deleted excluded)');
  select * into r from app.dashboard_operational_alerts(array['maintenance_problems']);
  perform pg_temp.check(r.item_count = 4, 'maintenance: failed export, stale running export, partial apply run, lapsed-lease run (old, completed, preview, other tenant excluded)');
  select count(*) into n from app.dashboard_operational_alerts(array['overdue_invoices','expiring_packages','stale_open_bookings','maintenance_problems']);
  perform pg_temp.check(n = 5, 'all four keys together return 2 + 1 + 1 + 1 rows');
end $$;
-- A tenant with nothing to report still gets an explicit measured zero, never an empty result.
select pg_temp.act_as('e1000000-0000-4000-8000-000000000026', 'e1000000-0000-4000-8000-000000000002');
do $$
declare r record; n integer;
begin
  select * into r from app.dashboard_operational_alerts(array['overdue_invoices']);
  perform pg_temp.check(r.item_count = 1 and r.amount = 5000000 and r.currency = 'IDR', 'tenant B sees only its own overdue invoice');
  select * into r from app.dashboard_operational_alerts(array['expiring_packages']);
  perform pg_temp.check(r.item_count = 1, 'tenant B sees only its own expiring package');
  select * into r from app.dashboard_operational_alerts(array['stale_open_bookings']);
  perform pg_temp.check(r.item_count = 1, 'tenant B sees only its own stale booking');
  select * into r from app.dashboard_operational_alerts(array['maintenance_problems']);
  perform pg_temp.check(r.item_count = 2, 'tenant B owner sees only its own failed export and failed apply run');
end $$;

-- ===== Branch-limited reader ==============================================================================================
select pg_temp.act_as('e1000000-0000-4000-8000-000000000022', 'e1000000-0000-4000-8000-000000000001');
do $$
declare r record; n integer;
begin
  select * into r from app.dashboard_operational_alerts(array['overdue_invoices']) where currency = 'IDR';
  perform pg_temp.check(r.item_count = 1 and r.amount = 150000, 'north-only reader sees only north overdue (south invoice hidden)');
  select * into r from app.dashboard_operational_alerts(array['stale_open_bookings']);
  perform pg_temp.check(r.item_count = 2, 'north-only reader sees two of three stale bookings');
  select * into r from app.dashboard_operational_alerts(array['expiring_packages']);
  perform pg_temp.check(r.item_count = 1, 'packages are not branch-scoped (same as the table policy)');
  perform pg_temp.expect($q$select * from app.dashboard_operational_alerts(array['maintenance_problems'])$q$, '42501', 'non-owner finance reader refused maintenance');
  perform pg_temp.expect($q$select * from app.dashboard_operational_alerts(array['overdue_invoices','maintenance_problems'])$q$, '42501', 'one forbidden key refuses the whole call');
end $$;

-- ===== Capability denial ==================================================================================================
select pg_temp.act_as('e1000000-0000-4000-8000-000000000023', 'e1000000-0000-4000-8000-000000000001');
do $$ begin
  perform pg_temp.expect($q$select * from app.dashboard_operational_alerts(array['overdue_invoices'])$q$, '42501', 'no finance.read refused');
  perform pg_temp.expect($q$select * from app.dashboard_operational_alerts(array['expiring_packages'])$q$, '42501', 'no membership.read refused');
  perform pg_temp.expect($q$select * from app.dashboard_operational_alerts(array['stale_open_bookings'])$q$, '42501', 'no booking.read refused');
end $$;
select pg_temp.act_as('e1000000-0000-4000-8000-000000000024', 'e1000000-0000-4000-8000-000000000001');
do $$ begin
  perform pg_temp.expect($q$select * from app.dashboard_operational_alerts(array['stale_open_bookings'])$q$, '42501', 'Groomer-role member refused stale bookings');
  perform 1 from app.dashboard_operational_alerts(array['overdue_invoices']);
  raise notice 'PASS: Groomer role with explicit finance.read can still read overdue invoices';
end $$;
-- A manager with settings.manage etc. but no owner role name is not an owner.
select pg_temp.act_as('e1000000-0000-4000-8000-000000000025', 'e1000000-0000-4000-8000-000000000001');
do $$ begin
  perform pg_temp.expect($q$select * from app.dashboard_operational_alerts(array['maintenance_problems'])$q$, '42501', 'manager with settings.manage is not a business owner');
end $$;
-- Forged organization: owner of A with active_org_id = B has no membership there.
select pg_temp.act_as('e1000000-0000-4000-8000-000000000021', 'e1000000-0000-4000-8000-000000000002');
do $$ begin
  perform pg_temp.expect($q$select * from app.dashboard_operational_alerts(array['overdue_invoices'])$q$, '42501', 'forged active organization refused');
end $$;
-- Argument validation.
select pg_temp.act_as('e1000000-0000-4000-8000-000000000021', 'e1000000-0000-4000-8000-000000000001');
do $$ begin
  perform pg_temp.expect($q$select * from app.dashboard_operational_alerts(null)$q$, '22023', 'null keys rejected');
  perform pg_temp.expect($q$select * from app.dashboard_operational_alerts(array[]::text[])$q$, '22023', 'empty keys rejected');
  perform pg_temp.expect($q$select * from app.dashboard_operational_alerts(array['overdue_invoices','overdue_invoices'])$q$, '22023', 'duplicate keys rejected');
  perform pg_temp.expect($q$select * from app.dashboard_operational_alerts(array['payroll_total'])$q$, '22023', 'unknown key rejected');
  perform pg_temp.expect($q$select * from app.dashboard_operational_alerts(array[null]::text[])$q$, '22023', 'null element rejected');
end $$;
-- ===== Grants / structure =================================================================================================
reset role;
do $$
declare v_def boolean; v_path text[]; v_anon boolean; v_auth boolean; v_pub boolean;
begin
  select p.prosecdef, p.proconfig into v_def, v_path from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'app' and p.proname = 'dashboard_operational_alerts';
  perform pg_temp.check(v_def and v_path && array['search_path=""', 'search_path='], 'alert reader is SECURITY DEFINER with an empty search_path');
  select has_function_privilege('anon', 'app.dashboard_operational_alerts(text[])', 'execute'),
         has_function_privilege('authenticated', 'app.dashboard_operational_alerts(text[])', 'execute') into v_anon, v_auth;
  select exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                  where p.oid = 'app.dashboard_operational_alerts(text[])'::regprocedure and a.grantee = 0) into v_pub;
  perform pg_temp.check(not v_anon and not v_pub and v_auth, 'anon and PUBLIC cannot execute; authenticated can');
  perform pg_temp.check(app.schema_version() >= '20261031100000', 'schema version moved to (or past) this migration');
  perform pg_temp.check((select count(*) from regexp_matches(pg_get_functiondef('app.dashboard_operational_alerts(text[])'::regprocedure), 'organization_id = v_org', 'g')) >= 6,
    'every table read states organization_id = v_org');
end $$;
rollback;
