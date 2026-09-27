-- =====================================================================
-- TEST — Engine 3 payroll engine (sections 32-33), deterministic fixture.
-- Expected values below are computed BY HAND against the calculation
-- contract (docs/handoffs/ENGINE-3-S32-S33-HANDOFF.md Section 5), not by
-- calling the function under test to generate its own expected result
-- (brief section 10 requirement).
-- Run: apply 0001..20261001120000, then
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/20261001100000_test_payroll_engine.sql
-- Uses a FULLY PAST period (2026-01-26..2026-02-26) so the "cap worked-days at
-- today" rule in app.payroll_working_day_stats never truncates results,
-- keeping every assertion below deterministic regardless of the real date
-- this suite is run on.
-- =====================================================================
\set ON_ERROR_STOP on
create or replace function pg_temp.ok(cond boolean, label text)
returns void language plpgsql as $$
begin if cond then raise notice 'PASS: %', label; else raise exception 'FAIL: %', label; end if; end $$;
create or replace function pg_temp.act_as(u text, o text) returns void language plpgsql as $$
begin perform set_config('request.jwt.claims', json_build_object('sub', u, 'active_org_id', o)::text, true); end $$;

begin;

-- ---------------------------------------------------------------------
-- FIXTURE: org, branch (Asia/Jakarta), owner + a no-payroll-permission
-- member, two service-role-tagged services, two groomers with weekly
-- availability, per-groomer settings, and a customer/pet set.
-- ---------------------------------------------------------------------
insert into public.organizations (id, name, slug, status) values
  ('0f200000-0000-4000-8000-000000000001', 'Payroll Test Org', 'payroll-test-org', 'active');
insert into public.branches (id, organization_id, name, is_default, status, timezone) values
  ('0f200000-0000-4000-8000-0000000000a1', '0f200000-0000-4000-8000-000000000001', 'Main', true, 'active', 'Asia/Jakarta');

insert into auth.users (id) values
  ('0f200000-0000-4000-8000-0000000000c1'), ('0f200000-0000-4000-8000-0000000000c2'),
  ('0f200000-0000-4000-8000-0000000000c3'), ('0f200000-0000-4000-8000-0000000000c9')
  on conflict (id) do nothing;
insert into public.users (id, full_name, email, status) values
  ('0f200000-0000-4000-8000-0000000000c1', 'Owner', 'owner@payroll-test.local', 'active'),
  ('0f200000-0000-4000-8000-0000000000c2', 'Groomer A', 'groomer-a@payroll-test.local', 'active'),
  ('0f200000-0000-4000-8000-0000000000c3', 'Groomer B', 'groomer-b@payroll-test.local', 'active'),
  ('0f200000-0000-4000-8000-0000000000c9', 'No Payroll Access', 'noaccess@payroll-test.local', 'active')
  on conflict (id) do update set full_name = excluded.full_name, email = excluded.email, status = excluded.status;

insert into public.roles (id, organization_id, name, is_system) values
  ('0f200000-0000-4000-8000-0000000000e1', '0f200000-0000-4000-8000-000000000001', 'Owner', true),
  ('0f200000-0000-4000-8000-0000000000e2', '0f200000-0000-4000-8000-000000000001', 'Groomer', true);
insert into public.memberships (id, organization_id, user_id, role_id, status) values
  ('0f200000-0000-4000-8000-0000000000d1', '0f200000-0000-4000-8000-000000000001', '0f200000-0000-4000-8000-0000000000c1', '0f200000-0000-4000-8000-0000000000e1', 'active'),
  ('0f200000-0000-4000-8000-0000000000d2', '0f200000-0000-4000-8000-000000000001', '0f200000-0000-4000-8000-0000000000c2', '0f200000-0000-4000-8000-0000000000e2', 'active'),
  ('0f200000-0000-4000-8000-0000000000d3', '0f200000-0000-4000-8000-000000000001', '0f200000-0000-4000-8000-0000000000c3', '0f200000-0000-4000-8000-0000000000e2', 'active'),
  ('0f200000-0000-4000-8000-0000000000d9', '0f200000-0000-4000-8000-000000000001', '0f200000-0000-4000-8000-0000000000c9', '0f200000-0000-4000-8000-0000000000e2', 'active');
insert into public.membership_branch_access (organization_id, membership_id, branch_id)
  select '0f200000-0000-4000-8000-000000000001', id, '0f200000-0000-4000-8000-0000000000a1' from public.memberships
  where organization_id = '0f200000-0000-4000-8000-000000000001';

