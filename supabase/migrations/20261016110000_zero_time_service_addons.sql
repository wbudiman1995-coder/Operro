-- Chargeable treatment add-ons do not extend the groomer's calendar block.
-- Existing positive-duration services and booking snapshots keep their values.
begin;

alter table public.service_catalog drop constraint chk_service_catalog_duration;
alter table public.service_catalog add constraint chk_service_catalog_duration
  check (duration_minutes >= 0);

alter table public.grooming_job_pet_services drop constraint chk_gjps_duration;
alter table public.grooming_job_pet_services add constraint chk_gjps_duration
  check (duration_minutes >= 0);

commit;
