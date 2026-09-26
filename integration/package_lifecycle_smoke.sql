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
  ('02000000-0000-4000-8000-0000000000a2', '02000000-0000-4000-8000-000000000002', 'Main B', true, 'active'),
  ('02000000-0000-4000-8000-0000000000a3', '02000000-0000-4000-8000-000000000001', 'Second Branch A', false, 'active');
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
  ('02000000-0000-4000-8000-000000000002', '02000000-0000-4000-8000-0000000000d2', '02000000-0000-4000-8000-0000000000a2'),
  ('02000000-0000-4000-8000-000000000001', '02000000-0000-4000-8000-0000000000d1', '02000000-0000-4000-8000-0000000000a3');
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
insert into public.packages (id, organization_id, name, service_id, total_sessions, price, currency, recurrence_interval, per_pet, rollover_policy) values
  ('02000000-0000-4000-8000-00000000ca01', '02000000-0000-4000-8000-000000000001', '3x Grooming Monthly', '02000000-0000-4000-8000-00000000ea01', 3, 300000, 'IDR', 'month', false, 'rollover'),
  ('02000000-0000-4000-8000-00000000ca02', '02000000-0000-4000-8000-000000000001', '1x Grooming Per-Pet', '02000000-0000-4000-8000-00000000ea01', 1, 150000, 'IDR', 'none', true, 'rollover'),
  ('02000000-0000-4000-8000-00000000ca03', '02000000-0000-4000-8000-000000000001', '5x Grooming No-Rollover', '02000000-0000-4000-8000-00000000ea01', 5, 500000, 'IDR', 'month', false, 'none');
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
do $$ declare v_invoice public.invoices; v_cp public.customer_packages; v_ledger record; v_renewal_count int; v_fp text; begin
  v_fp := app.preview_package_renewal(pg_temp.id_of('shared_cp'))->>'terms_fingerprint';
  v_invoice := app.renew_customer_package(pg_temp.id_of('shared_cp'), '02000000-0000-4000-8000-0000000000a1', now(), null, null, 'ff050000-0000-4000-8000-000000000005', v_fp);
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
  -- second order/invoice/ledger row, renewal_count unchanged. A deliberately
  -- WRONG/garbage terms_fingerprint is passed here to PROVE a genuine retry
  -- never re-checks it (review round 3, finding #2: "a genuine retry of a
  -- completed operation must still return its original result").
  v_invoice := app.renew_customer_package(pg_temp.id_of('shared_cp'), '02000000-0000-4000-8000-0000000000a1', now(), null, null, 'ff050000-0000-4000-8000-000000000005', 'stale-or-garbage-fingerprint-must-be-ignored-on-retry');
  perform pg_temp.ok(v_invoice.id = pg_temp.id_of('renewal_invoice'), 'S20 repeating the same renewal request_key returns the SAME invoice (idempotent), even with a garbage terms_fingerprint -- a retry never re-checks it');
  select renewal_count into v_renewal_count from public.customer_packages where id = pg_temp.id_of('shared_cp');
  perform pg_temp.ok(v_renewal_count = 1, 'S21 the idempotent retry did not double-apply (renewal_count still 1)');
end $$;

-- --- a request_key reused for a DIFFERENT membership is rejected, not silently returned ---
do $$ begin
  perform app.renew_customer_package(pg_temp.id_of('per_pet_cp'), '02000000-0000-4000-8000-0000000000a1', now(), null, null, 'ff050000-0000-4000-8000-000000000005', 'irrelevant-never-reached');
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
  perform app.renew_customer_package(pg_temp.id_of('shared_cp'), '02000000-0000-4000-8000-0000000000a2', now(), null, null, 'ff070000-0000-4000-8000-000000000007', 'irrelevant-never-reached');
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
  perform app.renew_customer_package(pg_temp.id_of('shared_cp'), '02000000-0000-4000-8000-0000000000a1', now(), null, null, 'ff050000-0000-4000-8000-000000000005', 'irrelevant-never-reached');
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

-- =====================================================================
-- Codex review of 86ad714, findings 1-4: regression tests.
-- =====================================================================

-- --- finding #2: rollover_policy actually governs renewal. ca03 is a
-- rollover_policy='none' package: renewing must protect the HELD (reserved)
-- session and discard only the unreserved excess. ---
do $$ begin
  perform app.create_package_invoice(
    '02000000-0000-4000-8000-0000000000a1', '02000000-0000-4000-8000-00000000c101', '02000000-0000-4000-8000-00000000ca03',
    now(), null, null, 'ff090000-0000-4000-8000-000000000009');
  insert into smoke_ids (key, val) select 'norollover_cp', id from public.customer_packages
    where organization_id = '02000000-0000-4000-8000-000000000001' and package_id = '02000000-0000-4000-8000-00000000ca03';
end $$;
insert into public.grooming_job_pet_services (id, organization_id, grooming_job_pet_id, service_id, service_name_snapshot, unit_price_snapshot, currency, quantity, duration_minutes) values
  ('02000000-0000-4000-8000-000000001a03', '02000000-0000-4000-8000-000000000001', '02000000-0000-4000-8000-00000000da01', '02000000-0000-4000-8000-00000000ea01', 'Grooming', 100000, 'IDR', 1, 60);
do $$ begin
  perform app.reserve_package_session('02000000-0000-4000-8000-000000001a03', pg_temp.id_of('norollover_cp'));
end $$;
do $$ declare v_cp public.customer_packages; v_fp text; begin
  v_fp := app.preview_package_renewal(pg_temp.id_of('norollover_cp'))->>'terms_fingerprint';
  perform app.renew_customer_package(pg_temp.id_of('norollover_cp'), '02000000-0000-4000-8000-0000000000a1', now(), null, null, 'ff0a0000-0000-4000-8000-00000000000a', v_fp);
  select * into v_cp from public.customer_packages where id = pg_temp.id_of('norollover_cp');
  perform pg_temp.ok(v_cp.sessions_remaining = 6, 'S39 rollover_policy=none: remaining ends at reserved(1) + total_sessions(5) = 6 (5 sold, -4 unreserved excess discarded, +5 renewal)');
end $$;
do $$ declare v_count int; begin
  select count(*) into v_count from public.package_reservations where customer_package_id = pg_temp.id_of('norollover_cp') and status = 'reserved';
  perform pg_temp.ok(v_count = 1, 'S40 rollover_policy=none: the HELD (reserved) session survives the renewal untouched -- available afterward is exactly total_sessions (6 remaining - 1 reserved = 5)');
end $$;
do $$ declare v_delta int; begin
  select delta into v_delta from public.customer_package_ledger where customer_package_id = pg_temp.id_of('norollover_cp') and reason = 'adjustment';
  perform pg_temp.ok(v_delta = -4, 'S41 rollover_policy=none: the compensating adjustment discards exactly the unreserved excess (4 = 5 sold - 1 held), never the held session, and is a real ledger row, not a raw cache overwrite');
end $$;

-- --- finding #1: a legitimate retry after a catalog price change must
-- still return the original invoice, not be rejected -- but a retry with a
-- DIFFERENT caller-supplied issued_at/due_at/admin_notes must be. ---
do $$ declare v_invoice public.invoices; v_fp text; begin
  v_fp := app.preview_package_renewal(pg_temp.id_of('per_pet_cp'))->>'terms_fingerprint';
  v_invoice := app.renew_customer_package(pg_temp.id_of('per_pet_cp'), '02000000-0000-4000-8000-0000000000a1', '2026-09-26 09:00:00+07', null, 'original note', 'ff0b0000-0000-4000-8000-00000000000b', v_fp);
  insert into smoke_ids (key, val) select 'price_retry_invoice', v_invoice.id;
  perform pg_temp.ok(v_invoice.total = 150000, 'S42 renewal invoice captures the catalog price observed at the time of the ORIGINAL call (150000)');
end $$;
update public.packages set price = 999999 where id = '02000000-0000-4000-8000-00000000ca02';
do $$ declare v_invoice public.invoices; begin
  -- IDENTICAL inputs (same issued_at/due_at/notes), garbage fingerprint (a
  -- retry never re-checks it) -> returns the ORIGINAL invoice unchanged.
  v_invoice := app.renew_customer_package(pg_temp.id_of('per_pet_cp'), '02000000-0000-4000-8000-0000000000a1', '2026-09-26 09:00:00+07', null, 'original note', 'ff0b0000-0000-4000-8000-00000000000b', 'stale-or-garbage-fingerprint-must-be-ignored-on-retry');
  perform pg_temp.ok(v_invoice.id = pg_temp.id_of('price_retry_invoice'), 'S43 a legitimate retry of the SAME request_key with IDENTICAL inputs after a catalog price change still returns the ORIGINAL invoice (review finding #1/#3 -- this used to be rejected as request_key_reused_for_different_renewal, which was the actual bug)');
  perform pg_temp.ok(v_invoice.total = 150000, 'S44 the returned invoice keeps its originally captured total (150000), unaffected by the later catalog price edit to 999999');
end $$;

-- --- finding #1: a request_key reused with a DIFFERENT caller-supplied
-- issued_at, or a DIFFERENT admin_notes, is rejected -- not silently
-- accepted with the changed value (the previous review round only fixed
-- the branch/membership comparison, not these). ---
do $$ begin
  perform app.renew_customer_package(pg_temp.id_of('per_pet_cp'), '02000000-0000-4000-8000-0000000000a1', '2026-09-27 09:00:00+07', null, 'original note', 'ff0b0000-0000-4000-8000-00000000000b', 'irrelevant-never-reached');
  perform pg_temp.ok(false, 'S44b reusing a renewal request_key with a DIFFERENT issued_at should be rejected');
exception when sqlstate '22023' then
  perform pg_temp.ok(sqlerrm like '%request_key_reused_for_different_renewal%', 'S44b renewal request_key reused with a different issued_at is rejected');
end $$;
do $$ begin
  perform app.renew_customer_package(pg_temp.id_of('per_pet_cp'), '02000000-0000-4000-8000-0000000000a1', '2026-09-26 09:00:00+07', null, 'a DIFFERENT note', 'ff0b0000-0000-4000-8000-00000000000b', 'irrelevant-never-reached');
  perform pg_temp.ok(false, 'S44c reusing a renewal request_key with DIFFERENT admin_notes should be rejected');
exception when sqlstate '22023' then
  perform pg_temp.ok(sqlerrm like '%request_key_reused_for_different_renewal%', 'S44c renewal request_key reused with different admin_notes is rejected');
end $$;

-- --- finding #3: a request_key reused at a genuinely DIFFERENT branch (not
-- just a different membership, already covered by S22) is still rejected. ---
do $$ begin
  perform app.renew_customer_package(pg_temp.id_of('per_pet_cp'), '02000000-0000-4000-8000-0000000000a3', '2026-09-26 09:00:00+07', null, 'original note', 'ff0b0000-0000-4000-8000-00000000000b', 'irrelevant-never-reached');
  perform pg_temp.ok(false, 'S45 reusing a renewal request_key at a DIFFERENT branch should be rejected');