insert into public.permissions (key, resource, action, description) values
  ('booking.read', 'booking', 'read', 'r'), ('booking.update', 'booking', 'update', 'u'),
  ('booking.complete', 'booking', 'complete', 'c'), ('branches.all', 'branches', 'all', 'a'),
  ('service.manage', 'service', 'manage', 's'), ('resource.manage', 'resource', 'manage', 'r'),
  ('payroll.read', 'payroll', 'read', 'pr'), ('payroll.manage', 'payroll', 'manage', 'pm'),
  ('payroll.approve', 'payroll', 'approve', 'pa'), ('invoice.issue', 'invoice', 'issue', 'ii')
  on conflict (key) do nothing;
insert into public.role_permissions (organization_id, role_id, permission_id)
  select '0f200000-0000-4000-8000-000000000001', '0f200000-0000-4000-8000-0000000000e1', p.id
  from public.permissions p where p.key in
    ('booking.read', 'booking.update', 'booking.complete', 'branches.all', 'service.manage', 'resource.manage', 'payroll.read', 'payroll.manage', 'payroll.approve', 'invoice.issue');
insert into public.role_permissions (organization_id, role_id, permission_id)
  select '0f200000-0000-4000-8000-000000000001', '0f200000-0000-4000-8000-0000000000e2', p.id
  from public.permissions p where p.key in ('booking.read', 'booking.complete');

insert into public.organization_modules (organization_id, module_id, enabled)
  select '0f200000-0000-4000-8000-000000000001', m.id, true from public.modules m
  where m.key in ('scheduling', 'payroll', 'finance') on conflict (organization_id, module_id) do update set enabled = true;
insert into public.subscriptions (organization_id, status) values ('0f200000-0000-4000-8000-000000000001', 'active') on conflict do nothing;

-- Services: basic_grooming @ 100000, styling @ 50000, botak @ 30000 (own currency-agnostic units).
insert into public.service_catalog (id, organization_id, name, base_price, currency, duration_minutes, is_active, payroll_role) values
  ('0f200000-0000-4000-8000-000000005001', '0f200000-0000-4000-8000-000000000001', 'Basic', 100000, 'IDR', 90, true, 'basic_grooming'),
  ('0f200000-0000-4000-8000-000000005002', '0f200000-0000-4000-8000-000000000001', 'Styling', 50000, 'IDR', 30, true, 'styling'),
  ('0f200000-0000-4000-8000-000000005003', '0f200000-0000-4000-8000-000000000001', 'Botak', 30000, 'IDR', 20, true, 'botak');

-- Groomers: A and B, both hired well before the test period (no join-date-guard interference).
insert into public.resources (id, organization_id, branch_id, kind, name, capacity, status, membership_id, hired_at) values
  ('0f200000-0000-4000-8000-00000000e501', '0f200000-0000-4000-8000-000000000001', '0f200000-0000-4000-8000-0000000000a1', 'staff', 'Groomer A', 1, 'active', '0f200000-0000-4000-8000-0000000000d2', '2020-01-01'),
  ('0f200000-0000-4000-8000-00000000e502', '0f200000-0000-4000-8000-000000000001', '0f200000-0000-4000-8000-0000000000a1', 'staff', 'Groomer B', 1, 'active', '0f200000-0000-4000-8000-0000000000d3', '2020-01-01');
-- Available every day of the week (dow 0-6) for both groomers -- isolates the
-- styling/botak/transport/perDog assertions below from weekly-proration noise.
insert into public.resource_availability (organization_id, branch_id, resource_id, kind, day_of_week, start_time, end_time)
select '0f200000-0000-4000-8000-000000000001', '0f200000-0000-4000-8000-0000000000a1', r.id, 'available', d, '08:00', '18:00'
from (values ('0f200000-0000-4000-8000-00000000e501'::uuid), ('0f200000-0000-4000-8000-00000000e502'::uuid)) as r(id)
cross join generate_series(0, 6) as d;

insert into public.staff_compensation (organization_id, membership_id, pay_type, base_amount, currency, effective_from, is_active) values
  ('0f200000-0000-4000-8000-000000000001', '0f200000-0000-4000-8000-0000000000d2', 'salary', 1000000, 'IDR', '2025-01-01', true),
  ('0f200000-0000-4000-8000-000000000001', '0f200000-0000-4000-8000-0000000000d3', 'salary', 1200000, 'IDR', '2025-01-01', true);

-- Cycle settings: cycle_start_day=26 (matches HomePaw default), a SMALL custom
-- styling tier so the boundary test doesn't need 17 fixture bookings:
-- 1-2 styling jobs -> 10%, 3+ -> 25%. Per-pet size matrix: small=15000 (flat
-- default stays 20000 for anything else).
insert into public.payroll_cycle_settings
  (organization_id, cycle_start_day, botak_amount_default, per_pet_amount_default, per_pet_size_matrix_default, styling_tiers_default)
