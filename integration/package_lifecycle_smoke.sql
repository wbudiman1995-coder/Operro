-- =====================================================================
-- TEST — sections 23-26 (coverage detection, packages/memberships,
-- membership administration, subscription reconciliation) smoke test.
-- Follows the same fixture/assertion convention as
-- supabase/tests/20260721001350_test_reservation.sql (pg_temp.ok /
-- pg_temp.act_as, JWT claims via set_config). Cross-statement values
-- (generated customer_packages ids) are passed via a temp table rather
-- than psql \gset/:'var' -- deliberately avoided, matching every other
-- test file in this repo, so this runs identically under any SQL runner.
-- Run against a DB that already has the full migration lineage applied:
--   psql -v ON_ERROR_STOP=1 -f integration/package_lifecycle_smoke.sql
-- =====================================================================
\set ON_ERROR_STOP on
create or replace function pg_temp.ok(cond boolean, label text)
returns void language plpgsql as $$
begin if cond then raise notice 'PASS: %', label; else raise exception 'FAIL: %', label; end if; end $$;
create or replace function pg_temp.act_as(u text, o text) returns void language plpgsql as $$
begin perform set_config('request.jwt.claims', json_build_object('sub', u, 'active_org_id', o)::text, true); end $$;
create temp table smoke_ids (key text primary key, val uuid);
grant select, insert on smoke_ids to authenticated;
create or replace function pg_temp.id_of(k text) returns uuid language sql stable as $$ select val from smoke_ids where key = k $$;

begin;

-- --- fixtures: TWO organizations, each fully wired (module + permissions) ---
insert into public.organizations (id, name, slug, status) values
  ('02000000-0000-4000-8000-000000000001', 'P Org A', 'p-org-a', 'active'),
  ('02000000-0000-4000-8000-000000000002', 'P Org B', 'p-org-b', 'active');
insert into public.branches (id, organization_id, name, is_default, status) values
  ('02000000-0000-4000-8000-0000000000a1', '02000000-0000-4000-8000-000000000001', 'Main A', true, 'active'),
  ('02000000-0000-4000-8000-0000000000a2', '02000000-0000-4000-8000-000000000002', 'Main B', true, 'active');
insert into auth.users (id) values ('02000000-0000-4000-8000-0000000000c1'), ('02000000-0000-4000-8000-0000000000c2') on conflict (id) do nothing;
insert into public.users (id, full_name, email, status) values
  ('02000000-0000-4000-8000-0000000000c1', 'Owner A', 'owner-a@p.test', 'active'),
  ('02000000-0000-4000-8000-0000000000c2', 'Owner B', 'owner-b@p.test', 'active')
  on conflict (id) do update set full_name = excluded.full_name, email = excluded.email, status = excluded.status;
insert into public.roles (id, organization_id, name, is_system) values
  ('02000000-0000-4000-8000-0000000000e1', '02000000-0000-4000-8000-000000000001', 'Owner', true),
  ('02000000-0000-4000-8000-0000000000e2', '02000000-0000-4000-8000-000000000002', 'Owner', true);
insert into public.memberships (id, organization_id, user_id, role_id, status) values
  ('02000000-0000-4000-8000-0000000000d1', '02000000-0000-4000-8000-000000000001', '02000000-0000-4000-8000-0000000000c1', '02000000-0000-4000-8000-0000000000e1', 'active'),
  ('02000000-0000-4000-8000-0000000000d2', '02000000-0000-4000-8000-000000000002', '02000000-0000-4000-8000-0000000000c2', '02000000-0000-4000-8000-0000000000e2', 'active');
insert into public.membership_branch_access (organization_id, membership_id, branch_id) values
  ('02000000-0000-4000-8000-000000000001', '02000000-0000-4000-8000-0000000000d1', '02000000-0000-4000-8000-0000000000a1'),
  ('02000000-0000-4000-8000-000000000002', '02000000-0000-4000-8000-0000000000d2', '02000000-0000-4000-8000-0000000000a2');
insert into public.permissions (id, key, resource, action, description) values
  ('02000000-0000-4000-8000-0000000000f1', 'booking.update', 'booking', 'update', 'u'),
  ('02000000-0000-4000-8000-0000000000f2', 'membership.read', 'membership', 'read', 'r'),
  ('02000000-0000-4000-8000-0000000000f3', 'membership.manage', 'membership', 'manage', 'm'),
  ('02000000-0000-4000-8000-0000000000f4', 'invoice.issue', 'invoice', 'issue', 'i')
  on conflict (key) do nothing;
insert into public.role_permissions (organization_id, role_id, permission_id)
  select r.organization_id, r.id, p.id from public.roles r, public.permissions p
  where r.id in ('02000000-0000-4000-8000-0000000000e1', '02000000-0000-4000-8000-0000000000e2')
    and p.key in ('booking.update', 'membership.read', 'membership.manage', 'invoice.issue');