exception when sqlstate '22023' then
  perform pg_temp.ok(sqlerrm like '%request_key_reused_for_different_renewal%', 'S45 renewal request_key reused at a different branch is rejected, not silently accepted');
end $$;

-- --- finding #2: preview_package_renewal is read-only, exposes the fields
-- the brief asked for, and returns a terms_fingerprint that binds the
-- write to what was actually previewed. ---
do $$ declare v_before public.customer_packages; v_after public.customer_packages; v_preview jsonb; begin
  select * into v_before from public.customer_packages where id = pg_temp.id_of('per_pet_cp');
  v_preview := app.preview_package_renewal(pg_temp.id_of('per_pet_cp'));
  select * into v_after from public.customer_packages where id = pg_temp.id_of('per_pet_cp');
  perform pg_temp.ok(v_before.revision = v_after.revision and v_before.sessions_remaining = v_after.sessions_remaining, 'S46 preview_package_renewal writes nothing (revision/sessions_remaining unchanged)');
  perform pg_temp.ok(v_preview ? 'price' and v_preview ? 'currency' and v_preview ? 'sessions_to_add' and v_preview ? 'resulting_expires_at' and v_preview ? 'pet_id' and v_preview ? 'service_id' and v_preview ? 'terms_fingerprint', 'S47 preview exposes price/currency/sessions/expiry/pet/service scope and a terms_fingerprint');
  perform pg_temp.ok(not (v_preview->>'incompatible')::boolean, 'S48 preview reports compatible while the catalog per_pet flag still matches the membership''s actual pet scope');