values
  ('0f200000-0000-4000-8000-000000000001', 26, 10000, 20000, '{"small":15000}'::jsonb, '[{"min_jobs":1,"pct":10},{"min_jobs":3,"pct":25}]'::jsonb);

-- Groomer A: no-late + no-sick bonus enabled (100000 each), styling enabled
-- (inherits org tiers), botak/per-pet enabled (inherit org defaults).
-- Groomer B: styling enabled with a PER-GROOMER override tier (always 50%,
-- regardless of count) to prove per-groomer override beats the org default.
insert into public.staff_payroll_settings
  (organization_id, membership_id, no_late_enabled, no_late_amount, no_sick_enabled, no_sick_amount, styling_enabled, botak_enabled, per_pet_enabled)
values
  ('0f200000-0000-4000-8000-000000000001', '0f200000-0000-4000-8000-0000000000d2', true, 100000, true, 100000, true, true, true);
insert into public.staff_payroll_settings
  (organization_id, membership_id, styling_enabled, styling_tiers, botak_enabled, per_pet_enabled)
values
  ('0f200000-0000-4000-8000-000000000001', '0f200000-0000-4000-8000-0000000000d3', true, '[{"min_jobs":1,"pct":50}]'::jsonb, true, true);

insert into public.customers (id, organization_id, display_name) values
  ('0f200000-0000-4000-8000-00000000c101', '0f200000-0000-4000-8000-000000000001', 'Customer 1');
insert into public.pets (id, organization_id, customer_id, name, size) values
  ('0f200000-0000-4000-8000-00000000f101', '0f200000-0000-4000-8000-000000000001', '0f200000-0000-4000-8000-00000000c101', 'Pet Small', 'small'),
  ('0f200000-0000-4000-8000-00000000f102', '0f200000-0000-4000-8000-000000000001', '0f200000-0000-4000-8000-00000000c101', 'Pet NoSize', null),
  ('0f200000-0000-4000-8000-00000000f103', '0f200000-0000-4000-8000-000000000001', '0f200000-0000-4000-8000-00000000c101', 'Pet Botak Only', null),
  ('0f200000-0000-4000-8000-00000000f104', '0f200000-0000-4000-8000-000000000001', '0f200000-0000-4000-8000-00000000c101', 'Pet Styling 1', null),
  ('0f200000-0000-4000-8000-00000000f105', '0f200000-0000-4000-8000-000000000001', '0f200000-0000-4000-8000-00000000c101', 'Pet Styling 2', null),
  ('0f200000-0000-4000-8000-00000000f106', '0f200000-0000-4000-8000-000000000001', '0f200000-0000-4000-8000-00000000c101', 'Pet Styling B1', null),
  ('0f200000-0000-4000-8000-00000000f107', '0f200000-0000-4000-8000-000000000001', '0f200000-0000-4000-8000-00000000c101', 'Pet Transport 1', null),
  ('0f200000-0000-4000-8000-00000000f108', '0f200000-0000-4000-8000-000000000001', '0f200000-0000-4000-8000-00000000c101', 'Pet Transport 2', null),
  ('0f200000-0000-4000-8000-00000000f109', '0f200000-0000-4000-8000-000000000001', '0f200000-0000-4000-8000-00000000c101', 'Pet Missing Invoice', null);

do $$ begin perform pg_temp.act_as('0f200000-0000-4000-8000-0000000000c1', '0f200000-0000-4000-8000-000000000001'); end $$;

