-- OPERRO 0013 — READ-ONLY STAGING VERIFICATION
-- Run in Supabase Dashboard > SQL Editor > New query > paste > Run.
-- This file does not modify data.

select 'table:grooming_job_pets' as check_name,
       case when to_regclass('public.grooming_job_pets') is not null then 'PASS' else 'FAIL' end as result
union all
select 'table:grooming_job_pet_services',
       case when to_regclass('public.grooming_job_pet_services') is not null then 'PASS' else 'FAIL' end
union all
select 'table:package_reservations',
       case when to_regclass('public.package_reservations') is not null then 'PASS' else 'FAIL' end
union all
select 'bookings.pet_id removed',
       case when not exists (
         select 1 from information_schema.columns
         where table_schema='public' and table_name='bookings' and column_name='pet_id'
       ) then 'PASS' else 'FAIL' end
union all
select 'bookings.service_id removed',
       case when not exists (
         select 1 from information_schema.columns
         where table_schema='public' and table_name='bookings' and column_name='service_id'
       ) then 'PASS' else 'FAIL' end
union all
select 'RLS:grooming_job_pets',
       case when exists (
         select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
         where n.nspname='public' and c.relname='grooming_job_pets' and c.relrowsecurity
       ) then 'PASS' else 'FAIL' end
union all
select 'RLS:grooming_job_pet_services',
       case when exists (
         select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
         where n.nspname='public' and c.relname='grooming_job_pet_services' and c.relrowsecurity
       ) then 'PASS' else 'FAIL' end
union all
select 'RLS:package_reservations',
       case when exists (
         select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
         where n.nspname='public' and c.relname='package_reservations' and c.relrowsecurity
       ) then 'PASS' else 'FAIL' end
union all
select 'RPC:app.complete_booking',
       case when to_regprocedure('app.complete_booking(uuid,boolean,text)') is not null then 'PASS' else 'FAIL' end
union all
select 'RPC:app.transition_booking_status',
       case when to_regprocedure('app.transition_booking_status(uuid,text,text)') is not null then 'PASS' else 'FAIL' end
order by check_name;

-- Confirm protected columns are NOT directly updateable by authenticated.
select table_name, column_name, privilege_type
from information_schema.column_privileges
where grantee = 'authenticated'
  and table_schema = 'public'
  and table_name in ('grooming_job_pets','grooming_job_pet_services')
  and column_name in ('deleted_at','quantity')
order by table_name, column_name;
-- Expected result: 0 rows.

-- Show migration history. You should see all 13 local versions in the REMOTE column
-- when you also run `npx supabase migration list` in the script.
select version
from supabase_migrations.schema_migrations
order by version;