end $$;

-- --- finding #2: a renewal WITHOUT a fingerprint, and one with a STALE
-- fingerprint (the catalog changed after the preview was generated), are
-- both refused -- the write is bound to what was actually previewed under
-- the row lock, not to whatever the client claims. A fresh preview after
-- the change succeeds. Uses a SECOND, separate purchase of the same
-- catalog package (also doubles as the "two purchases of the same product"
-- fixture for finding #4 below). ---
do $$ declare v_invoice public.invoices; begin
  v_invoice := app.create_package_invoice(
    '02000000-0000-4000-8000-0000000000a1', '02000000-0000-4000-8000-00000000c101', '02000000-0000-4000-8000-00000000ca01',
    now(), null, null, 'ff0d0000-0000-4000-8000-00000000000d');
  insert into smoke_ids (key, val) select 'fingerprint_cp', id from public.customer_packages
    where organization_id = '02000000-0000-4000-8000-000000000001' and source_invoice_id = v_invoice.id;
end $$;
do $$ begin
  perform app.renew_customer_package(pg_temp.id_of('fingerprint_cp'), '02000000-0000-4000-8000-0000000000a1', now(), null, null, 'ff0e0000-0000-4000-8000-00000000000e', null);
  perform pg_temp.ok(false, 'S48b a renewal with no terms_fingerprint at all should be refused');
exception when sqlstate '22023' then
  perform pg_temp.ok(sqlerrm like '%renewal_preview_required%', 'S48b a new renewal without a terms_fingerprint is refused (renewal_preview_required)');
end $$;
do $$ declare v_stale_fp text; begin
  v_stale_fp := app.preview_package_renewal(pg_temp.id_of('fingerprint_cp'))->>'terms_fingerprint';
  update public.packages set price = 777777 where id = '02000000-0000-4000-8000-00000000ca01';
  begin
    perform app.renew_customer_package(pg_temp.id_of('fingerprint_cp'), '02000000-0000-4000-8000-0000000000a1', now(), null, null, 'ff0e0000-0000-4000-8000-00000000000e', v_stale_fp);
    perform pg_temp.ok(false, 'S48c a NEW renewal with a STALE fingerprint (catalog changed since preview) should be refused');
  exception when sqlstate '40001' then
    perform pg_temp.ok(sqlerrm like '%renewal_terms_changed_since_preview%', 'S48c a stale terms_fingerprint (catalog price changed since the preview was generated) is refused, not silently accepted');
  end;
end $$;
do $$ declare v_fresh_fp text; v_invoice public.invoices; begin
  v_fresh_fp := app.preview_package_renewal(pg_temp.id_of('fingerprint_cp'))->>'terms_fingerprint';
  v_invoice := app.renew_customer_package(pg_temp.id_of('fingerprint_cp'), '02000000-0000-4000-8000-0000000000a1', now(), null, null, 'ff0e0000-0000-4000-8000-00000000000e', v_fresh_fp);
  perform pg_temp.ok(v_invoice.total = 777777, 'S48d after reloading the preview (fresh fingerprint), the SAME request succeeds and charges the NEW catalog price (deliberate re-confirmation, not a silent block forever)');
  insert into smoke_ids (key, val) select 'fingerprint_cp_invoice', v_invoice.id;
end $$;
update public.packages set price = 300000 where id = '02000000-0000-4000-8000-00000000ca01';

-- --- finding #3: per_pet compatibility, corrected. A sale may optionally
-- bind a pet even when per_pet=false (per_pet_cp keeps its pet bound
-- throughout) -- pet presence alone must never itself be treated as a
-- catalog-drift proof. The ONLY unsafe drift is the catalog NOW requiring a
-- pet for a membership that was sold with none at all. ---
update public.packages set per_pet = false where id = '02000000-0000-4000-8000-00000000ca02';
do $$ declare v_preview jsonb; begin
  v_preview := app.preview_package_renewal(pg_temp.id_of('per_pet_cp'));
  perform pg_temp.ok(not (v_preview->>'pet_scope_incompatible')::boolean, 'S49 catalog per_pet drifting from true to false while the membership keeps its OPTIONALLY-bound pet is COMPATIBLE (the review round 3 bug fix -- pet presence alone is not proof the catalog changed)');
end $$;
update public.packages set per_pet = true where id = '02000000-0000-4000-8000-00000000ca02';

-- shared_cp (package ca01, per_pet=false, no pet ever bound) is the genuine
-- incompatibility case: the catalog NOW requiring a pet for a membership
-- sold with none. Reactivate it first (archived at S29).
do $$ begin perform app.set_customer_package_status(pg_temp.id_of('shared_cp'), 'active', 'reactivated for review round 3 finding #3 fixture'); end $$;
update public.packages set per_pet = true where id = '02000000-0000-4000-8000-00000000ca01';
do $$ declare v_preview jsonb; begin
  v_preview := app.preview_package_renewal(pg_temp.id_of('shared_cp'));
  perform pg_temp.ok((v_preview->>'pet_scope_incompatible')::boolean, 'S50 catalog per_pet drifting from false to true for a membership that was sold with NO pet bound at all is genuinely incompatible');
  perform pg_temp.ok(v_preview->>'blocking_reason' = 'catalog_terms_changed_incompatible_with_existing_entitlement', 'S50b preview reports the specific blocking reason before any write is attempted');
end $$;
do $$ begin
  perform app.renew_customer_package(pg_temp.id_of('shared_cp'), '02000000-0000-4000-8000-0000000000a1', now(), null, null, 'ff0c0000-0000-4000-8000-00000000000c', app.preview_package_renewal(pg_temp.id_of('shared_cp'))->>'terms_fingerprint');
  perform pg_temp.ok(false, 'S51 renewal should be refused when catalog per_pet terms drifted incompatibly with an existing entitlement');
exception when check_violation then
  perform pg_temp.ok(sqlerrm like '%catalog_terms_changed_incompatible_with_existing_entitlement%', 'S51 renewal correctly refuses to charge for a now-incompatible catalog product rather than silently topping it up');
end $$;
update public.packages set per_pet = false where id = '02000000-0000-4000-8000-00000000ca01';

-- --- finding #3: service compatibility (cp.service_id is the immutable
-- purchase-time snapshot; NULL on either side is never itself a mismatch).
-- per_pet_cp already carries a HELD reservation throughout this file (from
-- S2), so these checks are exercised WITH a held reservation present. ---
insert into public.service_catalog (id, organization_id, name, base_price, currency, duration_minutes, is_active) values
  ('02000000-0000-4000-8000-00000000ea02', '02000000-0000-4000-8000-000000000001', 'Spa', 150000, 'IDR', 45, true);