-- ---------------------------------------------------------------------
-- ONE consolidated multi-pet, multi-groomer, home-fulfillment booking
-- (travel_fee=100000) covering every scenario below in a single invoice.
-- Consolidated deliberately: app.issue_invoice_for_booking's invoice-number
-- generator truncates the new order's UUIDv7 to its top 32 timestamp bits,
-- which barely change for ~65 SECONDS at a time (a real, pre-existing bug in
-- a shared, already-merged migration -- not this engine's to fix, flagged
-- separately) -- so two invoices issued less than ~a minute apart collide.
-- One booking, one invoice, sidesteps it entirely.
--
-- Pet Small (A, basic, size=small)      -> perDog 15000 (matrix)
-- Pet NoSize (A, basic, no size)        -> perDog 20000 (flat default)
-- Pet Botak Only (A, botak only)        -> botak 10000, no perDog
-- Pet Styling 1/2 (A, styling x2)       -> count=2, org tier 1-2=10%%
-- Pet Styling B1 (B, styling x1)        -> count=1, B's own override tier 50%%
-- Pet Transport 1 (A, basic)            -> qualifies A for the transport pool
-- Pet Transport 2 (B, basic)            -> qualifies B for the transport pool
-- half_pool = round(100000/2) = 50000, split equally A=25000/B=25000 (sums
-- to exactly 50000 -- the bug this engine fixed: HomePaw would have paid
-- round(100000/2)=50000 to EACH groomer independently, i.e. 100000 total).
-- ---------------------------------------------------------------------
insert into public.bookings (id, organization_id, branch_id, customer_id, booking_type, status, starts_at, ends_at, fulfillment_mode, travel_fee) values
  ('0f200000-0000-4000-8000-00000000ba01', '0f200000-0000-4000-8000-000000000001', '0f200000-0000-4000-8000-0000000000a1', '0f200000-0000-4000-8000-00000000c101', 'grooming', 'confirmed', '2026-02-01 09:00:00+07', '2026-02-01 15:00:00+07', 'home', 100000);
do $$
declare v_small uuid; v_nosize uuid; v_botak uuid; v_sty1 uuid; v_sty2 uuid; v_styb uuid; v_tr1 uuid; v_tr2 uuid;
begin
  v_small := app.assembly_add_pet('0f200000-0000-4000-8000-00000000ba01', '0f200000-0000-4000-8000-00000000f101', true);
  perform app.assembly_add_line(v_small, '0f200000-0000-4000-8000-000000005001', 1);
  perform app.assembly_assign_pet_resource(v_small, '0f200000-0000-4000-8000-00000000e501');

  v_nosize := app.assembly_add_pet('0f200000-0000-4000-8000-00000000ba01', '0f200000-0000-4000-8000-00000000f102', true);
  perform app.assembly_add_line(v_nosize, '0f200000-0000-4000-8000-000000005001', 1);
  perform app.assembly_assign_pet_resource(v_nosize, '0f200000-0000-4000-8000-00000000e501');

  v_botak := app.assembly_add_pet('0f200000-0000-4000-8000-00000000ba01', '0f200000-0000-4000-8000-00000000f103', true);
  perform app.assembly_add_line(v_botak, '0f200000-0000-4000-8000-000000005003', 1);
  perform app.assembly_assign_pet_resource(v_botak, '0f200000-0000-4000-8000-00000000e501');

  v_sty1 := app.assembly_add_pet('0f200000-0000-4000-8000-00000000ba01', '0f200000-0000-4000-8000-00000000f104', true);
  perform app.assembly_add_line(v_sty1, '0f200000-0000-4000-8000-000000005002', 1);
  perform app.assembly_assign_pet_resource(v_sty1, '0f200000-0000-4000-8000-00000000e501');

  v_sty2 := app.assembly_add_pet('0f200000-0000-4000-8000-00000000ba01', '0f200000-0000-4000-8000-00000000f105', true);
  perform app.assembly_add_line(v_sty2, '0f200000-0000-4000-8000-000000005002', 1);
  perform app.assembly_assign_pet_resource(v_sty2, '0f200000-0000-4000-8000-00000000e501');

  v_styb := app.assembly_add_pet('0f200000-0000-4000-8000-00000000ba01', '0f200000-0000-4000-8000-00000000f106', true);
  perform app.assembly_add_line(v_styb, '0f200000-0000-4000-8000-000000005002', 1);
  perform app.assembly_assign_pet_resource(v_styb, '0f200000-0000-4000-8000-00000000e502');

  v_tr1 := app.assembly_add_pet('0f200000-0000-4000-8000-00000000ba01', '0f200000-0000-4000-8000-00000000f107', true);
  perform app.assembly_add_line(v_tr1, '0f200000-0000-4000-8000-000000005001', 1);
  perform app.assembly_assign_pet_resource(v_tr1, '0f200000-0000-4000-8000-00000000e501');

  v_tr2 := app.assembly_add_pet('0f200000-0000-4000-8000-00000000ba01', '0f200000-0000-4000-8000-00000000f108', true);
  perform app.assembly_add_line(v_tr2, '0f200000-0000-4000-8000-000000005001', 1);
  perform app.assembly_assign_pet_resource(v_tr2, '0f200000-0000-4000-8000-00000000e502');

  update public.grooming_job_pets set status = 'complete'
   where id in (v_small, v_nosize, v_botak, v_sty1, v_sty2, v_styb, v_tr1, v_tr2);
