-- =====================================================================
-- NEGATIVE backfill fixture — seed data that MUST trip SECTION 310's abort.
-- =====================================================================
-- Apply AFTER 0001..0012, BEFORE 0013. It inserts a NON-grooming booking that
-- carries a legacy pet_id/service_id. SECTION 300 only backfills grooming
-- bookings, so this row has no mapping path; SECTION 310 (pass-3 REVIEW ITEM
-- 13) counts it as non_grooming_legacy and RAISES 'BACKFILL ABORT'.
--
-- Because 0013 (pass 3) is wrapped in a single BEGIN;...COMMIT;, that raise
-- must abort the ENTIRE migration: no new tables, no dropped columns, no
-- grants. run_backfill_negative.sh proves that on a FRESH connection.
-- =====================================================================
\set ON_ERROR_STOP on
begin;

insert into public.organizations (id,name,slug,status) values
  ('8e000000-0000-4000-8000-000000000001','Neg Org','neg-org','active') on conflict do nothing;
insert into public.branches (id,organization_id,name,is_default,status) values
  ('8e000000-0000-4000-8000-0000000000b1','8e000000-0000-4000-8000-000000000001','Neg Main',true,'active') on conflict do nothing;
insert into public.customers (id,organization_id,display_name) values
  ('8e000000-0000-4000-8000-00000000c001','8e000000-0000-4000-8000-000000000001','Neg Cust') on conflict do nothing;
insert into public.pets (id,organization_id,customer_id,name) values
  ('8e000000-0000-4000-8000-00000000f001','8e000000-0000-4000-8000-000000000001','8e000000-0000-4000-8000-00000000c001','Neg Pet') on conflict do nothing;
insert into public.service_catalog (id,organization_id,name,base_price,currency) values
  ('8e000000-0000-4000-8000-000000005001','8e000000-0000-4000-8000-000000000001','Neg Svc',50,'USD') on conflict do nothing;

-- POISON: a NON-grooming booking (booking_type='boarding') that still carries a
-- legacy pet_id + service_id. SECTION 300 will not touch it; SECTION 310 must
-- abort rather than let SECTION 320 drop the columns and lose this data.
insert into public.bookings
  (id,organization_id,branch_id,customer_id,booking_type,status,starts_at,ends_at,
   pet_id,service_id,service_name_snapshot,price_snapshot,currency)
values
  ('8e000000-0000-4000-8000-0000000b0001','8e000000-0000-4000-8000-000000000001',
   '8e000000-0000-4000-8000-0000000000b1','8e000000-0000-4000-8000-00000000c001',
   'boarding','confirmed',now(),now()+interval '1 day',
   '8e000000-0000-4000-8000-00000000f001','8e000000-0000-4000-8000-000000005001',
   'Boarding w/ addon',50,'USD') on conflict do nothing;

commit;