update public.packages set service_id = '02000000-0000-4000-8000-00000000ea02' where id = '02000000-0000-4000-8000-00000000ca02';
do $$ declare v_preview jsonb; begin
  v_preview := app.preview_package_renewal(pg_temp.id_of('per_pet_cp'));
  perform pg_temp.ok((v_preview->>'service_scope_incompatible')::boolean, 'S52 catalog service_id changing from the purchased service (Grooming) to a DIFFERENT specific service (Spa) is incompatible (a real held reservation is present throughout this check)');
end $$;
do $$ begin
  perform app.renew_customer_package(pg_temp.id_of('per_pet_cp'), '02000000-0000-4000-8000-0000000000a1', now(), null, null, 'ff0f0000-0000-4000-8000-00000000000f', app.preview_package_renewal(pg_temp.id_of('per_pet_cp'))->>'terms_fingerprint');
  perform pg_temp.ok(false, 'S53 renewal should be refused when the catalog service scope drifted to a different specific service');
exception when check_violation then
  perform pg_temp.ok(sqlerrm like '%catalog_terms_changed_incompatible_with_existing_entitlement%', 'S53 renewal correctly refuses a service A->B drift, not silently charging for Spa while topping up a Grooming entitlement');
end $$;
update public.packages set service_id = null where id = '02000000-0000-4000-8000-00000000ca02';
do $$ declare v_preview jsonb; begin
  v_preview := app.preview_package_renewal(pg_temp.id_of('per_pet_cp'));
  perform pg_temp.ok(not (v_preview->>'service_scope_incompatible')::boolean, 'S54 catalog service_id broadening from a specific service to NULL ("any service") is compatible -- the purchased entitlement keeps its own specific scope regardless');
end $$;
update public.packages set service_id = '02000000-0000-4000-8000-00000000ea01' where id = '02000000-0000-4000-8000-00000000ca02';

-- norollover_cp's package (ca03) was created with service_id=null, so
-- norollover_cp.service_id is null (an "any service" purchase). Catalog
-- narrowing from null to a specific service is likewise compatible, and
-- (finding #3's "legitimate unchanged renewal" case, exercised as a REAL
-- second renewal, not merely a preview) the renewal actually succeeds.
update public.packages set service_id = '02000000-0000-4000-8000-00000000ea01' where id = '02000000-0000-4000-8000-00000000ca03';
do $$ declare v_preview jsonb; begin
  v_preview := app.preview_package_renewal(pg_temp.id_of('norollover_cp'));
  perform pg_temp.ok(not (v_preview->>'service_scope_incompatible')::boolean, 'S55 catalog service_id narrowing from NULL to a specific service, for a membership purchased under "any service", is compatible');
end $$;
do $$ declare v_invoice public.invoices; begin
  v_invoice := app.renew_customer_package(pg_temp.id_of('norollover_cp'), '02000000-0000-4000-8000-0000000000a1', now(), null, null, 'ff100000-0000-4000-8000-000000000010', app.preview_package_renewal(pg_temp.id_of('norollover_cp'))->>'terms_fingerprint');
  perform pg_temp.ok(v_invoice.status = 'issued', 'S56 a legitimate renewal under a compatible (broadened-then-narrowed) service scope succeeds as a real RPC call, not merely a passing preview');
end $$;
update public.packages set service_id = null where id = '02000000-0000-4000-8000-00000000ca03';

-- --- finding #4: deep invoice-link validation, missing reversal links, and
-- duplicate consumption links. shared_cp was archived (canceled) at S29;
-- reactivate it first (a realistic staff action) so it can be used again. ---
do $$ begin perform app.set_customer_package_status(pg_temp.id_of('shared_cp'), 'active', 'reactivated for review finding #4 regression fixtures'); end $$;

-- A non-null invoice_id must point to a MATCHING invoice (same customer AND
-- package), not merely any invoice that happens to exist in the org.
-- price_retry_invoice (from S42) genuinely belongs to customer c101 but
-- package ca02 -- a real, same-organization, wrong-PACKAGE invoice, exactly
-- the fixture the review asked for.
insert into public.customer_package_ledger (organization_id, customer_package_id, delta, reason, notes, invoice_id)
values ('02000000-0000-4000-8000-000000000001', pg_temp.id_of('shared_cp'), 1, 'renewal', 'fixture: wrong-package invoice attached (review finding #4)', pg_temp.id_of('price_retry_invoice'));
do $$ declare v_report jsonb; begin
  v_report := app.reconcile_customer_package(pg_temp.id_of('shared_cp'));
  perform pg_temp.ok(v_report->'manual_review_issues' @> '"invalid_invoice_links"', 'S57 a renewal ledger row linked to an invoice belonging to a DIFFERENT package is flagged invalid_invoice_links -- a non-null invoice_id alone is not treated as proof of correct provenance');
end $$;

insert into public.grooming_job_pet_services (id, organization_id, grooming_job_pet_id, service_id, service_name_snapshot, unit_price_snapshot, currency, quantity, duration_minutes) values
  ('02000000-0000-4000-8000-000000001a04', '02000000-0000-4000-8000-000000000001', '02000000-0000-4000-8000-00000000da02', '02000000-0000-4000-8000-00000000ea01', 'Grooming', 100000, 'IDR', 1, 60),
  ('02000000-0000-4000-8000-000000001a05', '02000000-0000-4000-8000-000000000001', '02000000-0000-4000-8000-00000000da01', '02000000-0000-4000-8000-00000000ea01', 'Grooming', 100000, 'IDR', 1, 60);
