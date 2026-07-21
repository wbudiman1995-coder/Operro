-- =====================================================================
-- POSITIVE backfill assertions — run AFTER 0013 has migrated the legacy rows.
-- =====================================================================
-- Proves SECTION 300 preserved every legacy value into the new model and
-- SECTION 320 dropped the old columns. Any failed assertion raises and psql
-- (ON_ERROR_STOP=1) exits nonzero.
-- =====================================================================
\set ON_ERROR_STOP on

create or replace function pg_temp.assert_that(cond boolean, label text)
returns void language plpgsql as $$
begin
  if cond then raise notice 'PASS: %', label;
  else raise exception 'FAIL: %', label; end if;
end; $$;

-- The legacy columns must be GONE (core neutrality achieved).
select pg_temp.assert_that(
  not exists (select 1 from information_schema.columns
              where table_schema='public' and table_name='bookings'
                and column_name in ('pet_id','service_id')),
  'BF1 bookings.pet_id/service_id dropped after backfill');

-- Booking #1: one grooming_job_pet (status carried from completed booking).
select pg_temp.assert_that(
  (select status from public.grooming_job_pets
   where organization_id='8f000000-0000-4000-8000-000000000001'
     and grooming_job_id='8f000000-0000-4000-8000-0000000b0001'
     and pet_id='8f000000-0000-4000-8000-00000000f001') = 'complete',
  'BF2 completed booking -> grooming_job_pet.status=complete');

-- Booking #1: exactly one service line carrying the snapshots.
select pg_temp.assert_that(
  (select count(*) from public.grooming_job_pet_services gjps
   join public.grooming_job_pets gjp
     on gjp.organization_id=gjps.organization_id and gjp.id=gjps.grooming_job_pet_id
   where gjp.grooming_job_id='8f000000-0000-4000-8000-0000000b0001') = 1,
  'BF3 booking #1 has exactly one migrated service line');

select pg_temp.assert_that(
  (select gjps.unit_price_snapshot from public.grooming_job_pet_services gjps
   join public.grooming_job_pets gjp
     on gjp.organization_id=gjps.organization_id and gjp.id=gjps.grooming_job_pet_id
   where gjp.grooming_job_id='8f000000-0000-4000-8000-0000000b0001') = 120,
  'BF4 unit_price_snapshot preserved from legacy price_snapshot');

select pg_temp.assert_that(
  (select gjps.service_name_snapshot from public.grooming_job_pet_services gjps
   join public.grooming_job_pets gjp
     on gjp.organization_id=gjps.organization_id and gjp.id=gjps.grooming_job_pet_id
   where gjp.grooming_job_id='8f000000-0000-4000-8000-0000000b0001') = 'Legacy Bath (snap)',
  'BF5 service_name_snapshot preserved from legacy snapshot');

-- Booking #2: pet row created (status pending, not completed) but NO service line
-- (legacy service_id was null -> line correctly skipped).
select pg_temp.assert_that(
  (select status from public.grooming_job_pets
   where grooming_job_id='8f000000-0000-4000-8000-0000000b0002'
     and pet_id='8f000000-0000-4000-8000-00000000f002') = 'pending',
  'BF6 non-completed booking -> grooming_job_pet.status=pending');

select pg_temp.assert_that(
  (select count(*) from public.grooming_job_pet_services gjps
   join public.grooming_job_pets gjp
     on gjp.organization_id=gjps.organization_id and gjp.id=gjps.grooming_job_pet_id
   where gjp.grooming_job_id='8f000000-0000-4000-8000-0000000b0002') = 0,
  'BF7 booking #2 (no legacy service_id) has zero service lines');

-- grooming_jobs parent ensured for both.
select pg_temp.assert_that(
  (select count(*) from public.grooming_jobs
   where organization_id='8f000000-0000-4000-8000-000000000001'
     and booking_id in ('8f000000-0000-4000-8000-0000000b0001','8f000000-0000-4000-8000-0000000b0002')) = 2,
  'BF8 grooming_jobs parent row ensured for each backfilled booking');