insert into public.organization_modules (organization_id, module_id, enabled)
  select o.id, m.id, true from public.organizations o, public.modules m
  where o.id in ('02000000-0000-4000-8000-000000000001', '02000000-0000-4000-8000-000000000002')
    and m.key in ('scheduling', 'membership', 'finance')
  on conflict (organization_id, module_id) do update set enabled = true;
insert into public.subscriptions (organization_id, status) values
  ('02000000-0000-4000-8000-000000000001', 'active'), ('02000000-0000-4000-8000-000000000002', 'active') on conflict do nothing;

insert into public.customers (id, organization_id, display_name) values
  ('02000000-0000-4000-8000-00000000c101', '02000000-0000-4000-8000-000000000001', 'Cust A1'),
  ('02000000-0000-4000-8000-00000000c201', '02000000-0000-4000-8000-000000000002', 'Cust B1');
insert into public.pets (id, organization_id, customer_id, name) values
  ('02000000-0000-4000-8000-00000000f101', '02000000-0000-4000-8000-000000000001', '02000000-0000-4000-8000-00000000c101', 'Pet A1'),
  ('02000000-0000-4000-8000-00000000f102', '02000000-0000-4000-8000-000000000001', '02000000-0000-4000-8000-00000000c101', 'Pet A2');
insert into public.service_catalog (id, organization_id, name, base_price, currency, duration_minutes, is_active) values
  ('02000000-0000-4000-8000-00000000ea01', '02000000-0000-4000-8000-000000000001', 'Grooming', 100000, 'IDR', 60, true);
insert into public.packages (id, organization_id, name, service_id, total_sessions, price, currency, recurrence_interval, per_pet) values
  ('02000000-0000-4000-8000-00000000ca01', '02000000-0000-4000-8000-000000000001', '3x Grooming Monthly', '02000000-0000-4000-8000-00000000ea01', 3, 300000, 'IDR', 'month', false),
  ('02000000-0000-4000-8000-00000000ca02', '02000000-0000-4000-8000-000000000001', '1x Grooming Per-Pet', '02000000-0000-4000-8000-00000000ea01', 1, 150000, 'IDR', 'none', true);
insert into public.bookings (id, organization_id, branch_id, customer_id, booking_type, fulfillment_mode, starts_at, ends_at, status) values
  ('02000000-0000-4000-8000-00000000ba01', '02000000-0000-4000-8000-000000000001', '02000000-0000-4000-8000-0000000000a1', '02000000-0000-4000-8000-00000000c101', 'grooming', 'in_store', now() + interval '1 day', now() + interval '1 day 1 hour', 'confirmed');
insert into public.grooming_jobs (booking_id, organization_id) values ('02000000-0000-4000-8000-00000000ba01', '02000000-0000-4000-8000-000000000001');
insert into public.grooming_job_pets (id, organization_id, grooming_job_id, pet_id, sequence, status) values
  ('02000000-0000-4000-8000-00000000da01', '02000000-0000-4000-8000-000000000001', '02000000-0000-4000-8000-00000000ba01', '02000000-0000-4000-8000-00000000f101', 1, 'pending'),
  ('02000000-0000-4000-8000-00000000da02', '02000000-0000-4000-8000-000000000001', '02000000-0000-4000-8000-00000000ba01', '02000000-0000-4000-8000-00000000f102', 2, 'pending');
insert into public.grooming_job_pet_services (id, organization_id, grooming_job_pet_id, service_id, service_name_snapshot, unit_price_snapshot, currency, quantity, duration_minutes) values
  ('02000000-0000-4000-8000-000000001a01', '02000000-0000-4000-8000-000000000001', '02000000-0000-4000-8000-00000000da01', '02000000-0000-4000-8000-00000000ea01', 'Grooming', 100000, 'IDR', 1, 60),
  ('02000000-0000-4000-8000-000000001a02', '02000000-0000-4000-8000-000000000001', '02000000-0000-4000-8000-00000000da02', '02000000-0000-4000-8000-00000000ea01', 'Grooming', 100000, 'IDR', 1, 60);

do $$ begin perform pg_temp.act_as('02000000-0000-4000-8000-0000000000c1', '02000000-0000-4000-8000-000000000001'); end $$;

-- --- section 24: purchase a per-pet package for Pet A1 only (via the invoice path) ---
do $$ begin
  perform app.create_package_invoice(
    '02000000-0000-4000-8000-0000000000a1', '02000000-0000-4000-8000-00000000c101', '02000000-0000-4000-8000-00000000ca02',
    now(), null, null, 'ff010000-0000-4000-8000-000000000001', '02000000-0000-4000-8000-00000000f101');
  insert into smoke_ids (key, val) select 'per_pet_cp', id from public.customer_packages
    where organization_id = '02000000-0000-4000-8000-000000000001' and package_id = '02000000-0000-4000-8000-00000000ca02';