do $$ declare v_r1 uuid; v_r2 uuid; begin
  v_r1 := app.reserve_package_session('02000000-0000-4000-8000-000000001a04', pg_temp.id_of('shared_cp'));
  v_r2 := app.reserve_package_session('02000000-0000-4000-8000-000000001a05', pg_temp.id_of('shared_cp'));
  insert into smoke_ids (key, val) values ('missing_reversal_r', v_r1), ('duplicate_r2', v_r2);
  perform app.consume_package_reservation(v_r1);
  perform app.consume_package_reservation(v_r2);
end $$;

-- missing_reversal_link: released after consumption WITHOUT ever going
-- through reverse_package_reservation (which always sets reversal_ledger_id).
update public.package_reservations set status = 'released', released_at = now()
 where id = pg_temp.id_of('missing_reversal_r');
do $$ declare v_report jsonb; begin
  v_report := app.reconcile_customer_package(pg_temp.id_of('shared_cp'));
  perform pg_temp.ok(v_report->'manual_review_issues' @> '"missing_reversal_link"', 'S58 a reservation released after consumption with no reversal_ledger_id is flagged missing_reversal_link');
end $$;

-- duplicate_consumption_links: point a SECOND reservation's
-- consumption_ledger_id at the FIRST reservation's ledger row too (no DB
-- uniqueness constraint prevents this on package_reservations directly).
do $$ declare v_ledger_id uuid; begin
  select consumption_ledger_id into v_ledger_id from public.package_reservations where id = pg_temp.id_of('missing_reversal_r');
  update public.package_reservations set consumption_ledger_id = v_ledger_id where id = pg_temp.id_of('duplicate_r2');
end $$;
do $$ declare v_report jsonb; begin
  v_report := app.reconcile_customer_package(pg_temp.id_of('shared_cp'));
  perform pg_temp.ok(v_report->'manual_review_issues' @> '"duplicate_consumption_links"', 'S59 two reservations sharing the same consumption_ledger_id are flagged duplicate_consumption_links, not assumed impossible');
end $$;

-- --- finding #4: the HISTORICAL source_invoice_id is now validated the
-- same way as ledger-level links (previously only checked for NULL).
-- fingerprint_cp (purchased earlier at 'ff0d0000-...-d') is a SECOND,
-- separate purchase of the SAME catalog package (ca01) by the SAME
-- customer as shared_cp -- exactly the "same customer, same product,
-- different membership" scenario the review asked to be provably
-- distinguished, not merely accepted on a customer-and-product match. A
-- second customer (Cust A2) is added for a genuine wrong-CUSTOMER fixture. ---
do $$ declare v_report jsonb; begin
  v_report := app.reconcile_customer_package(pg_temp.id_of('fingerprint_cp'));
  perform pg_temp.ok(not (v_report->>'missing_source_invoice')::boolean, 'S60 a healthy purchase with a real, correctly-linked source invoice is not missing_source_invoice');
  perform pg_temp.ok(not (v_report->'manual_review_issues' @> '"invalid_source_invoice"'), 'S61 a healthy purchase''s source invoice validates correctly (right customer, right package, matching session snapshot)');
end $$;

insert into public.customers (id, organization_id, display_name) values ('02000000-0000-4000-8000-00000000c102', '02000000-0000-4000-8000-000000000001', 'Cust A2');
insert into public.pets (id, organization_id, customer_id, name) values ('02000000-0000-4000-8000-00000000f201', '02000000-0000-4000-8000-000000000001', '02000000-0000-4000-8000-00000000c102', 'Pet A2-1');
do $$ declare v_invoice public.invoices; begin
  v_invoice := app.create_package_invoice('02000000-0000-4000-8000-0000000000a1', '02000000-0000-4000-8000-00000000c102', '02000000-0000-4000-8000-00000000ca01', now(), null, null, 'ff120000-0000-4000-8000-000000000012');
  insert into smoke_ids (key, val) values ('wrong_customer_invoice', v_invoice.id);
end $$;
update public.customer_packages set source_invoice_id = pg_temp.id_of('wrong_customer_invoice') where id = pg_temp.id_of('fingerprint_cp');
do $$ declare v_report jsonb; begin
  v_report := app.reconcile_customer_package(pg_temp.id_of('fingerprint_cp'));
  perform pg_temp.ok(v_report->'manual_review_issues' @> '"invalid_source_invoice"', 'S62 a historical source_invoice_id pointing at a REAL invoice for the right package but a DIFFERENT customer (Cust A2, not fingerprint_cp''s actual owner Cust A1) is flagged invalid_source_invoice');
end $$;

-- wrong-package source: price_retry_invoice genuinely belongs to customer
-- c101 (the right customer) but package ca02 (the wrong package).
update public.customer_packages set source_invoice_id = pg_temp.id_of('price_retry_invoice') where id = pg_temp.id_of('fingerprint_cp');
do $$ declare v_report jsonb; begin
  v_report := app.reconcile_customer_package(pg_temp.id_of('fingerprint_cp'));
  perform pg_temp.ok(v_report->'manual_review_issues' @> '"invalid_source_invoice"', 'S63 a historical source_invoice_id pointing at an invoice for the right customer but a DIFFERENT package is flagged invalid_source_invoice');
end $$;

-- void source: a fresh, real invoice for the RIGHT customer/package, then marked void.
do $$ declare v_invoice public.invoices; begin
  v_invoice := app.create_package_invoice('02000000-0000-4000-8000-0000000000a1', '02000000-0000-4000-8000-00000000c101', '02000000-0000-4000-8000-00000000ca01', now(), null, null, 'ff110000-0000-4000-8000-000000000011');
  insert into smoke_ids (key, val) values ('void_invoice', v_invoice.id);
end $$;
update public.invoices set status = 'void' where id = pg_temp.id_of('void_invoice');
update public.customer_packages set source_invoice_id = pg_temp.id_of('void_invoice') where id = pg_temp.id_of('fingerprint_cp');
do $$ declare v_report jsonb; begin
  v_report := app.reconcile_customer_package(pg_temp.id_of('fingerprint_cp'));
  perform pg_temp.ok(v_report->'manual_review_issues' @> '"invalid_source_invoice"', 'S64 a historical source_invoice_id pointing at a VOID invoice (right customer/package, wrong status) is flagged invalid_source_invoice');
