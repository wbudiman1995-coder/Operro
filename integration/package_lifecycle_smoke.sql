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

-- --- a same-organization, READ-ONLY member (membership.read but NOT
-- membership.manage/invoice.issue) -- security item A: two orgs AND a
-- same-org read-only user, calling RPCs directly (never through the UI). ---
insert into public.roles (id, organization_id, name, is_system) values
  ('02000000-0000-4000-8000-0000000000e3', '02000000-0000-4000-8000-000000000001', 'ReadOnly', false);
insert into auth.users (id) values ('02000000-0000-4000-8000-0000000000c3') on conflict (id) do nothing;
insert into public.users (id, full_name, email, status) values
  ('02000000-0000-4000-8000-0000000000c3', 'Read Only A', 'readonly-a@p.test', 'active')
  on conflict (id) do update set full_name = excluded.full_name, email = excluded.email, status = excluded.status;
insert into public.memberships (id, organization_id, user_id, role_id, status) values
  ('02000000-0000-4000-8000-0000000000d3', '02000000-0000-4000-8000-000000000001', '02000000-0000-4000-8000-0000000000c3', '02000000-0000-4000-8000-0000000000e3', 'active');
insert into public.membership_branch_access (organization_id, membership_id, branch_id) values
  ('02000000-0000-4000-8000-000000000001', '02000000-0000-4000-8000-0000000000d3', '02000000-0000-4000-8000-0000000000a1');
insert into public.role_permissions (organization_id, role_id, permission_id)
  select r.organization_id, r.id, p.id from public.roles r, public.permissions p
  where r.id = '02000000-0000-4000-8000-0000000000e3' and p.key = 'membership.read';
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

-- --- section 24 follow-up: renewal is now a real commercial transaction ---
-- (order + invoice + invoice_lines + ledger row), not just a session top-up.
-- Branch is a required, explicit argument -- never guessed from a (possibly
-- absent) source invoice.
-- Simulate genuine exhaustion through the ledger (an adjustment row), never
-- by overwriting sessions_remaining directly -- a raw cache overwrite would
-- itself be an induced mismatch and defeat the point of this test (renewal
-- must still converge cache = ledger afterward).
insert into public.customer_package_ledger (organization_id, customer_package_id, delta, reason, notes)
values ('02000000-0000-4000-8000-000000000001', pg_temp.id_of('shared_cp'), -3, 'adjustment', 'test: simulate full exhaustion via the ledger');
update public.customer_packages set status = 'exhausted', expires_at = now() - interval '1 day' where id = pg_temp.id_of('shared_cp');
do $$ declare v_invoice public.invoices; v_cp public.customer_packages; v_ledger record; v_renewal_count int; begin
  v_invoice := app.renew_customer_package(pg_temp.id_of('shared_cp'), '02000000-0000-4000-8000-0000000000a1', now(), null, null, 'ff050000-0000-4000-8000-000000000005');
  insert into smoke_ids (key, val) select 'renewal_invoice', v_invoice.id;
  perform pg_temp.ok(v_invoice.status = 'issued', 'S12 renewal produces a real invoice with status issued (not paid -- an issued invoice is never proof of payment)');
  perform pg_temp.ok(v_invoice.total = 300000, 'S13 renewal invoice total matches the catalog price');
  perform pg_temp.ok(v_invoice.metadata->>'renewal_of' = pg_temp.id_of('shared_cp')::text, 'S14 renewal invoice metadata links back to the membership it renews');

  select * into v_cp from public.customer_packages where id = pg_temp.id_of('shared_cp');
  perform pg_temp.ok(v_cp.status = 'active', 'S15 renewal reactivates an exhausted/expired package');
  perform pg_temp.ok(v_cp.sessions_remaining = 3, 'S16 renewal tops up a fresh term''s worth of sessions (rollover: additive on top of whatever was left)');
  perform pg_temp.ok(v_cp.expires_at > now(), 'S17 renewal extends expiry into the future');
  perform pg_temp.ok(v_cp.renewal_count = 1, 'S18 renewal increments renewal_count');

  select * into v_ledger from public.customer_package_ledger where customer_package_id = pg_temp.id_of('shared_cp') and reason = 'renewal';
  perform pg_temp.ok(v_ledger.invoice_id = v_invoice.id, 'S19 the renewal ledger row links to the renewal invoice (invoice_id)');

  -- idempotent retry: same request_key, same inputs -> the SAME invoice, no
  -- second order/invoice/ledger row, renewal_count unchanged.
  v_invoice := app.renew_customer_package(pg_temp.id_of('shared_cp'), '02000000-0000-4000-8000-0000000000a1', now(), null, null, 'ff050000-0000-4000-8000-000000000005');
  perform pg_temp.ok(v_invoice.id = pg_temp.id_of('renewal_invoice'), 'S20 repeating the same renewal request_key returns the SAME invoice (idempotent)');
  select renewal_count into v_renewal_count from public.customer_packages where id = pg_temp.id_of('shared_cp');
  perform pg_temp.ok(v_renewal_count = 1, 'S21 the idempotent retry did not double-apply (renewal_count still 1)');