end $$;

-- section 23/24: per-pet eligibility -- Pet A2 (not the eligible pet) is rejected, Pet A1 succeeds.
do $$ begin
  perform app.reserve_package_session('02000000-0000-4000-8000-000000001a02', pg_temp.id_of('per_pet_cp'));
  perform pg_temp.ok(false, 'S1 per-pet package should reject a different pet');
exception when check_violation then
  perform pg_temp.ok(sqlerrm like '%package_not_applicable_to_pet%', 'S1 per-pet package rejects the wrong pet');
end $$;
do $$ begin
  perform app.reserve_package_session('02000000-0000-4000-8000-000000001a01', pg_temp.id_of('per_pet_cp'));
  perform pg_temp.ok(true, 'S2 per-pet package reserves for its own pet');
end $$;

-- --- section 24: shared (non-per-pet) 3-session package purchase for the customer ---
do $$ begin
  perform app.create_package_invoice(
    '02000000-0000-4000-8000-0000000000a1', '02000000-0000-4000-8000-00000000c101', '02000000-0000-4000-8000-00000000ca01',
    now(), null, null, 'ff020000-0000-4000-8000-000000000002');
  insert into smoke_ids (key, val) select 'shared_cp', id from public.customer_packages
    where organization_id = '02000000-0000-4000-8000-000000000001' and package_id = '02000000-0000-4000-8000-00000000ca01';
end $$;

-- section 23: coverage listing reflects reserved vs available.
do $$ declare v_avail integer; begin
  select available_sessions into v_avail from app.list_customer_package_coverage('02000000-0000-4000-8000-00000000c101') c where c.customer_package_id = pg_temp.id_of('shared_cp');
  perform pg_temp.ok(v_avail = 3, 'S3 coverage listing shows 3 available before any reservation');
end $$;

-- --- section 26: reconciliation -- healthy case ---
do $$ declare v_report jsonb; begin
  v_report := app.reconcile_customer_package(pg_temp.id_of('shared_cp'));
  perform pg_temp.ok((v_report->>'balance_matches')::boolean, 'S4 reconcile reports a healthy (matching) balance');
  -- revision starts at 1 by column default, then the purchase's own ledger row bumps it to 2
  -- (every ledger-driven change bumps revision -- including the very first one).
  perform pg_temp.ok((v_report->>'revision')::int = 2, 'S5 revision reflects the purchase''s own ledger-driven bump (default 1 + 1)');
end $$;

-- --- section 26: intentional mismatch (simulate drift bypassing the ledger) ---
update public.customer_packages set sessions_remaining = sessions_remaining - 1 where id = pg_temp.id_of('shared_cp');
do $$ declare v_report jsonb; begin
  v_report := app.reconcile_customer_package(pg_temp.id_of('shared_cp'));
  perform pg_temp.ok(not (v_report->>'balance_matches')::boolean, 'S6 reconcile detects the induced mismatch');
  perform pg_temp.ok((v_report->>'cached_balance')::int = 2 and (v_report->>'ledger_balance')::int = 3, 'S7 reconcile reports the exact cached vs ledger values');
end $$;

-- --- section 26: stale repair request is rejected ---
do $$ begin
  perform app.repair_customer_package_balance(pg_temp.id_of('shared_cp'), 999, 'ff030000-0000-4000-8000-000000000003');
  perform pg_temp.ok(false, 'S8 repair with a stale/wrong revision should be rejected');
exception when sqlstate '40001' then
  perform pg_temp.ok(sqlerrm like '%stale_repair_request%', 'S8 repair rejects a stale revision (40001 stale_repair_request)');
end $$;

-- --- section 26: correctly-revisioned repair fixes the drift, is idempotent ---
do $$ declare v_row public.customer_packages; v_revision int; begin
  select revision into v_revision from public.customer_packages where id = pg_temp.id_of('shared_cp');
  v_row := app.repair_customer_package_balance(pg_temp.id_of('shared_cp'), v_revision, 'ff040000-0000-4000-8000-000000000004');
  perform pg_temp.ok(v_row.sessions_remaining = 3, 'S9 repair restores the cached balance to match the ledger');
  -- idempotent retry with the SAME request_key must not double-apply
  v_row := app.repair_customer_package_balance(pg_temp.id_of('shared_cp'), v_row.revision, 'ff040000-0000-4000-8000-000000000004');
  perform pg_temp.ok(v_row.sessions_remaining = 3, 'S10 repeating the same repair request_key is idempotent (no double-adjustment)');