end $$;

-- mismatched session snapshot: right customer/package/status, but the
-- invoice line's snapshotted session count does not match the ledger
-- movement it is supposed to have produced. invoice_lines is append-only
-- (same as customer_package_ledger -- no UPDATE allowed), so this is
-- constructed as a standalone raw insert (both the invoice and its one
-- line) rather than corrupting a real create_package_invoice result, which
-- would always be internally consistent by construction.
do $$ declare v_invoice_id uuid; v_order_id uuid; begin
  insert into public.orders (organization_id, branch_id, customer_id, status, currency)
  values ('02000000-0000-4000-8000-000000000001', '02000000-0000-4000-8000-0000000000a1', '02000000-0000-4000-8000-00000000c101', 'confirmed', 'IDR')
  returning id into v_order_id;
  insert into public.invoices (organization_id, branch_id, customer_id, order_id, invoice_number, status, currency, subtotal, discount_total, tax_total, total, issued_at, billing_mode, document_type)
  values ('02000000-0000-4000-8000-000000000001', '02000000-0000-4000-8000-0000000000a1', '02000000-0000-4000-8000-00000000c101', v_order_id, 'PKG-TEST-MISMATCH', 'issued', 'IDR', 300000, 0, 0, 300000, now(), 'package_sale', 'invoice')
  returning id into v_invoice_id;
  insert into public.invoice_lines (organization_id, invoice_id, item_type, package_id, name_snapshot, quantity, unit_price, line_total, pricing_breakdown)
  values ('02000000-0000-4000-8000-000000000001', v_invoice_id, 'package', '02000000-0000-4000-8000-00000000ca01', '3x Grooming Monthly', 1, 300000, 300000, jsonb_build_object('sessions', 999));
  insert into smoke_ids (key, val) values ('mismatched_invoice', v_invoice_id);
end $$;
update public.customer_packages set source_invoice_id = pg_temp.id_of('mismatched_invoice') where id = pg_temp.id_of('fingerprint_cp');
do $$ declare v_report jsonb; begin
  v_report := app.reconcile_customer_package(pg_temp.id_of('fingerprint_cp'));
  perform pg_temp.ok(v_report->'manual_review_issues' @> '"invalid_source_invoice"', 'S65 a historical source invoice with the RIGHT customer/package/status but a MISMATCHED session snapshot (corrupted to 999) is flagged invalid_source_invoice -- never today''s catalog sessions, the actual invoice line snapshot at the time');
end $$;

-- restore a healthy source_invoice_id so the next checks below start clean.
update public.customer_packages set source_invoice_id = (
  select invoice_id from public.customer_package_ledger where customer_package_id = pg_temp.id_of('fingerprint_cp') and reason = 'purchase'
) where id = pg_temp.id_of('fingerprint_cp');

-- same-membership invoice for a DIFFERENT renewal: fingerprint_cp already
-- has one real renewal (fingerprint_cp_invoice, from S48d). Give it a
-- second real renewal, then fabricate a ledger row claiming to be linked
-- to the SECOND renewal's invoice while carrying the FIRST renewal's
-- request_key (a request_key mismatch) -- renewal_of alone (same
-- membership) must not be accepted as sufficient; the SPECIFIC renewal
-- event must match too.
do $$ declare v_fp text; v_invoice public.invoices; begin
  v_fp := app.preview_package_renewal(pg_temp.id_of('fingerprint_cp'))->>'terms_fingerprint';
  v_invoice := app.renew_customer_package(pg_temp.id_of('fingerprint_cp'), '02000000-0000-4000-8000-0000000000a1', now(), null, null, 'ff150000-0000-4000-8000-000000000015', v_fp);
  insert into smoke_ids (key, val) values ('fingerprint_cp_renewal2_invoice', v_invoice.id);
end $$;
insert into public.customer_package_ledger (organization_id, customer_package_id, delta, reason, notes, invoice_id, request_key)
values ('02000000-0000-4000-8000-000000000001', pg_temp.id_of('fingerprint_cp'), 1, 'renewal', 'fixture: same-membership but WRONG renewal invoice (request_key mismatch)', pg_temp.id_of('fingerprint_cp_renewal2_invoice'), 'ff160000-0000-4000-8000-000000000016');
do $$ declare v_report jsonb; begin
  v_report := app.reconcile_customer_package(pg_temp.id_of('fingerprint_cp'));
  perform pg_temp.ok(v_report->'manual_review_issues' @> '"invalid_invoice_links"', 'S66 a renewal ledger row for the SAME membership but linked to a DIFFERENT renewal''s invoice (request_key mismatch) is flagged invalid_invoice_links -- renewal_of matching alone is not sufficient proof');
end $$;

-- legacy: a ledger 'renewal' row with invoice_id NULL (simulating a row
-- created before this migration, when renewal never produced an invoice at
-- all) is flagged unlinked_renewal_invoice, an explicit disclosed-unknown-
-- provenance state -- never silently treated as verified.
insert into public.customer_package_ledger (organization_id, customer_package_id, delta, reason, notes)
values ('02000000-0000-4000-8000-000000000001', pg_temp.id_of('fingerprint_cp'), 1, 'renewal', 'fixture: legacy pre-migration renewal row, no invoice ever existed');
do $$ declare v_report jsonb; begin
  v_report := app.reconcile_customer_package(pg_temp.id_of('fingerprint_cp'));
  perform pg_temp.ok(v_report->'manual_review_issues' @> '"unlinked_renewal_invoice"', 'S67 a legacy renewal ledger row with invoice_id NULL (predating this migration) is flagged unlinked_renewal_invoice, an explicit disclosed gap, never invented history');
end $$;