end $$;

-- --- a request_key reused for a DIFFERENT membership is rejected, not silently returned ---
do $$ begin
  perform app.renew_customer_package(pg_temp.id_of('per_pet_cp'), '02000000-0000-4000-8000-0000000000a1', now(), null, null, 'ff050000-0000-4000-8000-000000000005');
  perform pg_temp.ok(false, 'S22 reusing a renewal request_key for a different membership should be rejected');
exception when sqlstate '22023' then
  perform pg_temp.ok(sqlerrm like '%request_key_reused_for_different_renewal%', 'S22 renewal request_key reused for a different membership is rejected');
end $$;

-- --- section 26 follow-up: deep reconciliation actually verifies LINKS, not just counts ---
-- S23: a healthy, fully-linked package (the one we just renewed) has no
-- manual-review issues and reconcile still separates auto-repairable drift.
do $$ declare v_report jsonb; begin
  v_report := app.reconcile_customer_package(pg_temp.id_of('shared_cp'));
  perform pg_temp.ok((v_report->>'balance_matches')::boolean and not (v_report->>'auto_repairable')::boolean, 'S23 a healthy package is not auto_repairable (nothing to repair)');
  perform pg_temp.ok(jsonb_array_length(v_report->'manual_review_issues') = 0, 'S24 a fully-linked, non-legacy package has zero manual_review_issues');
end $$;

-- S25: an orphan consumption ledger row (one no reservation links back to,
-- simulating a session deducted outside the normal reservation lifecycle) is
-- caught by the new LINK check, not just a count comparison.
insert into public.customer_package_ledger (organization_id, customer_package_id, delta, reason, notes)
values ('02000000-0000-4000-8000-000000000001', pg_temp.id_of('shared_cp'), -1, 'consumption', 'orphan: no reservation links to this row');
do $$ declare v_report jsonb; begin
  v_report := app.reconcile_customer_package(pg_temp.id_of('shared_cp'));
  perform pg_temp.ok(v_report->'manual_review_issues' @> '"orphan_consumption_ledger_entries"', 'S25 an orphan consumption ledger row (no reservation link) is flagged for manual review');
  perform pg_temp.ok(not (v_report->>'reservation_consumption_matches')::boolean, 'S26 reservation_consumption_matches turns false once a link is broken, even though the raw counts alone would look plausible');
  -- customer_package_ledger is append-only (hard delete/update are trigger-
  -- blocked, by design); this whole script runs inside one transaction and
  -- ends in `rollback`, so no manual cleanup of this induced row is needed
  -- or possible.
end $$;

-- S27: a legacy package with no source_invoice_id (sold before invoice
-- linkage existed, or migrated from elsewhere) is flagged for manual review,
-- never silently treated as healthy or auto-repaired.
insert into public.customer_packages (id, organization_id, customer_id, package_id, sessions_remaining, status, purchased_at, activated_at)
values ('02000000-0000-4000-8000-00000000cc99', '02000000-0000-4000-8000-000000000001', '02000000-0000-4000-8000-00000000c101', '02000000-0000-4000-8000-00000000ca01', 0, 'active', now(), now());
do $$ declare v_report jsonb; begin
  v_report := app.reconcile_customer_package('02000000-0000-4000-8000-00000000cc99');
  perform pg_temp.ok(v_report->'manual_review_issues' @> '"missing_source_invoice"', 'S27 a legacy package with no source_invoice_id is flagged missing_source_invoice, never silently treated as healthy');
end $$;

-- --- section 25: guarded archive -- refused while a session is reserved ---
do $$ begin
  perform app.reserve_package_session('02000000-0000-4000-8000-000000001a02', pg_temp.id_of('shared_cp'));
  insert into smoke_ids (key, val) select 'guard_reservation', id from public.package_reservations
    where customer_package_id = pg_temp.id_of('shared_cp') and status = 'reserved';
end $$;
do $$ begin
  perform app.set_customer_package_status(pg_temp.id_of('shared_cp'), 'canceled', 'test archive');
  perform pg_temp.ok(false, 'S28 archiving a package with an active reservation should be rejected');
exception when check_violation then
  perform pg_temp.ok(sqlerrm like '%package_has_active_reservations%', 'S28 archive refuses a package with a reserved session outstanding');
end $$;
update public.package_reservations set status = 'released', released_at = now() where id = pg_temp.id_of('guard_reservation');
do $$ declare v_row public.customer_packages; begin
  v_row := app.set_customer_package_status(pg_temp.id_of('shared_cp'), 'canceled', 'test archive after release');
  perform pg_temp.ok(v_row.status = 'canceled', 'S29 archive succeeds once no reservation remains outstanding');
end $$;

-- --- cross-organization denial: org B's owner cannot reconcile/repair org A's package ---
do $$ begin perform pg_temp.act_as('02000000-0000-4000-8000-0000000000c2', '02000000-0000-4000-8000-000000000002'); end $$;
do $$ begin
  perform app.reconcile_customer_package(pg_temp.id_of('shared_cp'));
  perform pg_temp.ok(false, 'S30 cross-org reconcile should not find another organization''s package');
