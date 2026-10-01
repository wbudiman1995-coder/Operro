-- =====================================================================
-- TEST -- Section 35 (retention/renewal follow-up queues) smoke test.
-- Follows the same convention as integration/package_lifecycle_smoke.sql
-- (pg_temp.ok / pg_temp.act_as, JWT claims via set_config, a smoke_ids temp
-- table for cross-statement id references, one wrapping transaction rolled
-- back at the end so this is safe to run against a real seeded database).
-- Run against a DB with the full migration lineage applied:
--   psql -v ON_ERROR_STOP=1 -f integration/retention_renewal_followups_smoke.sql
--
-- Fixture IDs run as F01..F15 matching the S35 brief's acceptance table.
-- `now()` is fixed for the whole transaction (Postgres semantics), so every
-- day-boundary fixture below is expressed as an offset from "Jakarta
-- midnight today" rather than a hardcoded calendar date -- deterministic
-- regardless of when this script actually runs, with no fake clock needed.
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
create or replace function pg_temp.jkt_midnight() returns timestamptz language sql stable as $$
  select date_trunc('day', now() at time zone 'Asia/Jakarta') at time zone 'Asia/Jakarta'
$$;

begin;

-- --- fixtures: two organizations (cross-org isolation, F11), branches, roles ---
insert into public.organizations (id, name, slug, status) values
  ('04000000-0000-4000-8000-000000000001', 'S35 Org P', 's35-org-p', 'active'),
  ('04000000-0000-4000-8000-000000000002', 'S35 Org Q', 's35-org-q', 'active');
-- Org P is a fresh org created BY THIS TEST, not a pre-migration org, so its
-- followup_retention setting has no explicit value yet and would read the
-- new-org 14-day fallback -- explicitly set 30 here (superuser fixture setup,
-- not the RPC under test) so F01's 29-vs-30-day fixtures exercise the
-- documented "explicit 30" default most real existing orgs actually have.
update public.organizations set settings = settings || '{"followup_retention": {"inactivity_threshold_days": 30}}'::jsonb
 where id = '04000000-0000-4000-8000-000000000001';
insert into public.branches (id, organization_id, name, is_default, status) values
  ('04000000-0000-4000-8000-0000000000a1', '04000000-0000-4000-8000-000000000001', 'Main P', true, 'active'),
  ('04000000-0000-4000-8000-0000000000a2', '04000000-0000-4000-8000-000000000001', 'Second P', false, 'active'),
  ('04000000-0000-4000-8000-0000000000a9', '04000000-0000-4000-8000-000000000002', 'Main Q', true, 'active');

insert into auth.users (id) values
  ('04000000-0000-4000-8000-0000000000c1'), ('04000000-0000-4000-8000-0000000000c3'),
  ('04000000-0000-4000-8000-0000000000c4'), ('04000000-0000-4000-8000-0000000000c5'),
  ('04000000-0000-4000-8000-0000000000c9')
  on conflict (id) do nothing;
insert into public.users (id, full_name, email, status) values
  ('04000000-0000-4000-8000-0000000000c1', 'Owner P', 'owner-p@s35.test', 'active'),
  ('04000000-0000-4000-8000-0000000000c3', 'ReadOnly P', 'readonly-p@s35.test', 'active'),
  ('04000000-0000-4000-8000-0000000000c4', 'BranchRestricted P', 'branch-p@s35.test', 'active'),
  ('04000000-0000-4000-8000-0000000000c5', 'NoAccess P', 'noaccess-p@s35.test', 'active'),
  ('04000000-0000-4000-8000-0000000000c9', 'Owner Q', 'owner-q@s35.test', 'active')
  on conflict (id) do update set full_name = excluded.full_name, email = excluded.email, status = excluded.status;

insert into public.roles (id, organization_id, name, is_system) values
  ('04000000-0000-4000-8000-0000000000e1', '04000000-0000-4000-8000-000000000001', 'Owner', true),
  ('04000000-0000-4000-8000-0000000000e3', '04000000-0000-4000-8000-000000000001', 'ReadOnly', false),
  ('04000000-0000-4000-8000-0000000000e4', '04000000-0000-4000-8000-000000000001', 'BranchRestricted', false),
  ('04000000-0000-4000-8000-0000000000e5', '04000000-0000-4000-8000-000000000001', 'NoAccess', false),
  ('04000000-0000-4000-8000-0000000000e9', '04000000-0000-4000-8000-000000000002', 'Owner', true);
insert into public.memberships (id, organization_id, user_id, role_id, status) values
  ('04000000-0000-4000-8000-0000000000d1', '04000000-0000-4000-8000-000000000001', '04000000-0000-4000-8000-0000000000c1', '04000000-0000-4000-8000-0000000000e1', 'active'),
  ('04000000-0000-4000-8000-0000000000d3', '04000000-0000-4000-8000-000000000001', '04000000-0000-4000-8000-0000000000c3', '04000000-0000-4000-8000-0000000000e3', 'active'),
  ('04000000-0000-4000-8000-0000000000d4', '04000000-0000-4000-8000-000000000001', '04000000-0000-4000-8000-0000000000c4', '04000000-0000-4000-8000-0000000000e4', 'active'),
  ('04000000-0000-4000-8000-0000000000d5', '04000000-0000-4000-8000-000000000001', '04000000-0000-4000-8000-0000000000c5', '04000000-0000-4000-8000-0000000000e5', 'active'),
  ('04000000-0000-4000-8000-0000000000d9', '04000000-0000-4000-8000-000000000002', '04000000-0000-4000-8000-0000000000c9', '04000000-0000-4000-8000-0000000000e9', 'active');

-- Owner P: branches.all (via permission below) so no explicit branch grant needed.
-- BranchRestricted P: explicit grant to Main P only (NOT Second P) -- F11 branch enforcement.
insert into public.membership_branch_access (organization_id, membership_id, branch_id) values
  ('04000000-0000-4000-8000-000000000001', '04000000-0000-4000-8000-0000000000d4', '04000000-0000-4000-8000-0000000000a1');

insert into public.permissions (id, key, resource, action, description) values
  ('04000000-0000-4000-8000-0000000000f1', 'booking.read', 'booking', 'read', 'r'),
  ('04000000-0000-4000-8000-0000000000f2', 'membership.read', 'membership', 'read', 'r'),
  ('04000000-0000-4000-8000-0000000000f3', 'membership.manage', 'membership', 'manage', 'm'),
  ('04000000-0000-4000-8000-0000000000f4', 'invoice.issue', 'invoice', 'issue', 'i'),
  ('04000000-0000-4000-8000-0000000000f5', 'settings.manage', 'settings', 'manage', 's'),
  ('04000000-0000-4000-8000-0000000000f6', 'branches.all', 'branches', 'all', 'a')
  on conflict (key) do nothing;