end $$;
select app.complete_booking('0f200000-0000-4000-8000-00000000ba01');
select app.issue_invoice_for_booking('0f200000-0000-4000-8000-00000000ba01', p_document_type := 'invoice');

-- ---------------------------------------------------------------------
-- BOOKING 5 (Groomer A): completed pet with NO invoice -> the missing-
-- invoice exception queue, never silently dropped, never fabricated.
-- ---------------------------------------------------------------------
insert into public.bookings (id, organization_id, branch_id, customer_id, booking_type, status, starts_at, ends_at, fulfillment_mode) values
  ('0f200000-0000-4000-8000-00000000ba05', '0f200000-0000-4000-8000-000000000001', '0f200000-0000-4000-8000-0000000000a1', '0f200000-0000-4000-8000-00000000c101', 'grooming', 'confirmed', '2026-02-05 09:00:00+07', '2026-02-05 11:00:00+07', 'in_store');
do $$
declare v_p1 uuid;
begin
  v_p1 := app.assembly_add_pet('0f200000-0000-4000-8000-00000000ba05', '0f200000-0000-4000-8000-00000000f109', true);
  perform app.assembly_add_line(v_p1, '0f200000-0000-4000-8000-000000005001', 1);
  perform app.assembly_assign_pet_resource(v_p1, '0f200000-0000-4000-8000-00000000e501');
  update public.grooming_job_pets set status = 'complete' where id = v_p1;
end $$;
select app.complete_booking('0f200000-0000-4000-8000-00000000ba05');
-- deliberately no issue_invoice_for_booking call here