-- --- finding #5: guarded purchased-term editing. terms_edit_cp is a
-- fresh, never-reserved, never-renewed purchase (the ONLY state pet/service
-- may be corrected in). ---
do $$ declare v_invoice public.invoices; begin
  v_invoice := app.create_package_invoice(
    '02000000-0000-4000-8000-0000000000a1', '02000000-0000-4000-8000-00000000c101', '02000000-0000-4000-8000-00000000ca01',
    now(), null, null, 'ff170000-0000-4000-8000-000000000017');
  insert into smoke_ids (key, val) select 'terms_edit_cp', id from public.customer_packages
    where organization_id = '02000000-0000-4000-8000-000000000001' and source_invoice_id = v_invoice.id;
end $$;

-- S68: allowed correction -- expires_at, pet_id (to the customer's own
-- pet), and service_id, with a valid reason and the current revision.
-- Verifies sessions_remaining/invoices are untouched and an audited
-- before/after timeline_events row exists.
do $$ declare v_before public.customer_packages; v_row public.customer_packages; v_event record; v_invoice_total numeric; begin
  select * into v_before from public.customer_packages where id = pg_temp.id_of('terms_edit_cp');
  select total into v_invoice_total from public.invoices where id = v_before.source_invoice_id;
  v_row := app.update_customer_package_terms(pg_temp.id_of('terms_edit_cp'), v_before.revision, 'data entry correction: wrong pet selected at sale',
    (now() + interval '90 days'), '02000000-0000-4000-8000-00000000f102', '02000000-0000-4000-8000-00000000ea01');
  perform pg_temp.ok(v_row.pet_id = '02000000-0000-4000-8000-00000000f102', 'S68 allowed correction updates pet_id');
  perform pg_temp.ok(v_row.service_id = '02000000-0000-4000-8000-00000000ea01', 'S68b allowed correction updates service_id');
  perform pg_temp.ok(v_row.revision = v_before.revision + 1, 'S68c the revision is bumped so a concurrent stale request is now detectable');
  perform pg_temp.ok(v_row.sessions_remaining = v_before.sessions_remaining, 'S69 a terms correction never touches sessions_remaining (no balance edit)');
  select total into v_invoice_total from public.invoices where id = v_row.source_invoice_id;
  perform pg_temp.ok(v_invoice_total = 300000, 'S69b the source invoice''s total is untouched by a terms correction (no retroactive rewriting of invoice terms)');
  select * into v_event from public.timeline_events where subject_type = 'package' and subject_id = pg_temp.id_of('terms_edit_cp') and event_type = 'membership.terms_corrected';
  perform pg_temp.ok(v_event.data->>'reason' = 'data entry correction: wrong pet selected at sale', 'S70 the correction is audited in timeline_events with the reason');
  perform pg_temp.ok((v_event.data->'before'->>'pet_id') is distinct from (v_event.data->'after'->>'pet_id'), 'S70b the audit row records both the before and after pet_id');
end $$;

-- S71: a stale revision (the row has already moved on) is rejected, not
-- silently applied over a concurrent change.
do $$ begin
  perform app.update_customer_package_terms(pg_temp.id_of('terms_edit_cp'), 1, 'stale attempt', now(), null, null);
  perform pg_temp.ok(false, 'S71 a stale revision should be rejected');
exception when sqlstate '40001' then
  perform pg_temp.ok(sqlerrm like '%stale_correction_request%', 'S71 a stale revision on a terms correction is rejected (40001), matching repair_customer_package_balance''s pattern');
end $$;

-- S72: a same-organization READ-ONLY member (membership.read only) cannot
-- correct terms.
do $$ begin perform pg_temp.act_as('02000000-0000-4000-8000-0000000000c3', '02000000-0000-4000-8000-000000000001'); end $$;
do $$ declare v_revision int; begin
  select revision into v_revision from public.customer_packages where id = pg_temp.id_of('terms_edit_cp');
  perform app.update_customer_package_terms(pg_temp.id_of('terms_edit_cp'), v_revision, 'unauthorized attempt', now(), null, null);
  perform pg_temp.ok(false, 'S72 a read-only member should not be able to correct terms');
exception when insufficient_privilege then
  perform pg_temp.ok(sqlerrm like '%missing_permission:membership.manage%' or sqlerrm like '%not_authorized%', 'S72 read-only member is denied terms correction (membership.manage required)');
end $$;
do $$ begin perform pg_temp.act_as('02000000-0000-4000-8000-0000000000c1', '02000000-0000-4000-8000-000000000001'); end $$;

-- S73: cross-customer pet -- pet_id must belong to the SAME customer as
-- the membership being corrected. First confirm the SAME-customer case
-- (f101 belongs to c101, same as terms_edit_cp) succeeds, establishing the
-- baseline before the negative cross-customer case.
do $$ declare v_revision int; v_row public.customer_packages; begin
  select revision into v_revision from public.customer_packages where id = pg_temp.id_of('terms_edit_cp');
  v_row := app.update_customer_package_terms(pg_temp.id_of('terms_edit_cp'), v_revision, 'same-customer pet reassignment', now(), '02000000-0000-4000-8000-00000000f101', null);
  perform pg_temp.ok(v_row.pet_id = '02000000-0000-4000-8000-00000000f101', 'S73 a pet belonging to the SAME customer is accepted');
end $$;
do $$ declare v_revision int; begin
  -- Attempt a pet belonging to Cust A2 (c102, created for the finding #4
  -- fixtures above) while correcting a membership owned by Cust A1 (c101).
  select revision into v_revision from public.customer_packages where id = pg_temp.id_of('terms_edit_cp');
  perform app.update_customer_package_terms(pg_temp.id_of('terms_edit_cp'), v_revision, 'cross-customer pet attempt', now(), '02000000-0000-4000-8000-00000000f201', null);
  perform pg_temp.ok(false, 'S74 a pet belonging to a DIFFERENT customer should be rejected');
exception when sqlstate 'P0002' then
  perform pg_temp.ok(sqlerrm like '%pet_not_found_for_customer%', 'S74 assigning a pet that belongs to a different customer is rejected (pet_not_found_for_customer)');
end $$;

-- S75/S76: held/consumed restriction -- pet_id/service_id cannot be
-- corrected once ANY reservation has ever existed (per_pet_cp has one from
-- S2), but expires_at alone remains correctable even then.
do $$ declare v_revision int; begin
  select revision into v_revision from public.customer_packages where id = pg_temp.id_of('per_pet_cp');
  perform app.update_customer_package_terms(pg_temp.id_of('per_pet_cp'), v_revision, 'attempt to retarget a held membership', now(), null, null);
  perform pg_temp.ok(false, 'S75 changing pet_id on a membership with reservation history should be rejected');