-- Owner P + Owner Q: full access.
insert into public.role_permissions (organization_id, role_id, permission_id)
  select r.organization_id, r.id, p.id from public.roles r, public.permissions p
  where r.id in ('04000000-0000-4000-8000-0000000000e1', '04000000-0000-4000-8000-0000000000e9')
    and p.key in ('booking.read', 'membership.read', 'membership.manage', 'invoice.issue', 'settings.manage', 'branches.all');
-- ReadOnly P: membership.read + booking.read only -- can view, cannot manage/settings (F11's real read-only role).
insert into public.role_permissions (organization_id, role_id, permission_id)
  select r.organization_id, r.id, p.id from public.roles r, public.permissions p
  where r.id = '04000000-0000-4000-8000-0000000000e3' and p.key in ('booking.read', 'membership.read');
-- BranchRestricted P: same capability set as Owner, minus branches.all (so the explicit single-branch grant above governs).
insert into public.role_permissions (organization_id, role_id, permission_id)
  select r.organization_id, r.id, p.id from public.roles r, public.permissions p
  where r.id = '04000000-0000-4000-8000-0000000000e4' and p.key in ('booking.read', 'membership.read', 'membership.manage', 'invoice.issue', 'settings.manage');
-- NoAccess P: genuinely nothing -- distinct from a groomer-shaped role, proves the "zero permissions" denial path too.

insert into public.organization_modules (organization_id, module_id, enabled)
  select o.id, m.id, true from public.organizations o, public.modules m
  where o.id in ('04000000-0000-4000-8000-000000000001', '04000000-0000-4000-8000-000000000002')
    and m.key in ('crm', 'scheduling', 'membership', 'finance')
  on conflict (organization_id, module_id) do update set enabled = true;
insert into public.subscriptions (organization_id, status) values
  ('04000000-0000-4000-8000-000000000001', 'active'), ('04000000-0000-4000-8000-000000000002', 'active') on conflict do nothing;

-- --- F01/F02/F05/F06: customers, pets, and grooming history ------------
insert into public.customers (id, organization_id, display_name, phone) values
  ('04000000-0000-4000-8000-00000000c101', '04000000-0000-4000-8000-000000000001', 'Cust F01/F02', '081200000001'),
  ('04000000-0000-4000-8000-00000000c105', '04000000-0000-4000-8000-000000000001', 'Cust F05/F06', '081200000005'),
  ('04000000-0000-4000-8000-00000000c114', '04000000-0000-4000-8000-000000000001', 'Cust F14 O''Brien & Co 🐶', '0812xxxx-bad'),
  ('04000000-0000-4000-8000-00000000ca09', '04000000-0000-4000-8000-000000000002', 'Cust Org Q', '081200000009');
insert into public.pets (id, organization_id, customer_id, name) values
  ('04000000-0000-4000-8000-00000000f101', '04000000-0000-4000-8000-000000000001', '04000000-0000-4000-8000-00000000c101', 'PetF01-30d'),
  ('04000000-0000-4000-8000-00000000f102', '04000000-0000-4000-8000-000000000001', '04000000-0000-4000-8000-00000000c101', 'PetF01-29d'),
  ('04000000-0000-4000-8000-00000000f103', '04000000-0000-4000-8000-000000000001', '04000000-0000-4000-8000-00000000c101', 'PetF02-midnight'),
  ('04000000-0000-4000-8000-00000000f105', '04000000-0000-4000-8000-000000000001', '04000000-0000-4000-8000-00000000c105', 'PetOverdue35'),
  ('04000000-0000-4000-8000-00000000f106', '04000000-0000-4000-8000-000000000001', '04000000-0000-4000-8000-00000000c105', 'PetRecent5'),
  ('04000000-0000-4000-8000-00000000f107', '04000000-0000-4000-8000-000000000001', '04000000-0000-4000-8000-00000000c105', 'PetNeverGroomed'),
  ('04000000-0000-4000-8000-00000000f108', '04000000-0000-4000-8000-000000000001', '04000000-0000-4000-8000-00000000c105', 'PetFutureBooked40'),
  ('04000000-0000-4000-8000-00000000f109', '04000000-0000-4000-8000-000000000001', '04000000-0000-4000-8000-00000000c105', 'PetFutureDatedAnomaly'),
  ('04000000-0000-4000-8000-00000000f110', '04000000-0000-4000-8000-000000000001', '04000000-0000-4000-8000-00000000c105', 'PetTwoServicesOneVisit'),
  ('04000000-0000-4000-8000-00000000f111', '04000000-0000-4000-8000-000000000001', '04000000-0000-4000-8000-00000000c105', 'PetSharedBookingComplete'),
  ('04000000-0000-4000-8000-00000000f112', '04000000-0000-4000-8000-000000000001', '04000000-0000-4000-8000-00000000c105', 'PetSharedBookingPending'),
  ('04000000-0000-4000-8000-00000000f113', '04000000-0000-4000-8000-000000000001', '04000000-0000-4000-8000-00000000c105', 'PetCanceledBookingOnly'),
  ('04000000-0000-4000-8000-00000000f120', '04000000-0000-4000-8000-000000000001', '04000000-0000-4000-8000-00000000c114', 'Léo & "Buddy" 🐾');

insert into public.service_catalog (id, organization_id, name, base_price, currency, duration_minutes, is_active) values
  ('04000000-0000-4000-8000-00000000ea01', '04000000-0000-4000-8000-000000000001', 'Grooming', 100000, 'IDR', 60, true);

-- Helper: one completed booking + one grooming_job + one grooming_job_pets row (already
-- 'complete', so the migration's own trigger stamps completed_at = now() at insert time,
-- then we push it back with a raw UPDATE to the exact test offset -- matching how a real
-- completion would have been stamped in the past, not inventing a second code path).
create or replace function pg_temp.fixture_visit(
  p_booking uuid, p_pet uuid, p_branch uuid, p_gjp_status text, p_booking_status text,
  p_completed_at timestamptz, p_starts_at timestamptz
) returns void language plpgsql as $$
begin
  insert into public.bookings (id, organization_id, branch_id, customer_id, booking_type, status, starts_at, ends_at)
    select p_booking, '04000000-0000-4000-8000-000000000001', p_branch, pet.customer_id, 'grooming', p_booking_status,
           p_starts_at, p_starts_at + interval '1 hour'
    from public.pets pet where pet.id = p_pet;
  insert into public.grooming_jobs (organization_id, booking_id) values ('04000000-0000-4000-8000-000000000001', p_booking);
  insert into public.grooming_job_pets (organization_id, grooming_job_id, pet_id, status)
    values ('04000000-0000-4000-8000-000000000001', p_booking, p_pet, p_gjp_status);
  if p_gjp_status = 'complete' and p_completed_at is not null then
    update public.grooming_job_pets set completed_at = p_completed_at
     where organization_id = '04000000-0000-4000-8000-000000000001' and grooming_job_id = p_booking and pet_id = p_pet;
  end if;
end; $$;

-- F01: 30-day pet included, 29-day pet excluded (threshold defaults to 30 for existing orgs).
select pg_temp.fixture_visit('04000000-0000-4000-8000-00000000b001', '04000000-0000-4000-8000-00000000f101',
  '04000000-0000-4000-8000-0000000000a1', 'complete', 'completed', pg_temp.jkt_midnight() - interval '30 days' + interval '2 hours', pg_temp.jkt_midnight() - interval '30 days');
select pg_temp.fixture_visit('04000000-0000-4000-8000-00000000b002', '04000000-0000-4000-8000-00000000f102',
  '04000000-0000-4000-8000-0000000000a1', 'complete', 'completed', pg_temp.jkt_midnight() - interval '29 days' + interval '2 hours', pg_temp.jkt_midnight() - interval '29 days');
-- F02: completed 00:30 Jakarta "yesterday" -- must count as exactly 1 day, not 0 or 2.
select pg_temp.fixture_visit('04000000-0000-4000-8000-00000000b003', '04000000-0000-4000-8000-00000000f103',
  '04000000-0000-4000-8000-0000000000a1', 'complete', 'completed', pg_temp.jkt_midnight() - interval '1 day' + interval '30 minutes', pg_temp.jkt_midnight() - interval '1 day');

-- F05: overdue(35d)/recent(5d)/never-groomed/future-booked, same customer.
select pg_temp.fixture_visit('04000000-0000-4000-8000-00000000b005', '04000000-0000-4000-8000-00000000f105',
  '04000000-0000-4000-8000-0000000000a1', 'complete', 'completed', pg_temp.jkt_midnight() - interval '35 days' + interval '2 hours', pg_temp.jkt_midnight() - interval '35 days');
select pg_temp.fixture_visit('04000000-0000-4000-8000-00000000b006', '04000000-0000-4000-8000-00000000f106',
  '04000000-0000-4000-8000-0000000000a1', 'complete', 'completed', pg_temp.jkt_midnight() - interval '5 days' + interval '2 hours', pg_temp.jkt_midnight() - interval '5 days');
-- PetFutureBooked40: overdue AND has an upcoming (future, non-canceled) booking -- must still show, badged.
select pg_temp.fixture_visit('04000000-0000-4000-8000-00000000b008', '04000000-0000-4000-8000-00000000f108',
  '04000000-0000-4000-8000-0000000000a1', 'complete', 'completed', pg_temp.jkt_midnight() - interval '40 days' + interval '2 hours', pg_temp.jkt_midnight() - interval '40 days');
insert into public.bookings (id, organization_id, branch_id, customer_id, booking_type, status, starts_at, ends_at) values
  ('04000000-0000-4000-8000-00000000b108', '04000000-0000-4000-8000-000000000001', '04000000-0000-4000-8000-0000000000a1',
   '04000000-0000-4000-8000-00000000c105', 'grooming', 'confirmed', now() + interval '3 days', now() + interval '3 days 1 hour');
insert into public.grooming_jobs (organization_id, booking_id) values ('04000000-0000-4000-8000-000000000001', '04000000-0000-4000-8000-00000000b108');
insert into public.grooming_job_pets (organization_id, grooming_job_id, pet_id, status)
  values ('04000000-0000-4000-8000-000000000001', '04000000-0000-4000-8000-00000000b108', '04000000-0000-4000-8000-00000000f108', 'pending');

-- F06a: future-dated legacy anomaly -- must NOT show as a negative-day overdue pet.
select pg_temp.fixture_visit('04000000-0000-4000-8000-00000000b009', '04000000-0000-4000-8000-00000000f109',
  '04000000-0000-4000-8000-0000000000a1', 'complete', 'completed', now() + interval '5 days', now() + interval '5 days');
-- F06b: canceled booking's completed pet must not count as real history.
select pg_temp.fixture_visit('04000000-0000-4000-8000-00000000b013', '04000000-0000-4000-8000-00000000f113',
  '04000000-0000-4000-8000-0000000000a1', 'complete', 'canceled', pg_temp.jkt_midnight() - interval '50 days', pg_temp.jkt_midnight() - interval '50 days');

-- F04: two service lines in one visit -> one visit, no duplicated history (grooming_job_pet_services
-- is per-pet-per-visit, not per-pet-per-day, so this is proven by a pet having only ONE
-- grooming_job_pets row regardless of how many service lines it carries -- add two lines here).
select pg_temp.fixture_visit('04000000-0000-4000-8000-00000000b010', '04000000-0000-4000-8000-00000000f110',
  '04000000-0000-4000-8000-0000000000a1', 'complete', 'completed', pg_temp.jkt_midnight() - interval '31 days' + interval '2 hours', pg_temp.jkt_midnight() - interval '31 days');
insert into public.grooming_job_pet_services (organization_id, grooming_job_pet_id, service_id, service_name_snapshot, unit_price_snapshot, currency)
  select '04000000-0000-4000-8000-000000000001', gjp.id, '04000000-0000-4000-8000-00000000ea01', 'Grooming', 100000, 'IDR'
  from public.grooming_job_pets gjp where gjp.grooming_job_id = '04000000-0000-4000-8000-00000000b010' and gjp.pet_id = '04000000-0000-4000-8000-00000000f110';
insert into public.grooming_job_pet_services (organization_id, grooming_job_pet_id, service_id, service_name_snapshot, unit_price_snapshot, currency)
  select '04000000-0000-4000-8000-000000000001', gjp.id, '04000000-0000-4000-8000-00000000ea01', 'Grooming (add-on)', 50000, 'IDR'
  from public.grooming_job_pets gjp where gjp.grooming_job_id = '04000000-0000-4000-8000-00000000b010' and gjp.pet_id = '04000000-0000-4000-8000-00000000f110';

-- F03: two pets share ONE booking; only one is individually 'complete' -- the completed
-- pet must gain history even though the booking overall is still 'in_progress'.
insert into public.bookings (id, organization_id, branch_id, customer_id, booking_type, status, starts_at, ends_at) values
  ('04000000-0000-4000-8000-00000000b011', '04000000-0000-4000-8000-000000000001', '04000000-0000-4000-8000-0000000000a1',
   '04000000-0000-4000-8000-00000000c105', 'grooming', 'in_progress', pg_temp.jkt_midnight() - interval '32 days', pg_temp.jkt_midnight() - interval '32 days' + interval '2 hours');
insert into public.grooming_jobs (organization_id, booking_id) values ('04000000-0000-4000-8000-000000000001', '04000000-0000-4000-8000-00000000b011');
insert into public.grooming_job_pets (organization_id, grooming_job_id, pet_id, status, completed_at) values
  ('04000000-0000-4000-8000-000000000001', '04000000-0000-4000-8000-00000000b011', '04000000-0000-4000-8000-00000000f111', 'complete', pg_temp.jkt_midnight() - interval '32 days' + interval '1 hour'),
  ('04000000-0000-4000-8000-000000000001', '04000000-0000-4000-8000-00000000b011', '04000000-0000-4000-8000-00000000f112', 'pending', null);
-- The migration's own trg_gjp_stamp_completed_at trigger overwrites completed_at to
-- now() on any INSERT with status='complete' (matching real completion behavior) --
-- push the intended backdated value in with a follow-up UPDATE, exactly like
-- pg_temp.fixture_visit() does for every other fixture in this file.
update public.grooming_job_pets set completed_at = pg_temp.jkt_midnight() - interval '32 days' + interval '1 hour'
 where organization_id = '04000000-0000-4000-8000-000000000001' and grooming_job_id = '04000000-0000-4000-8000-00000000b011' and pet_id = '04000000-0000-4000-8000-00000000f111';

-- F14: names with &, apostrophe, emoji; malformed phone (RPC must pass these through
-- byte-for-byte -- no HTML entity mangling at the SQL layer, that is the UI's job).
select pg_temp.fixture_visit('04000000-0000-4000-8000-00000000b014', '04000000-0000-4000-8000-00000000f120',
  '04000000-0000-4000-8000-0000000000a1', 'complete', 'completed', pg_temp.jkt_midnight() - interval '33 days' + interval '2 hours', pg_temp.jkt_midnight() - interval '33 days');

-- --- F13: >1000 relevant records (a single very-overdue customer with 1100 pets) ------
insert into public.customers (id, organization_id, display_name) values
  ('04000000-0000-4000-8000-00000000c113', '04000000-0000-4000-8000-000000000001', 'Cust F13 Bulk');
do $$
declare i integer; v_pet uuid; v_booking uuid;
begin
  for i in 1..1100 loop
    v_pet := gen_random_uuid(); v_booking := gen_random_uuid();
    insert into public.pets (id, organization_id, customer_id, name)
      values (v_pet, '04000000-0000-4000-8000-000000000001', '04000000-0000-4000-8000-00000000c113', 'BulkPet' || i);
    perform pg_temp.fixture_visit(v_booking, v_pet, '04000000-0000-4000-8000-0000000000a1', 'complete', 'completed',
      pg_temp.jkt_midnight() - interval '45 days', pg_temp.jkt_midnight() - interval '45 days');
  end loop;
end $$;
-- Also 1100 DISTINCT overdue customers (one pet each) so total_groups pagination is exercised
-- past a single PostgREST-style 1000-row cap, not just a single customer's pet array.
insert into public.customers (id, organization_id, display_name)
  select gen_random_uuid(), '04000000-0000-4000-8000-000000000001', 'F13Cust' || i
  from generate_series(1, 1100) i;
do $$
declare c record; v_pet uuid; v_booking uuid;
begin
  for c in select id from public.customers where organization_id = '04000000-0000-4000-8000-000000000001' and display_name like 'F13Cust%' loop
    v_pet := gen_random_uuid(); v_booking := gen_random_uuid();
    insert into public.pets (id, organization_id, customer_id, name) values (v_pet, '04000000-0000-4000-8000-000000000001', c.id, 'F13Pet');
    perform pg_temp.fixture_visit(v_booking, v_pet, '04000000-0000-4000-8000-0000000000a1', 'complete', 'completed',
      pg_temp.jkt_midnight() - interval '45 days', pg_temp.jkt_midnight() - interval '45 days');
  end loop;
end $$;

-- The F13 bulk loops above just inserted ~2200 rows each into pets/bookings/
-- grooming_job_pets within THIS transaction; autovacuum/autoanalyze never runs on
-- uncommitted data, so the planner is still using pre-bulk-insert statistics and
-- picks a nested-loop plan across what it (wrongly) still thinks are tiny tables --
-- this made app.list_overdue_customers(null, null, ...) (the F13 unfiltered-search
-- assertion) take 11+ minutes before this fix. An explicit mid-transaction ANALYZE
-- is real, supported Postgres behavior (unlike autovacuum, it runs synchronously
-- and is visible to later statements in the SAME transaction) and reflects what a
-- real deployment's autovacuum would already have done for data that accumulated
-- normally instead of arriving in one test-fixture burst.
analyze public.pets;
analyze public.bookings;
analyze public.grooming_job_pets;
analyze public.grooming_job_pet_services;
analyze public.customers;

-- (Deliberately NOT committing here, unlike an earlier draft of this file: a mid-script
-- commit left fixture rows permanently in the shared gate database whenever a LATER
-- assertion failed, breaking every subsequent re-run with duplicate-key errors. Staying in
-- one transaction, rolled back at the very end -- same convention as package_lifecycle_smoke.sql
-- -- makes this file safely re-runnable no matter where it fails.)

-- --- F07/F08/F09 fixtures (packages/customer_packages/ledger/reservations) --
-- Inserted here, still as superuser, like every other fixture above --
-- `customer_package_ledger.id` defaults via app.fn_uuid_v7(), which calls
-- pgcrypto's gen_random_bytes(); the `authenticated` role (switched to
-- immediately below) is not granted EXECUTE on it in this gate database, so
-- this must happen before the role switch, not after.
insert into public.packages (id, organization_id, name, service_id, total_sessions, price, currency, validity_days, rollover_policy, recurrence_interval, is_active) values
  ('04000000-0000-4000-8000-00000000da07', '04000000-0000-4000-8000-000000000001', 'F07 Package', null, 4, 400000, 'IDR', 90, 'none', 'month', true),
  ('04000000-0000-4000-8000-00000000da08', '04000000-0000-4000-8000-000000000001', 'F08 Recurring NullExpiry', null, 4, 100000, 'IDR', null, 'none', 'week', true),
  ('04000000-0000-4000-8000-00000000da09', '04000000-0000-4000-8000-000000000001', 'F08 Token', null, 1, 50000, 'IDR', 365, 'none', 'none', true);

insert into public.customer_packages (id, organization_id, customer_id, package_id, sessions_remaining, purchased_at, expires_at, status) values
  -- sessions_remaining starts at 0 here, not the intended net 2: the ledger inserts just
  -- below (+4 purchase, -2 consumption) drive it via trg_cpl_apply, the same "derived
  -- cache" invariant the real system relies on -- setting an explicit non-zero value here
  -- AND applying ledger deltas on top double-counted (a real bug this test caught: it
  -- first reported available=2 instead of 0).
  ('04000000-0000-4000-8000-00000000db07', '04000000-0000-4000-8000-000000000001', '04000000-0000-4000-8000-00000000c105', '04000000-0000-4000-8000-00000000da07', 0, now() - interval '10 days', now() + interval '80 days', 'active'),
  ('04000000-0000-4000-8000-00000000db08', '04000000-0000-4000-8000-000000000001', '04000000-0000-4000-8000-00000000c105', '04000000-0000-4000-8000-00000000da08', 4, now() - interval '5 days', null, 'active'),
  ('04000000-0000-4000-8000-00000000db0e', '04000000-0000-4000-8000-000000000001', '04000000-0000-4000-8000-00000000c105', '04000000-0000-4000-8000-00000000da07', 4, now() - interval '400 days', now() - interval '10 days', 'active'),
  ('04000000-0000-4000-8000-00000000db0a', '04000000-0000-4000-8000-000000000001', '04000000-0000-4000-8000-00000000c105', '04000000-0000-4000-8000-00000000da07', 0, now() - interval '400 days', now() - interval '300 days', 'canceled'),
  ('04000000-0000-4000-8000-00000000db09', '04000000-0000-4000-8000-000000000001', '04000000-0000-4000-8000-00000000c105', '04000000-0000-4000-8000-00000000da09', 1, now() - interval '2 days', now() + interval '363 days', 'active');
insert into public.customer_package_ledger (organization_id, customer_package_id, delta, reason) values
  ('04000000-0000-4000-8000-000000000001', '04000000-0000-4000-8000-00000000db07', 4, 'purchase'),
  ('04000000-0000-4000-8000-000000000001', '04000000-0000-4000-8000-00000000db07', -2, 'consumption');
-- F07: consumed=2, held=2 (both reserved), total sessions_remaining=2 -> available MUST be 0, never "4 consumed".
insert into public.package_reservations (organization_id, customer_package_id, grooming_job_pet_service_id, status)
  select '04000000-0000-4000-8000-000000000001', '04000000-0000-4000-8000-00000000db07', gjps.id, 'reserved'
  from public.grooming_job_pet_services gjps
  join public.grooming_job_pets gjp on gjp.id = gjps.grooming_job_pet_id
  where gjp.grooming_job_id = '04000000-0000-4000-8000-00000000b010' limit 1;
insert into public.package_reservations (organization_id, customer_package_id, grooming_job_pet_service_id, status)
  select '04000000-0000-4000-8000-000000000001', '04000000-0000-4000-8000-00000000db07', gjps2.id, 'reserved'
  from public.grooming_job_pet_services gjps2
  join public.grooming_job_pets gjp2 on gjp2.id = gjps2.grooming_job_pet_id
  where gjp2.grooming_job_id = '04000000-0000-4000-8000-00000000b010'
  offset 1 limit 1;

-- =====================================================================
-- Assertions run AS THE ACTUAL AUTHENTICATED ROLE, never a superuser bypass.
-- =====================================================================
set local role authenticated;

-- --- F01/F02: threshold boundary + Jakarta midnight precision (Owner P) ---
do $$ begin perform pg_temp.act_as('04000000-0000-4000-8000-0000000000c1', '04000000-0000-4000-8000-000000000001'); end $$;
do $$
declare v_result jsonb; v_names text[];
begin
  v_result := app.list_overdue_customers(null, 'Cust F01/F02', 'default', 1, 25);
  select array_agg(p ->> 'pet_name') into v_names
    from jsonb_array_elements(v_result -> 'groups' -> 0 -> 'pets') p;
  perform pg_temp.ok(v_names @> array['PetF01-30d'], 'F01 30-day pet included');
  perform pg_temp.ok(not (v_names @> array['PetF01-29d']), 'F01 29-day pet excluded');
end $$;

do $$
declare v_updated_at timestamptz; v_result jsonb; v_days integer;
begin
  -- Lower the threshold to 1 just long enough to inspect the exact day count for the
  -- F02 midnight-precision pet, then restore it -- proves the boundary math, not just
  -- that the pet clears an arbitrary 30-day bar.
  select updated_at into v_updated_at from public.organizations where id = '04000000-0000-4000-8000-000000000001';
  perform app.update_followup_retention_settings(v_updated_at, 1, 'Hai Kak {nama}, {days} hari, {dogs}, {biz}', 'Hai {nama} {tier} {amount} {biz}');
  v_result := app.list_overdue_customers(null, 'Cust F01/F02', 'default', 1, 25);
  select (p ->> 'days_since')::integer into v_days
    from jsonb_array_elements(v_result -> 'groups' -> 0 -> 'pets') p where p ->> 'pet_name' = 'PetF02-midnight';
  perform pg_temp.ok(v_days = 1, format('F02 00:30 Jakarta completion counts as exactly 1 day, got %s', v_days));
  select updated_at into v_updated_at from public.organizations where id = '04000000-0000-4000-8000-000000000001';
  perform app.update_followup_retention_settings(v_updated_at, 30, 'Hai Kak {nama}, sudah {days} hari sejak grooming terakhir untuk {dogs}. Apakah ingin menjadwalkan grooming berikutnya bersama {biz}?', 'Hai Kak {nama}, berikut estimasi perpanjangan paket {tier} untuk {dogs}: {amount}. Silakan konfirmasi kepada {biz} untuk melanjutkan.');
end $$;

-- --- F03: sibling pet on an unfinished booking must not hide the completed one ---
do $$
declare v_result jsonb; v_found boolean;
begin
  v_result := app.list_overdue_customers(null, 'PetSharedBooking', 'default', 1, 25);
  select exists (
    select 1 from jsonb_array_elements(v_result -> 'groups') g, jsonb_array_elements(g -> 'pets') p
    where p ->> 'pet_name' = 'PetSharedBookingComplete'
  ) into v_found;
  perform pg_temp.ok(v_found, 'F03 completed pet visible although sibling pet on the same booking is still pending');
  select exists (
    select 1 from jsonb_array_elements(v_result -> 'groups') g, jsonb_array_elements(g -> 'pets') p
    where p ->> 'pet_name' = 'PetSharedBookingPending'
  ) into v_found;
  perform pg_temp.ok(not v_found, 'F03 the still-pending sibling pet does not falsely appear as overdue history');
end $$;

-- --- F04: two service lines on one visit -> one visit, no duplicate reminder line ---
do $$
declare v_result jsonb; v_count integer;
begin
  v_result := app.list_overdue_customers(null, 'PetTwoServicesOneVisit', 'default', 1, 25);
  select count(*) into v_count
    from jsonb_array_elements(v_result -> 'groups') g, jsonb_array_elements(g -> 'pets') p
    where p ->> 'pet_name' = 'PetTwoServicesOneVisit';
  perform pg_temp.ok(v_count = 1, format('F04 one visit with two service lines yields exactly one pet entry, got %s', v_count));
end $$;

-- --- F05: overdue/recent/never-groomed/future-booked, one customer, correct per-pet result ---
do $$
declare v_default jsonb; v_never jsonb; v_names text[]; v_upcoming boolean;
begin
  v_default := app.list_overdue_customers(null, 'Cust F05/F06', 'default', 1, 25);
  select array_agg(p ->> 'pet_name') into v_names from jsonb_array_elements(v_default -> 'groups' -> 0 -> 'pets') p;
  perform pg_temp.ok(v_names @> array['PetOverdue35'], 'F05 overdue pet shown under default filter');
  perform pg_temp.ok(not (v_names @> array['PetRecent5']), 'F05 recently-groomed pet NOT shown under default filter');
  perform pg_temp.ok(not (v_names @> array['PetNeverGroomed']), 'F05 never-groomed pet NOT shown under default filter (separate filter exists for it)');
  perform pg_temp.ok(v_names @> array['PetFutureBooked40'], 'F05 overdue pet WITH an upcoming booking still shown (not hidden)');
  select (p ->> 'has_upcoming_booking')::boolean into v_upcoming
    from jsonb_array_elements(v_default -> 'groups' -> 0 -> 'pets') p where p ->> 'pet_name' = 'PetFutureBooked40';
  perform pg_temp.ok(v_upcoming, 'F05 PetFutureBooked40 is badged has_upcoming_booking=true');

  v_never := app.list_overdue_customers(null, 'Cust F05/F06', 'never_groomed', 1, 25);
  select array_agg(p ->> 'pet_name') into v_names from jsonb_array_elements(v_never -> 'groups' -> 0 -> 'pets') p;
  perform pg_temp.ok(v_names @> array['PetNeverGroomed'], 'F05 never_groomed filter surfaces the never-groomed pet');
  perform pg_temp.ok(not (v_names @> array['PetOverdue35']), 'F05 never_groomed filter excludes a pet that DOES have history');
end $$;

-- --- F06: deleted/canceled/future-dated history handled explicitly, never invented ---
do $$
declare v_result jsonb; v_found boolean; v_anomaly boolean;
begin
  v_result := app.list_overdue_customers(null, 'Cust F05/F06', 'never_groomed', 1, 25);
  select bool_or((p ->> 'anomaly_future_dated')::boolean) into v_anomaly
    from jsonb_array_elements(v_result -> 'groups' -> 0 -> 'pets') p where p ->> 'pet_name' = 'PetFutureDatedAnomaly';
  perform pg_temp.ok(coalesce(v_anomaly, false), 'F06 future-dated legacy record flagged as an anomaly, not a negative day count');

  v_result := app.list_overdue_customers(null, 'PetCanceledBookingOnly', 'default', 1, 25);
  select exists (select 1 from jsonb_array_elements(v_result -> 'groups') g, jsonb_array_elements(g -> 'pets') p where p ->> 'pet_name' = 'PetCanceledBookingOnly') into v_found;
  perform pg_temp.ok(not v_found, 'F06 a completed pet on a since-canceled booking does not count as real history');
end $$;

-- --- F14: special characters + malformed phone pass through unmangled ---
do $$
declare v_result jsonb; v_name text; v_phone text;
begin
  v_result := app.list_overdue_customers(null, 'F14', 'default', 1, 25);
  select g ->> 'customer_name', g ->> 'phone' into v_name, v_phone from jsonb_array_elements(v_result -> 'groups') g limit 1;
  perform pg_temp.ok(v_name = 'Cust F14 O''Brien & Co 🐶', format('F14 customer name preserved verbatim, got %s', v_name));
  perform pg_temp.ok(v_phone = '0812xxxx-bad', 'F14 malformed phone preserved verbatim (client decides validity, not the RPC)');
end $$;

-- --- F13: >1000 relevant records -- correct totals, no fixed-limit truncation ---
do $$
declare v_result jsonb; v_total integer; v_page1 integer; v_page45 integer;
begin
  v_result := app.list_overdue_customers(null, null, 'default', 1, 100);
  v_total := (v_result ->> 'total_groups')::integer;
  perform pg_temp.ok(v_total >= 1101, format('F13 total_groups counts past 1000 (>=1101 expected), got %s', v_total));
  select jsonb_array_length(v_result -> 'groups') into v_page1;
  perform pg_temp.ok(v_page1 = 100, format('F13 page 1 returns exactly page_size=100 groups, got %s', v_page1));
  v_result := app.list_overdue_customers(null, null, 'default', ((v_total / 100) + 1), 100);
  select jsonb_array_length(v_result -> 'groups') into v_page45;
  perform pg_temp.ok(v_page45 > 0, 'F13 the final page is still reachable, not silently dropped');
  -- The single 1100-pet customer must be truncated-with-a-count, never silently dropped.
  perform pg_temp.ok(exists (
    select 1 from jsonb_array_elements((app.list_overdue_customers(null, 'Cust F13 Bulk', 'default', 1, 25) -> 'groups')) g
    where (g ->> 'pets_truncated_count')::integer > 0
  ), 'F13 an exceptionally large single-customer group reports a truncated count rather than truncating silently');
end $$;

-- =====================================================================
-- Renewal queue: F07/F08/F09 (fixtures inserted earlier, above the role switch)
-- =====================================================================
do $$
declare v_result jsonb; v_m jsonb;
begin
  v_result := app.list_renewal_queue('all', 'F07', false, 1, 25);
  select m into v_m from jsonb_array_elements(v_result -> 'groups' -> 0 -> 'memberships') m where m ->> 'id' = '04000000-0000-4000-8000-00000000db07';
  perform pg_temp.ok((v_m ->> 'available_count')::integer = 0, format('F07 available=0 when all remaining sessions are held, got %s', v_m ->> 'available_count'));
  perform pg_temp.ok((v_m ->> 'reserved_count')::integer = 2, format('F07 held=2, got %s', v_m ->> 'reserved_count'));
  perform pg_temp.ok((v_m ->> 'consumed_count')::integer = 2, format('F07 consumed=2 from the ledger, not inferred as total-available, got %s', v_m ->> 'consumed_count'));
  perform pg_temp.ok((v_m ->> 'all_reserved')::boolean, 'F07 all_reserved=true (distinct from no_available_sessions)');
  perform pg_temp.ok(not (v_m ->> 'no_available_sessions')::boolean, 'F07 no_available_sessions=false -- these sessions are held, not exhausted');
end $$;

-- --- F08: recurring/null-expiry, expired, archived, one-off token distinguished ---
do $$
declare v_actionable jsonb; v_historical jsonb; v_all jsonb; v_m jsonb; v_ids text[];
begin
  -- search=null: db0e/db0a intentionally reuse the F07 package (da07) to test lifecycle
  -- status independent of the catalog item, so a package-name search for 'F08' would miss
  -- them. All five F07/F08/F09 fixture memberships belong to the one customer (c105) with
  -- any customer_packages row in this org, so an unfiltered query still scopes correctly.
  v_actionable := app.list_renewal_queue('actionable', null, false, 1, 25);
  select array_agg(m ->> 'id') into v_ids from jsonb_array_elements(v_actionable -> 'groups' -> 0 -> 'memberships') m;
  perform pg_temp.ok(v_ids @> array['04000000-0000-4000-8000-00000000db08'], 'F08 null-expiry recurring membership shown as actionable');
  perform pg_temp.ok(v_ids @> array['04000000-0000-4000-8000-00000000db0e'], 'F08 expired-but-not-archived membership still shown as actionable');
  perform pg_temp.ok(not (v_ids @> array['04000000-0000-4000-8000-00000000db0a']), 'F08 archived (canceled) membership NOT shown under actionable');
  perform pg_temp.ok(not (v_ids @> array['04000000-0000-4000-8000-00000000db09']), 'F08 one-off token NOT shown under actionable by default (include_tokens=false)');

  select m into v_m from jsonb_array_elements(v_actionable -> 'groups' -> 0 -> 'memberships') m where m ->> 'id' = '04000000-0000-4000-8000-00000000db08';
  perform pg_temp.ok(v_m ->> 'expires_at' is null, 'F08 null expires_at means no expiry, never rendered as expired');
  perform pg_temp.ok(not (v_m ->> 'is_expired')::boolean, 'F08 null-expiry membership is_expired=false');

  select m into v_m from jsonb_array_elements(v_actionable -> 'groups' -> 0 -> 'memberships') m where m ->> 'id' = '04000000-0000-4000-8000-00000000db0e';
  perform pg_temp.ok((v_m ->> 'is_expired')::boolean, 'F08 an expired membership is flagged is_expired=true');

  v_historical := app.list_renewal_queue('historical', null, false, 1, 25);
  select array_agg(m ->> 'id') into v_ids from jsonb_array_elements(v_historical -> 'groups' -> 0 -> 'memberships') m;
  perform pg_temp.ok(v_ids @> array['04000000-0000-4000-8000-00000000db0a'], 'F08 historical view shows the archived membership');
  perform pg_temp.ok(not (v_ids @> array['04000000-0000-4000-8000-00000000db0e']), 'F08 historical view excludes a still-active (not archived) expired membership');

  v_all := app.list_renewal_queue('all', null, true, 1, 25);
  select array_agg(m ->> 'id') into v_ids from jsonb_array_elements(v_all -> 'groups' -> 0 -> 'memberships') m;
  select m into v_m from jsonb_array_elements(v_all -> 'groups' -> 0 -> 'memberships') m where m ->> 'id' = '04000000-0000-4000-8000-00000000db09';
  perform pg_temp.ok(v_ids @> array['04000000-0000-4000-8000-00000000db09'], 'F08 with include_tokens=true the one-off token becomes visible');
  perform pg_temp.ok(not (v_m ->> 'is_recurring')::boolean, 'F08 the token is explicitly labeled is_recurring=false, never presented as a subscription');
end $$;

-- =====================================================================
-- F09 is primarily a client-side (renewal-queue.tsx) guarantee -- see
-- apps/web/test/followup-retention-contract.test.ts for the assertion that
-- a blocked/errored preview blocks the combined total rather than being
-- silently summed. What IS SQL-provable here: a canceled/incompatible
-- membership's own preview really is blocked (reused, unmodified RPC).
-- =====================================================================
do $$
declare v_preview jsonb;
begin
  v_preview := app.preview_package_renewal('04000000-0000-4000-8000-00000000db0a');
  perform pg_temp.ok((v_preview ->> 'blocking_reason') = 'package_canceled_cannot_renew',
    'F09 a canceled membership''s own preview reports a real blocking_reason for the UI to surface, not a fabricated amount');
end $$;

-- =====================================================================
-- F11: authorization -- read-only role, branch-restricted role, zero-permission
-- role, cross-org isolation, and direct RPC calls (never only "hidden UI buttons").
-- =====================================================================
-- ReadOnly P: can view both queues, cannot write settings.
do $$ begin perform pg_temp.act_as('04000000-0000-4000-8000-0000000000c3', '04000000-0000-4000-8000-000000000001'); end $$;
do $$
declare v_result jsonb;
begin
  v_result := app.list_overdue_customers(null, 'Cust F01/F02', 'default', 1, 25);
  perform pg_temp.ok(jsonb_array_length(v_result -> 'groups') >= 0, 'F11 ReadOnly can call list_overdue_customers (membership.read-shaped module/perm gate satisfied via booking.read+crm)');
  v_result := app.list_renewal_queue('all', 'F07', false, 1, 25);
  perform pg_temp.ok(jsonb_array_length(v_result -> 'groups') >= 0, 'F11 ReadOnly can call list_renewal_queue (holds membership.read)');
end $$;
do $$
declare v_updated_at timestamptz;
begin
  select updated_at into v_updated_at from public.organizations where id = '04000000-0000-4000-8000-000000000001';
  perform app.update_followup_retention_settings(v_updated_at, 30, 'x {nama}', 'x {nama}');
  raise exception 'F11 FAIL: ReadOnly unexpectedly allowed to write settings';
exception when insufficient_privilege then
  perform pg_temp.ok(true, 'F11 ReadOnly (membership.read, no settings.manage) denied settings write directly at the RPC');
end $$;

-- BranchRestricted P: sees only Main P's history, not Second P's, and cannot pass p_branch
-- for a branch it does not hold.
do $$ begin perform pg_temp.act_as('04000000-0000-4000-8000-0000000000c4', '04000000-0000-4000-8000-000000000001'); end $$;
do $$
begin
  perform app.list_overdue_customers('04000000-0000-4000-8000-0000000000a2', null, 'default', 1, 25);
  raise exception 'F11 FAIL: BranchRestricted unexpectedly allowed to query an inaccessible branch';
exception when insufficient_privilege then
  perform pg_temp.ok(true, 'F11 BranchRestricted denied direct p_branch access to Second P (branch it does not hold)');
end $$;
do $$
declare v_result jsonb; v_found boolean;
begin
  -- A visit recorded at the ACCESSIBLE branch (Main P) must still be visible with no p_branch filter.
  v_result := app.list_overdue_customers(null, 'Cust F01/F02', 'default', 1, 25);
  select exists (select 1 from jsonb_array_elements(v_result -> 'groups') g where g ->> 'customer_name' = 'Cust F01/F02') into v_found;
  perform pg_temp.ok(v_found, 'F11 BranchRestricted still sees history recorded at its own accessible branch');
end $$;

-- NoAccess P: zero permissions -- denied both queues and the settings write, at the RPC.
do $$ begin perform pg_temp.act_as('04000000-0000-4000-8000-0000000000c5', '04000000-0000-4000-8000-000000000001'); end $$;
do $$ begin
  perform app.list_overdue_customers(null, null, 'default', 1, 25);
  raise exception 'F11 FAIL: NoAccess unexpectedly allowed to view the overdue queue';
exception when insufficient_privilege then
  perform pg_temp.ok(true, 'F11 NoAccess (zero permissions) denied list_overdue_customers');
end $$;
do $$ begin
  perform app.list_renewal_queue('all', null, false, 1, 25);
  raise exception 'F11 FAIL: NoAccess unexpectedly allowed to view the renewal queue';
exception when insufficient_privilege then
  perform pg_temp.ok(true, 'F11 NoAccess denied list_renewal_queue');
end $$;

-- Cross-org: Owner Q must see zero rows from Org P and cannot read Org P's settings.
do $$ begin perform pg_temp.act_as('04000000-0000-4000-8000-0000000000c9', '04000000-0000-4000-8000-000000000002'); end $$;
do $$
declare v_result jsonb;
begin
  v_result := app.list_overdue_customers(null, 'Cust F01', 'default', 1, 25);
  perform pg_temp.ok((v_result ->> 'total_groups')::integer = 0, 'F11 cross-org: Org Q sees zero of Org P''s overdue customers');
  v_result := app.list_renewal_queue('all', 'F07', false, 1, 25);
  perform pg_temp.ok((v_result ->> 'total_groups')::integer = 0, 'F11 cross-org: Org Q sees zero of Org P''s memberships');
end $$;

-- Anonymous / revoked: no active membership at all cannot call these RPCs either.
do $$ begin perform set_config('request.jwt.claims', json_build_object('sub', '04000000-0000-4000-8000-0000000000c9', 'active_org_id', '04000000-0000-4000-8000-000000000001')::text, true); end $$;
do $$ begin
  perform app.list_overdue_customers(null, null, 'default', 1, 25);
  raise exception 'F11 FAIL: a user with no membership in the target org was unexpectedly allowed in';
exception when insufficient_privilege then
  perform pg_temp.ok(true, 'F11 a real user authenticated for a DIFFERENT org (no membership in Org P) is denied Org P''s queue, not just hidden by the UI');
end $$;

-- =====================================================================
-- F12: two concurrent settings editors -- no silent overwrite, unrelated
-- settings untouched.
-- =====================================================================
do $$ begin perform pg_temp.act_as('04000000-0000-4000-8000-0000000000c1', '04000000-0000-4000-8000-000000000001'); end $$;
-- Platform access hardening revokes direct organization writes from authenticated.
-- This is fixture setup for an unrelated-key preservation assertion, so seed it
-- as the database owner and immediately return to the authenticated test role.
reset role;
update public.organizations set settings = settings || '{"branding": {"logo_url": "https://example.test/logo.png"}}'::jsonb
 where id = '04000000-0000-4000-8000-000000000001';
set local role authenticated;
do $$
declare v_stale_updated_at timestamptz; v_result jsonb; v_branding jsonb;
begin
  select updated_at into v_stale_updated_at from public.organizations where id = '04000000-0000-4000-8000-000000000001';
  -- The existing app.tg_set_updated_at trigger stamps updated_at from now(), which Postgres
  -- freezes for an entire transaction -- a real second writer's stale copy differs from the
  -- CURRENT row because real concurrent edits are separate transactions, each with its own
  -- now(). That real elapsed-time difference cannot be reproduced inside this single-transaction
  -- test script (an UPDATE here would get the same frozen now() no matter what). What IS
  -- provable here, and is the guard's actual contract: a caller presenting ANY updated_at that
  -- does not match the current row is rejected (Editor B, holding a copy from before Editor A's
  -- edit), while the caller presenting the true current value succeeds (Editor A). "Editor B
  -- first" order below only exercises the rejection path before consuming the correct token.
  begin
    perform app.update_followup_retention_settings(v_stale_updated_at - interval '1 second', 45, 'B {nama} {days} {dogs} {biz}', 'B {nama} {tier} {amount} {biz}');
    raise exception 'F12 FAIL: a settings write presenting a non-matching updated_at was unexpectedly accepted';
  exception when sqlstate '40001' then
    perform pg_temp.ok(true, 'F12 a settings write presenting a non-matching (stale) updated_at is rejected (40001), not silently overwritten');
  end;
  -- Editor A, holding the actually-current value, succeeds.
  perform app.update_followup_retention_settings(v_stale_updated_at, 21, 'A {nama} {days} {dogs} {biz}', 'A {nama} {tier} {amount} {biz}');
  v_result := app.get_followup_retention_settings();
  perform pg_temp.ok((v_result ->> 'inactivity_threshold_days')::integer = 21, 'F12 the successful editor''s value (21) is what persisted, not the rejected one (45)');
  select settings -> 'branding' into v_branding from public.organizations where id = '04000000-0000-4000-8000-000000000001';
  perform pg_temp.ok(v_branding = '{"logo_url": "https://example.test/logo.png"}'::jsonb, 'F12 an unrelated settings key (branding) is untouched by the followup_retention merge');
  -- Restore the default templates for tidiness (harmless -- this whole script rolls back).
  select updated_at into v_stale_updated_at from public.organizations where id = '04000000-0000-4000-8000-000000000001';
  perform app.update_followup_retention_settings(v_stale_updated_at, 30, 'Hai Kak {nama}, sudah {days} hari sejak grooming terakhir untuk {dogs}. Apakah ingin menjadwalkan grooming berikutnya bersama {biz}?', 'Hai Kak {nama}, berikut estimasi perpanjangan paket {tier} untuk {dogs}: {amount}. Silakan konfirmasi kepada {biz} untuk melanjutkan.');
end $$;

-- Template validation: unknown placeholder rejected with a useful message; invalid
-- threshold (0, negative, >365) rejected.
do $$
declare v_updated_at timestamptz;
begin
  select updated_at into v_updated_at from public.organizations where id = '04000000-0000-4000-8000-000000000001';
  begin
    perform app.update_followup_retention_settings(v_updated_at, 30, 'Hai {nama} {totally_unknown_token}', 'x {nama}');
    raise exception 'F12 FAIL: unknown placeholder unexpectedly accepted';
  exception when sqlstate '22023' then
    perform pg_temp.ok(sqlerrm like 'unknown_placeholder:%', format('unknown placeholder rejected with a useful message, got: %s', sqlerrm));
  end;
  begin
    perform app.update_followup_retention_settings(v_updated_at, 0, 'x {nama}', 'x {nama}');
    raise exception 'F12 FAIL: threshold=0 unexpectedly accepted';
  exception when sqlstate '22023' then perform pg_temp.ok(true, 'threshold=0 rejected');
  end;
  begin
    perform app.update_followup_retention_settings(v_updated_at, 366, 'x {nama}', 'x {nama}');
    raise exception 'F12 FAIL: threshold=366 unexpectedly accepted';
  exception when sqlstate '22023' then perform pg_temp.ok(true, 'threshold=366 rejected'); end;
  begin
    perform app.update_followup_retention_settings(v_updated_at, null, 'x {nama}', 'x {nama}');
    raise exception 'F12 FAIL: null threshold unexpectedly accepted';
  exception when sqlstate '22023' then perform pg_temp.ok(true, 'null threshold rejected'); end;
end $$;

reset role;

rollback;
-- END retention_renewal_followups_smoke
