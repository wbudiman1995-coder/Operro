-- =====================================================================
-- POSITIVE backfill fixture — seed PRE-0013 legacy grooming bookings.
-- =====================================================================
-- Apply this AFTER 0001..0012 but BEFORE 0013. It creates grooming bookings
-- that use the OLD singular columns (bookings.pet_id / service_id / snapshots),
-- exactly the shape 0013 SECTION 300 must migrate. run_backfill_positive.sh
-- then applies 0013 and asserts every legacy value was preserved into the new
-- grooming_job_pets / grooming_job_pet_services model and the columns dropped.
--
-- Fixtures use the 8f…/valid-hex namespace to avoid colliding with the test
-- suite's 0a…/0b…/0c… namespaces.
-- =====================================================================
\set ON_ERROR_STOP on
begin;

insert into public.organizations (id,name,slug,status) values
  ('8f000000-0000-4000-8000-000000000001','Backfill Org','backfill-org','active') on conflict do nothing;
insert into public.branches (id,organization_id,name,is_default,status) values
  ('8f000000-0000-4000-8000-0000000000b1','8f000000-0000-4000-8000-000000000001','BF Main',true,'active') on conflict do nothing;
insert into public.customers (id,organization_id,display_name) values
  ('8f000000-0000-4000-8000-00000000c001','8f000000-0000-4000-8000-000000000001','BF Cust') on conflict do nothing;
insert into public.pets (id,organization_id,customer_id,name) values
  ('8f000000-0000-4000-8000-00000000f001','8f000000-0000-4000-8000-000000000001','8f000000-0000-4000-8000-00000000c001','Legacy Rex'),
  ('8f000000-0000-4000-8000-00000000f002','8f000000-0000-4000-8000-000000000001','8f000000-0000-4000-8000-00000000c001','Legacy Coco') on conflict do nothing;
insert into public.service_catalog (id,organization_id,name,base_price,currency) values
  ('8f000000-0000-4000-8000-000000005001','8f000000-0000-4000-8000-000000000001','Legacy Bath',120,'USD') on conflict do nothing;

-- Legacy booking #1: grooming, completed, HAS pet + service + snapshots.
insert into public.bookings
  (id,organization_id,branch_id,customer_id,booking_type,status,starts_at,ends_at,
   pet_id,service_id,service_name_snapshot,price_snapshot,currency)
values
  ('8f000000-0000-4000-8000-0000000b0001','8f000000-0000-4000-8000-000000000001',
   '8f000000-0000-4000-8000-0000000000b1','8f000000-0000-4000-8000-00000000c001',
   'grooming','completed',now(),now()+interval '1 hour',
   '8f000000-0000-4000-8000-00000000f001','8f000000-0000-4000-8000-000000005001',
   'Legacy Bath (snap)',120,'USD') on conflict do nothing;

-- Legacy booking #2: grooming, confirmed, HAS pet but NO service_id (service line
-- must be skipped by backfill, pet row must still be created).
insert into public.bookings
  (id,organization_id,branch_id,customer_id,booking_type,status,starts_at,ends_at,
   pet_id,service_id,service_name_snapshot,price_snapshot,currency)
values
  ('8f000000-0000-4000-8000-0000000b0002','8f000000-0000-4000-8000-000000000001',
   '8f000000-0000-4000-8000-0000000000b1','8f000000-0000-4000-8000-00000000c001',
   'grooming','confirmed',now(),now()+interval '1 hour',
   '8f000000-0000-4000-8000-00000000f002',null,null,null,null) on conflict do nothing;

commit;