-- Groomer A has one unwaived late attendance record -> no-late bonus must be 0.
-- (booking 1's own scheduled/checked-in times feed this directly.)
insert into public.attendance_records (organization_id, branch_id, booking_id, resource_id, membership_id, scheduled_at, checked_in_at, classification, late_minutes)
values ('0f200000-0000-4000-8000-000000000001', '0f200000-0000-4000-8000-0000000000a1', '0f200000-0000-4000-8000-00000000ba01', '0f200000-0000-4000-8000-00000000e501', '0f200000-0000-4000-8000-0000000000d2', '2026-02-01 09:00:00+07', '2026-02-01 09:20:00+07', 'late', 20);

-- ===== ASSERTIONS: eligibility, tiers, transport split, missing queue =====
do $$
declare v_run uuid; v_a jsonb; v_b jsonb; v_missing_count int;
begin
  v_run := app.recompute_payroll_run('2026-01-26'::date, '2026-02-26'::date, null);
  perform pg_temp.ok(v_run is not null, 'recompute creates a run for the fully-past fixture period');

  select breakdown into v_a from public.payroll_items where organization_id = '0f200000-0000-4000-8000-000000000001' and payroll_run_id = v_run and membership_id = '0f200000-0000-4000-8000-0000000000d2';
  select breakdown into v_b from public.payroll_items where organization_id = '0f200000-0000-4000-8000-000000000001' and payroll_run_id = v_run and membership_id = '0f200000-0000-4000-8000-0000000000d3';

  perform pg_temp.ok((v_a->>'basic')::numeric = 1000000, 'A basic salary passthrough = 1000000');
  perform pg_temp.ok((v_a->>'noLate')::numeric = 0, 'A no-late bonus is ZERO (one unwaived late record)');
  perform pg_temp.ok((v_a->>'noSick')::numeric = 100000, 'A no-sick bonus is full (zero sick days)');
  perform pg_temp.ok((v_a->>'perDog')::numeric = 55000, 'A perDog = 15000 (small matrix) + 20000 (nosize) + 20000 (transport pet, flat) = 55000, botak-only pet excluded');
  perform pg_temp.ok((v_a->>'botak')::numeric = 10000, 'A botak incentive = 10000 (one botak-only pet, org default rate)');
  perform pg_temp.ok((v_a->>'styling')::numeric = 10000, 'A styling = round(100000 revenue * 10%% tier for count=2) = 10000');
  perform pg_temp.ok((v_a->>'transport')::numeric = 25000, 'A transport half-share = 25000 (100000 travel_fee / 2, split equally with B)');

  perform pg_temp.ok((v_b->>'styling')::numeric = 25000, 'B styling = round(50000 revenue * 50%% PER-GROOMER override tier) = 25000, not the org default');
  perform pg_temp.ok((v_b->>'transport')::numeric = 25000, 'B transport half-share = 25000 -- A+B shares sum to exactly 50000, never exceeding the pool');
  perform pg_temp.ok((v_b->>'perDog')::numeric = 20000, 'B perDog = 20000 (flat default, transport pet has no size)');

  select count(*) into v_missing_count from app.payroll_missing_invoice_pets('0f200000-0000-4000-8000-000000000001', '2026-01-26', '2026-02-26');
  perform pg_temp.ok(v_missing_count = 1, 'exactly one completed-but-uninvoiced pet is flagged, not silently dropped');
end $$;

-- ===== ASSERTIONS: full lifecycle -- approve/pay/idempotent-retry/undo =====
do $$
declare v_run uuid; v_status text; v_total numeric; v_ledger_count int; v_items_before int; v_items_after int;
begin
  select id, status, total_net into v_run, v_status, v_total from public.payroll_runs
  where organization_id = '0f200000-0000-4000-8000-000000000001' and period_start = '2026-01-26' and period_end = '2026-02-26';

  perform app.approve_payroll_run(v_run);
  perform pg_temp.ok((select status from public.payroll_runs where id = v_run) = 'approved', 'approve moves draft -> approved');

  select count(*) into v_items_before from public.payroll_items where payroll_run_id = v_run;

  perform app.pay_payroll_run(v_run);
  perform pg_temp.ok((select status from public.payroll_runs where id = v_run) = 'paid', 'pay moves approved -> paid');
  select count(*) into v_ledger_count from public.financial_ledger where payroll_run_id = v_run;
  perform pg_temp.ok(v_ledger_count = 1, 'exactly one payroll_paid ledger entry after the first pay');

  -- idempotent retry: paying an already-paid run must not create a second ledger row.
  perform app.pay_payroll_run(v_run);
  select count(*) into v_ledger_count from public.financial_ledger where payroll_run_id = v_run;
  perform pg_temp.ok(v_ledger_count = 1, 'paying an already-paid run again is a no-op -- still exactly one ledger entry');

  -- undo: auditable reversal, never a delete of the original payroll_items.
  perform app.undo_payroll_payment(v_run, 'test correction');
  perform pg_temp.ok((select status from public.payroll_runs where id = v_run) = 'draft', 'undo moves paid -> draft');
  select count(*) into v_ledger_count from public.financial_ledger where payroll_run_id = v_run;
  perform pg_temp.ok(v_ledger_count = 2, 'undo adds a SECOND compensating ledger entry -- the original is never deleted');
  perform pg_temp.ok(
    (select coalesce(sum(amount), 0) from public.financial_ledger where payroll_run_id = v_run) = 0,
    'the two ledger entries (pay -total_net, undo +total_net) net to exactly zero');
  select count(*) into v_items_after from public.payroll_items where payroll_run_id = v_run;
  perform pg_temp.ok(v_items_after = v_items_before, 'the original payroll_items snapshot rows still exist after undo (not deleted)');
  perform pg_temp.ok((select (metadata->>'correction_count')::int from public.payroll_runs where id = v_run) = 1, 'run metadata records exactly one correction');
end $$;

-- ===== ASSERTIONS: no duplicate/overlapping periods =====
do $$
begin
  begin
    insert into public.payroll_runs (organization_id, period_start, period_end, status)
    values ('0f200000-0000-4000-8000-000000000001', '2026-02-10', '2026-03-10', 'draft');
    perform pg_temp.ok(false, 'an overlapping period must be rejected by the exclusion constraint');
  exception when exclusion_violation then
    perform pg_temp.ok(true, 'excl_payroll_runs_no_overlap rejects an overlapping period for the same org');
  end;
end $$;

-- ===== ASSERTIONS: RLS denies recompute to a member without payroll.manage =====
do $$ begin perform pg_temp.act_as('0f200000-0000-4000-8000-0000000000c9', '0f200000-0000-4000-8000-000000000001'); end $$;
do $$
begin
  begin
    perform app.recompute_payroll_run('2026-03-26'::date, '2026-04-26'::date, null);
    perform pg_temp.ok(false, 'a member without payroll.manage must be denied recompute');
  exception when insufficient_privilege then
    perform pg_temp.ok(true, 'recompute_payroll_run denies a member without payroll.manage (insufficient_privilege)');
  end;
end $$;

do $$ begin perform pg_temp.act_as('0f200000-0000-4000-8000-0000000000c1', '0f200000-0000-4000-8000-000000000001'); end $$;

-- =======================================================================
-- ASSERTIONS: retention deposit -- not-yet-eligible, eligible payout, exact
-- amount, idempotent retry (unique index), and a second groomer's maturity
-- boundary is independent of the first. Tenure is computed from real
-- wall-clock "today" (app.org_today), not the fixture payroll period, so
-- hired_at is set relative to current_date to stay deterministic regardless
-- of when this suite runs.
-- =======================================================================
insert into auth.users (id) values
  ('0f200000-0000-4000-8000-0000000000c4'), ('0f200000-0000-4000-8000-0000000000c5')
  on conflict (id) do nothing;
insert into public.users (id, full_name, email, status) values
  ('0f200000-0000-4000-8000-0000000000c4', 'Groomer C', 'groomer-c@payroll-test.local', 'active'),
  ('0f200000-0000-4000-8000-0000000000c5', 'Groomer D', 'groomer-d@payroll-test.local', 'active')
  on conflict (id) do update set full_name = excluded.full_name, email = excluded.email, status = excluded.status;
insert into public.memberships (id, organization_id, user_id, role_id, status) values
  ('0f200000-0000-4000-8000-0000000000d4', '0f200000-0000-4000-8000-000000000001', '0f200000-0000-4000-8000-0000000000c4', '0f200000-0000-4000-8000-0000000000e2', 'active'),
  ('0f200000-0000-4000-8000-0000000000d5', '0f200000-0000-4000-8000-000000000001', '0f200000-0000-4000-8000-0000000000c5', '0f200000-0000-4000-8000-0000000000e2', 'active');
insert into public.membership_branch_access (organization_id, membership_id, branch_id) values
  ('0f200000-0000-4000-8000-000000000001', '0f200000-0000-4000-8000-0000000000d4', '0f200000-0000-4000-8000-0000000000a1'),
  ('0f200000-0000-4000-8000-000000000001', '0f200000-0000-4000-8000-0000000000d5', '0f200000-0000-4000-8000-0000000000a1');
-- Groomer C: hired 3 months ago, term=2 months -> ELIGIBLE (tenure 3 >= term 2).
-- Groomer D: hired 1 month ago, term=2 months -> NOT YET ELIGIBLE (tenure 1 < term 2).
insert into public.resources (id, organization_id, branch_id, kind, name, capacity, status, membership_id, hired_at) values
  ('0f200000-0000-4000-8000-00000000e503', '0f200000-0000-4000-8000-000000000001', '0f200000-0000-4000-8000-0000000000a1', 'staff', 'Groomer C', 1, 'active', '0f200000-0000-4000-8000-0000000000d4', (current_date - interval '3 months')::date),
  ('0f200000-0000-4000-8000-00000000e504', '0f200000-0000-4000-8000-000000000001', '0f200000-0000-4000-8000-0000000000a1', 'staff', 'Groomer D', 1, 'active', '0f200000-0000-4000-8000-0000000000d5', (current_date - interval '1 month')::date);
insert into public.staff_payroll_settings (organization_id, membership_id, retention_enabled, retention_amount_per_month, retention_term_months) values
  ('0f200000-0000-4000-8000-000000000001', '0f200000-0000-4000-8000-0000000000d4', true, 200000, 2),
  ('0f200000-0000-4000-8000-000000000001', '0f200000-0000-4000-8000-0000000000d5', true, 200000, 2);

do $$
declare v_event public.payroll_retention_events%rowtype; v_count int;
begin
  -- D: not yet eligible (tenure 1 < term 2) -> rejected, no event written.
  begin
    perform app.pay_retention_deposit('0f200000-0000-4000-8000-0000000000d5');
    perform pg_temp.ok(false, 'D retention payout before maturity must be rejected');
  exception when check_violation then
    perform pg_temp.ok(sqlerrm like '%retention_not_yet_payable%', 'D retention payout rejected: retention_not_yet_payable');
  end;
  select count(*) into v_count from public.payroll_retention_events where membership_id = '0f200000-0000-4000-8000-0000000000d5';
  perform pg_temp.ok(v_count = 0, 'D has no retention event recorded after the rejected attempt');

  -- C: eligible (tenure 3 >= term 2) -> min(term=2, tenure=3) * 200000 = 400000.
  v_event := app.pay_retention_deposit('0f200000-0000-4000-8000-0000000000d4');
  perform pg_temp.ok(v_event.amount = 400000, 'C retention payout = min(term_months=2, tenure=3) * 200000/month = 400000');
  perform pg_temp.ok(v_event.kind = 'payout', 'C retention event kind is payout');

  -- Idempotent retry: the unique index (one payout per member) is caught and the
  -- SAME event is returned, not a raw constraint error and not a second row.
  v_event := app.pay_retention_deposit('0f200000-0000-4000-8000-0000000000d4');
  perform pg_temp.ok(v_event.amount = 400000, 'C retention retry returns the SAME already-recorded amount (idempotent)');
  select count(*) into v_count from public.payroll_retention_events where membership_id = '0f200000-0000-4000-8000-0000000000d4' and kind = 'payout';
  perform pg_temp.ok(v_count = 1, 'C has exactly one payout event despite two calls -- unique index enforced, not a duplicate lump sum');

  -- D remains unaffected by C's payout (independent per-membership eligibility).
  select count(*) into v_count from public.payroll_retention_events where membership_id = '0f200000-0000-4000-8000-0000000000d5';
  perform pg_temp.ok(v_count = 0, 'D still has zero retention events -- C''s payout did not leak across memberships');
end $$;

-- =======================================================================
-- ASSERTIONS: cross-tenant isolation -- a second organization's owner
-- cannot act on this org's payroll run even by ID (RPCs scope every query
-- on `organization_id = v_org` derived from the caller's OWN active-org
-- JWT claim, not a client-supplied value, so a guessed/leaked run id from
-- another tenant resolves to "not found", never a cross-tenant read/write).
-- =======================================================================
insert into public.organizations (id, name, slug, status) values
  ('0f200000-0000-4000-8000-000000000002', 'Payroll Test Org 2', 'payroll-test-org-2', 'active');
