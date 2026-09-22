-- Narrow invoice-time read of package coverage. Invoice issuers should not need broad
-- membership.read access merely to price the booking they are authorized to invoice.
begin;

create or replace function app.list_booking_package_coverage(p_booking uuid)
returns table(line_id uuid, customer_package_id uuid, reservation_status text)
language plpgsql security definer set search_path=app,public as $$
declare v_booking public.bookings;
begin
  select * into v_booking from public.bookings
   where organization_id=app.fn_active_organization() and id=p_booking and deleted_at is null;
  if not found then raise exception 'booking_not_found' using errcode='P0002'; end if;
  perform app.assert_tenant_authorized(v_booking.organization_id,'finance','invoice.issue',v_booking.branch_id);
  return query
    select pr.grooming_job_pet_service_id,pr.customer_package_id,pr.status
    from public.package_reservations pr
    join public.grooming_job_pet_services line on line.organization_id=pr.organization_id and line.id=pr.grooming_job_pet_service_id
    join public.grooming_job_pets pet on pet.organization_id=line.organization_id and pet.id=line.grooming_job_pet_id
    where pr.organization_id=v_booking.organization_id and pet.grooming_job_id=p_booking
      and line.deleted_at is null and pet.deleted_at is null and pr.status in ('reserved','consumed');
end $$;

revoke all on function app.list_booking_package_coverage(uuid) from public;
grant execute on function app.list_booking_package_coverage(uuid) to authenticated;
notify pgrst,'reload schema';
commit;