end $$;
do $$ declare v_report jsonb; begin
  v_report := app.reconcile_customer_package(pg_temp.id_of('shared_cp'));
  perform pg_temp.ok((v_report->>'balance_matches')::boolean, 'S11 reconcile confirms the package is healthy again after repair');
end $$;

-- --- section 25: renewal (manual, ledger-backed, no scheduler) ---
update public.customer_packages set status = 'exhausted', sessions_remaining = 0, expires_at = now() - interval '1 day' where id = pg_temp.id_of('shared_cp');
do $$ declare v_row public.customer_packages; begin
  v_row := app.renew_customer_package(pg_temp.id_of('shared_cp'), 'ff050000-0000-4000-8000-000000000005');
  perform pg_temp.ok(v_row.status = 'active', 'S12 renewal reactivates an exhausted/expired package');
  perform pg_temp.ok(v_row.sessions_remaining = 3, 'S13 renewal tops up a fresh term''s worth of sessions');
  perform pg_temp.ok(v_row.expires_at > now(), 'S14 renewal extends expiry into the future');
  perform pg_temp.ok(v_row.renewal_count = 1, 'S15 renewal increments renewal_count');
  -- idempotent retry
  v_row := app.renew_customer_package(pg_temp.id_of('shared_cp'), 'ff050000-0000-4000-8000-000000000005');
  perform pg_temp.ok(v_row.renewal_count = 1, 'S16 repeating the same renewal request_key is idempotent');
end $$;

-- --- section 25: guarded archive -- refused while a session is reserved ---
do $$ begin
  perform app.reserve_package_session('02000000-0000-4000-8000-000000001a02', pg_temp.id_of('shared_cp'));
  insert into smoke_ids (key, val) select 'guard_reservation', id from public.package_reservations
    where customer_package_id = pg_temp.id_of('shared_cp') and status = 'reserved';
end $$;
do $$ begin
  perform app.set_customer_package_status(pg_temp.id_of('shared_cp'), 'canceled', 'test archive');
  perform pg_temp.ok(false, 'S17 archiving a package with an active reservation should be rejected');
exception when check_violation then
  perform pg_temp.ok(sqlerrm like '%package_has_active_reservations%', 'S17 archive refuses a package with a reserved session outstanding');
end $$;
update public.package_reservations set status = 'released', released_at = now() where id = pg_temp.id_of('guard_reservation');
do $$ declare v_row public.customer_packages; begin
  v_row := app.set_customer_package_status(pg_temp.id_of('shared_cp'), 'canceled', 'test archive after release');
  perform pg_temp.ok(v_row.status = 'canceled', 'S18 archive succeeds once no reservation remains outstanding');
end $$;

-- --- cross-organization denial: org B's owner cannot reconcile/repair org A's package ---
do $$ begin perform pg_temp.act_as('02000000-0000-4000-8000-0000000000c2', '02000000-0000-4000-8000-000000000002'); end $$;
do $$ begin
  perform app.reconcile_customer_package(pg_temp.id_of('shared_cp'));
  perform pg_temp.ok(false, 'S19 cross-org reconcile should not find another organization''s package');
exception when no_data_found then
  perform pg_temp.ok(sqlerrm like '%package_not_found%', 'S19 cross-org reconcile correctly denies access (package_not_found)');
end $$;
do $$ begin
  perform app.repair_customer_package_balance(pg_temp.id_of('shared_cp'), 1, 'ff060000-0000-4000-8000-000000000006');
  perform pg_temp.ok(false, 'S20 cross-org repair should not find another organization''s package');
exception when no_data_found then
  perform pg_temp.ok(sqlerrm like '%package_not_found%', 'S20 cross-org repair correctly denies access (package_not_found)');
end $$;

-- --- authenticated-role, two-organization RLS proof (not just the RPC's own check) ---
set role authenticated;
do $$ begin perform pg_temp.act_as('02000000-0000-4000-8000-0000000000c2', '02000000-0000-4000-8000-000000000002'); end $$;
do $$ declare v_count int; begin
  select count(*) into v_count from public.customer_packages where id = pg_temp.id_of('shared_cp');
  perform pg_temp.ok(v_count = 0, 'S21 as authenticated role in org B, org A''s customer_packages row is invisible under RLS');
end $$;
do $$ begin perform pg_temp.act_as('02000000-0000-4000-8000-0000000000c1', '02000000-0000-4000-8000-000000000001'); end $$;
do $$ declare v_count int; begin
  select count(*) into v_count from public.customer_packages where id = pg_temp.id_of('shared_cp');
  perform pg_temp.ok(v_count = 1, 'S22 as authenticated role in org A (its own org), the package IS visible under RLS');
end $$;
reset role;

rollback;
-- END package_lifecycle_smoke