insert into public.branches (id, organization_id, name, is_default, status, timezone) values
  ('0f200000-0000-4000-8000-0000000000a2', '0f200000-0000-4000-8000-000000000002', 'Main', true, 'active', 'Asia/Jakarta');
insert into auth.users (id) values ('0f200000-0000-4000-8000-0000000000c8') on conflict (id) do nothing;
insert into public.users (id, full_name, email, status) values
  ('0f200000-0000-4000-8000-0000000000c8', 'Owner Org2', 'owner2@payroll-test.local', 'active')
  on conflict (id) do update set full_name = excluded.full_name, email = excluded.email, status = excluded.status;
insert into public.roles (id, organization_id, name, is_system) values
  ('0f200000-0000-4000-8000-0000000000e8', '0f200000-0000-4000-8000-000000000002', 'Owner', true);
insert into public.memberships (id, organization_id, user_id, role_id, status) values
  ('0f200000-0000-4000-8000-0000000000d8', '0f200000-0000-4000-8000-000000000002', '0f200000-0000-4000-8000-0000000000c8', '0f200000-0000-4000-8000-0000000000e8', 'active');
insert into public.role_permissions (organization_id, role_id, permission_id)
  select '0f200000-0000-4000-8000-000000000002', '0f200000-0000-4000-8000-0000000000e8', p.id
  from public.permissions p where p.key in ('payroll.read', 'payroll.manage', 'payroll.approve');