exception when check_violation then
  perform pg_temp.ok(sqlerrm like '%entitlement_scope_locked_after_first_reservation%' or sqlerrm like '%entitlement_scope_locked_after_renewal%', 'S75 pet/service scope is locked once a membership has ANY reservation history or has been renewed');
end $$;
do $$ declare v_revision int; v_row public.customer_packages; v_pet uuid; v_service uuid; begin
  select revision, pet_id, service_id into v_revision, v_pet, v_service from public.customer_packages where id = pg_temp.id_of('per_pet_cp');
  v_row := app.update_customer_package_terms(pg_temp.id_of('per_pet_cp'), v_revision, 'expiry-only correction on a locked membership', (now() + interval '30 days'), v_pet, v_service);
  perform pg_temp.ok(v_row.pet_id = v_pet and v_row.service_id = v_service, 'S76 expires_at remains correctable on a scope-locked membership as long as pet_id/service_id are resubmitted UNCHANGED');
end $$;

do $$ begin perform pg_temp.act_as('02000000-0000-4000-8000-0000000000c1', '02000000-0000-4000-8000-000000000001'); end $$;

-- Closeout: direct RPC calls must not bypass optimistic concurrency with NULL.
do $$
declare before_row public.customer_packages; after_row public.customer_packages; events_before bigint;
begin
  select * into before_row from public.customer_packages where id = pg_temp.id_of('per_pet_cp');
  select count(*) into events_before from public.timeline_events where subject_id = before_row.id;
  begin
    perform app.update_customer_package_terms(before_row.id, null, 'null revision regression', now() + interval '300 days', before_row.pet_id, before_row.service_id);
    raise exception 'NULL correction revision unexpectedly accepted';
  exception when serialization_failure then
    perform pg_temp.ok(sqlerrm = 'stale_correction_request', 'C1 NULL correction revision rejected');
  end;
  select * into after_row from public.customer_packages where id = before_row.id;
  perform pg_temp.ok(after_row is not distinct from before_row and events_before = (select count(*) from public.timeline_events where subject_id = before_row.id), 'C2 rejected correction leaves row and audit untouched');
  begin
    perform app.update_customer_package_terms(before_row.id, before_row.revision - 1, 'stale revision regression', now(), before_row.pet_id, before_row.service_id);
    raise exception 'Stale correction unexpectedly accepted';
  exception when serialization_failure then
    perform pg_temp.ok(sqlerrm = 'stale_correction_request', 'C3 stale correction revision rejected');
  end;
  after_row := app.update_customer_package_terms(before_row.id, before_row.revision, 'current revision regression', now() + interval '90 days', before_row.pet_id, before_row.service_id);
  perform pg_temp.ok(after_row.revision = before_row.revision + 1 and after_row.pet_id is not distinct from before_row.pet_id and after_row.service_id is not distinct from before_row.service_id and after_row.expires_at = now() + interval '90 days', 'C4 valid expiry correction preserves locked scope and advances revision');
end $$;

-- Drift is injected only into the disposable cache fixture, not the immutable ledger.
update public.customer_packages set sessions_remaining = sessions_remaining + 7 where id = pg_temp.id_of('per_pet_cp');
do $$
declare before_row public.customer_packages; after_row public.customer_packages; repaired public.customer_packages;
  events_before bigint; ledger_balance numeric; repair_key uuid := 'ffcf0000-0000-4000-8000-000000000001';
begin
  select * into before_row from public.customer_packages where id = pg_temp.id_of('per_pet_cp');
  select count(*) into events_before from public.timeline_events where subject_id = before_row.id and event_type = 'membership.balance_repaired';
  select sum(delta) into ledger_balance from public.customer_package_ledger where customer_package_id = before_row.id;
  perform pg_temp.ok(before_row.sessions_remaining <> ledger_balance, 'C5 repair fixture contains actual drift');
  begin
    perform app.repair_customer_package_balance(before_row.id, null, repair_key);
    raise exception 'NULL repair revision unexpectedly accepted';
  exception when serialization_failure then
    perform pg_temp.ok(sqlerrm = 'stale_repair_request', 'C6 NULL revision with fresh repair key rejected');
  end;
  select * into after_row from public.customer_packages where id = before_row.id;
  perform pg_temp.ok(after_row is not distinct from before_row and events_before = (select count(*) from public.timeline_events where subject_id = before_row.id and event_type = 'membership.balance_repaired'), 'C7 rejected repair leaves drift, revision and audit untouched');
  repaired := app.repair_customer_package_balance(before_row.id, before_row.revision, repair_key);
  after_row := app.repair_customer_package_balance(before_row.id, before_row.revision, repair_key);
  perform pg_temp.ok(repaired.sessions_remaining = ledger_balance and repaired.revision = before_row.revision + 1 and after_row is not distinct from repaired and events_before + 1 = (select count(*) from public.timeline_events where subject_id = before_row.id and event_type = 'membership.balance_repaired'), 'C8 valid repair and original-revision retry have one effect');
end $$;

-- Run these denials as the actual SQL authenticated role, not just a superuser JWT.
do $$ begin perform pg_temp.act_as('02000000-0000-4000-8000-0000000000c3', '02000000-0000-4000-8000-000000000001'); end $$;
set local role authenticated;
do $$ begin
  perform app.repair_customer_package_balance(pg_temp.id_of('per_pet_cp'), null, 'ffcf0000-0000-4000-8000-000000000001');
  raise exception 'Read-only repair retry unexpectedly accepted';
exception when insufficient_privilege then
  perform pg_temp.ok(true, 'C9 successful repair key cannot bypass read-only authorization');
end $$;
do $$ begin
  perform app.update_customer_package_terms(pg_temp.id_of('per_pet_cp'), null, 'unauthorized', now(), null, null);
  raise exception 'Read-only correction unexpectedly accepted';
exception when insufficient_privilege then
  perform pg_temp.ok(true, 'C10 read-only correction denied before revision checks');
end $$;
reset role;

rollback;
-- END package_lifecycle_smoke
