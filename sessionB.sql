-- =====================================================================
-- NEGATIVE integrity proof — run on a FRESH connection AFTER 0013 aborted.
-- =====================================================================
-- Proves the failed 0013 left the pre-0013 database EXACTLY as it was:
--   * the poison booking still has its pet_id/service_id (nothing dropped);
--   * bookings.pet_id / service_id COLUMNS still exist (SECTION 320 never ran);
--   * NONE of 0013's new tables exist (SECTION 100 rolled back);
--   * NONE of 0013's new functions exist (SECTION 400+ rolled back);
--   * the pre-existing status-triggered effect functions that SECTION 000
--     would have DROPPED are still present (the DROP rolled back too);
--   * grooming_jobs has NOT gained 0013's uq_grooming_jobs_org_id constraint.
-- Any failed assertion raises; psql (ON_ERROR_STOP=1) exits nonzero.
-- =====================================================================
\set ON_ERROR_STOP on

create or replace function pg_temp.assert_that(cond boolean, label text)
returns void language plpgsql as $$
begin
  if cond then raise notice 'PASS: %', label;
  else raise exception 'FAIL: %', label; end if;
end; $$;

-- 1. Poison data intact: the non-grooming booking still has its legacy values.
select pg_temp.assert_that(
  (select pet_id from public.bookings where id='8e000000-0000-4000-8000-0000000b0001')
    = '8e000000-0000-4000-8000-00000000f001'::uuid
  and (select service_id from public.bookings where id='8e000000-0000-4000-8000-0000000b0001')
    = '8e000000-0000-4000-8000-000000005001'::uuid,
  'NEG1 poison booking still carries legacy pet_id + service_id');

-- 2. Legacy COLUMNS still present (SECTION 320 drop never committed).
select pg_temp.assert_that(
  exists (select 1 from information_schema.columns
          where table_schema='public' and table_name='bookings' and column_name='pet_id')
  and exists (select 1 from information_schema.columns
          where table_schema='public' and table_name='bookings' and column_name='service_id'),
  'NEG2 bookings.pet_id/service_id columns still exist (drop rolled back)');

-- 3. NONE of 0013's new tables exist (SECTION 100 rolled back).
select pg_temp.assert_that(
  not exists (select 1 from information_schema.tables
              where table_schema='public'
                and table_name in ('grooming_job_pets','grooming_job_pet_services','package_reservations')),
  'NEG3 no 0013 tables created (grooming_job_pets/…_services/package_reservations absent)');

-- 4. NONE of 0013's new functions exist (SECTION 400+ rolled back).
select pg_temp.assert_that(
  not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='app'
      and p.proname in ('complete_booking','reserve_package_session',
                        'transition_booking_status','assert_tenant_authorized',
                        'tenant_has_permission','tenant_has_module','tenant_has_membership',
                        'reverse_package_reservation','expire_package_reservations')),
  'NEG4 no 0013 app.* functions created (all rolled back)');

-- 5. The pre-existing status-triggered effect functions + triggers that
--    SECTION 000 would have DROPPED are STILL present (the DROP rolled back).
--    These six are defined by an earlier batch in this project and are the
--    exact objects SECTION 000 targets; all must survive an aborted 0013.
select pg_temp.assert_that(
  (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public'
     and p.proname in ('tg_bookings_accrue_commission','tg_bookings_consume_on_complete',
                       'tg_bookings_consume_package','fn_accrue_commission',
                       'fn_consume_service_inventory','fn_consume_package_session')) = 6,
  'NEG5 all six SECTION 000 drop-target functions survived the aborted migration');

-- 6. grooming_jobs did NOT gain 0013's composite unique key (SECTION 200 rolled back).
select pg_temp.assert_that(
  not exists (select 1 from pg_constraint where conname='uq_grooming_jobs_org_id'),
  'NEG6 grooming_jobs.uq_grooming_jobs_org_id NOT added (SECTION 200 rolled back)');

-- 7. subject_types did NOT gain the grooming_job_pet registration (SECTION 210).
select pg_temp.assert_that(
  not exists (select 1 from public.subject_types where key='grooming_job_pet'),
  'NEG7 subject_types grooming_job_pet NOT registered (SECTION 210 rolled back)');

-- 8. commission_entries did NOT gain reference_line_id (SECTION 110 rolled back).
select pg_temp.assert_that(
  not exists (select 1 from information_schema.columns
              where table_schema='public' and table_name='commission_entries'
                and column_name='reference_line_id'),
  'NEG8 commission_entries.reference_line_id NOT added (SECTION 110 rolled back)');