insert into public.organization_modules (organization_id, module_id, enabled)
  select '0f200000-0000-4000-8000-000000000002', m.id, true from public.modules m
  where m.key = 'payroll' on conflict (organization_id, module_id) do update set enabled = true;
insert into public.subscriptions (organization_id, status) values ('0f200000-0000-4000-8000-000000000002', 'active') on conflict do nothing;

do $$
declare v_org1_run uuid;
begin
  select id into v_org1_run from public.payroll_runs
  where organization_id = '0f200000-0000-4000-8000-000000000001' and period_start = '2026-01-26' and period_end = '2026-02-26';
  perform pg_temp.ok(v_org1_run is not null, 'org1''s run id resolved for the cross-tenant probe below');

  perform pg_temp.act_as('0f200000-0000-4000-8000-0000000000c8', '0f200000-0000-4000-8000-000000000002');
  begin
    perform app.approve_payroll_run(v_org1_run);
    perform pg_temp.ok(false, 'org2''s owner approving org1''s run id must be rejected');
  exception when no_data_found then
    perform pg_temp.ok(true, 'org2''s owner cannot approve org1''s run by id (run_not_found, not a cross-tenant read)');
  end;
  begin
    -- org1's Groomer C membership id, requested while org2 is active: the resource
    -- lookup is scoped to (organization_id = v_org=org2, membership_id), so it finds
    -- nothing for an org1 membership and fails closed -- org1's actual hired_at/
    -- retention config is never read while impersonating org2.
    perform app.pay_retention_deposit('0f200000-0000-4000-8000-0000000000d4');
    perform pg_temp.ok(false, 'org2''s owner paying org1''s groomer''s retention must be rejected');
  exception when check_violation then
    perform pg_temp.ok(sqlerrm like '%no_hire_date_on_record%', 'org2''s owner cannot pay retention for an org1 membership id (no_hire_date_on_record -- org1''s data never read)');
  end;
  perform pg_temp.act_as('0f200000-0000-4000-8000-0000000000c1', '0f200000-0000-4000-8000-000000000001');
end $$;

rollback;