exception when no_data_found then
  perform pg_temp.ok(sqlerrm like '%package_not_found%', 'S30 cross-org reconcile correctly denies access (package_not_found)');
end $$;
do $$ begin
  perform app.repair_customer_package_balance(pg_temp.id_of('shared_cp'), 1, 'ff060000-0000-4000-8000-000000000006');
  perform pg_temp.ok(false, 'S31 cross-org repair should not find another organization''s package');
exception when no_data_found then
  perform pg_temp.ok(sqlerrm like '%package_not_found%', 'S31 cross-org repair correctly denies access (package_not_found)');
end $$;
do $$ begin
  perform app.renew_customer_package(pg_temp.id_of('shared_cp'), '02000000-0000-4000-8000-0000000000a2', now(), null, null, 'ff070000-0000-4000-8000-000000000007');
  perform pg_temp.ok(false, 'S32 cross-org renewal should not find another organization''s package');
exception when no_data_found then
  perform pg_temp.ok(sqlerrm like '%package_not_found%', 'S32 cross-org renewal correctly denies access (package_not_found) even though the caller supplied ITS OWN valid branch');
end $$;

-- --- authenticated-role, two-organization RLS proof (not just the RPC's own check) ---
set role authenticated;
do $$ begin perform pg_temp.act_as('02000000-0000-4000-8000-0000000000c2', '02000000-0000-4000-8000-000000000002'); end $$;
do $$ declare v_count int; begin
  select count(*) into v_count from public.customer_packages where id = pg_temp.id_of('shared_cp');
  perform pg_temp.ok(v_count = 0, 'S33 as authenticated role in org B, org A''s customer_packages row is invisible under RLS');
end $$;
do $$ begin perform pg_temp.act_as('02000000-0000-4000-8000-0000000000c1', '02000000-0000-4000-8000-000000000001'); end $$;
do $$ declare v_count int; begin
  select count(*) into v_count from public.customer_packages where id = pg_temp.id_of('shared_cp');
  perform pg_temp.ok(v_count = 1, 'S34 as authenticated role in org A (its own org), the package IS visible under RLS');
end $$;
reset role;

-- --- security item A: a same-organization READ-ONLY member (membership.read
-- only) calling RPCs directly, bypassing the UI entirely. Authorization is
-- re-checked on EVERY call, including a retry of an ALREADY-USED request_key
-- -- a caller without membership.manage must never receive the cached
-- result of someone else's earlier successful call. ---
do $$ begin perform pg_temp.act_as('02000000-0000-4000-8000-0000000000c3', '02000000-0000-4000-8000-000000000001'); end $$;
do $$ begin
  -- 'ff050000-...-000000000005' already succeeded once under the owner (S12).
  -- A read-only caller retrying that SAME key must be denied, not handed the
  -- existing invoice back.
  perform app.renew_customer_package(pg_temp.id_of('shared_cp'), '02000000-0000-4000-8000-0000000000a1', now(), null, null, 'ff050000-0000-4000-8000-000000000005');
  perform pg_temp.ok(false, 'S35 a read-only member retrying an already-used renewal request_key should be denied, not handed the cached invoice');
exception when insufficient_privilege then
  perform pg_temp.ok(sqlerrm like '%missing_permission:membership.manage%' or sqlerrm like '%not_authorized%', 'S35 read-only member is denied membership.manage even on an already-used request_key (authorization re-checked every call)');
end $$;
do $$ begin
  perform app.repair_customer_package_balance(pg_temp.id_of('shared_cp'), 1, 'ff080000-0000-4000-8000-000000000008');
  perform pg_temp.ok(false, 'S36 a read-only member should not be able to repair a balance');
exception when insufficient_privilege then
  perform pg_temp.ok(sqlerrm like '%missing_permission:membership.manage%' or sqlerrm like '%not_authorized%', 'S36 read-only member is denied repair (membership.manage required)');
end $$;
do $$ begin
  perform app.set_customer_package_status(pg_temp.id_of('shared_cp'), 'canceled', 'read-only should not be able to do this');
  perform pg_temp.ok(false, 'S37 a read-only member should not be able to archive a package');
exception when insufficient_privilege then
  perform pg_temp.ok(sqlerrm like '%missing_permission:membership.manage%' or sqlerrm like '%not_authorized%', 'S37 read-only member is denied archive (membership.manage required)');
end $$;
do $$ declare v_report jsonb; begin
  -- membership.read IS sufficient for the read-only preview.
  v_report := app.reconcile_customer_package(pg_temp.id_of('shared_cp'));
  perform pg_temp.ok(v_report ? 'balance_matches', 'S38 a read-only member CAN preview reconciliation (membership.read is sufficient for the read-only path)');
end $$;
do $$ begin perform pg_temp.act_as('02000000-0000-4000-8000-0000000000c1', '02000000-0000-4000-8000-000000000001'); end $$;

rollback;
-- END package_lifecycle_smoke
