-- Audited booking archive with series scope, linked visit cleanup and package correction.
begin;
create or replace function app.archive_booking_scope(p_booking uuid,p_scope text)
returns jsonb language plpgsql security definer set search_path=app,public as $$
declare v_org uuid:=app.fn_active_organization(); v_anchor public.bookings%rowtype; v_ids uuid[]; v_id uuid; r record; v_now timestamptz:=now();
begin
  if p_scope not in ('current','future','all') then raise exception 'invalid_scope' using errcode='22023'; end if;
  select * into v_anchor from public.bookings where organization_id=v_org and id=p_booking and deleted_at is null for update;
  if not found then raise exception 'booking_not_found' using errcode='P0002'; end if;
  perform app.assert_tenant_authorized(v_org,'scheduling','booking.cancel',v_anchor.branch_id);
  perform app.assert_tenant_authorized(v_org,'scheduling','booking.update',v_anchor.branch_id);
  if v_anchor.booking_recurrence_id is null and p_scope<>'current' then raise exception 'booking_not_in_series' using errcode='22023'; end if;
  select coalesce(array_agg(id order by recurrence_sequence nulls first),'{}'::uuid[]) into v_ids from public.bookings
   where organization_id=v_org and deleted_at is null and status in ('draft','canceled','no_show') and (
    (p_scope='current' and id=v_anchor.id) or
    (p_scope='future' and booking_recurrence_id=v_anchor.booking_recurrence_id and recurrence_sequence>=v_anchor.recurrence_sequence) or
    (p_scope='all' and booking_recurrence_id=v_anchor.booking_recurrence_id));
  if cardinality(v_ids)=0 then raise exception 'booking_not_archivable' using errcode='22023'; end if;
  if exists(select 1 from public.orders where organization_id=v_org and booking_id=any(v_ids) and deleted_at is null)
  then raise exception 'linked_financial_record' using errcode='23503'; end if;
  for v_id in select unnest(v_ids) loop
    for r in select pr.id,pr.status from public.package_reservations pr
      join public.grooming_job_pet_services l on l.organization_id=pr.organization_id and l.id=pr.grooming_job_pet_service_id
      join public.grooming_job_pets p on p.organization_id=l.organization_id and p.id=l.grooming_job_pet_id
      where pr.organization_id=v_org and p.grooming_job_id=v_id for update of pr
    loop
      if r.status='consumed' then perform app.reverse_package_reservation(r.id);
      elsif r.status='reserved' then update public.package_reservations set status='released',released_at=v_now where id=r.id; end if;
    end loop;
    update public.booking_resources set is_active=false where organization_id=v_org and booking_id=v_id and is_active;
    update public.grooming_job_pet_services l set deleted_at=v_now from public.grooming_job_pets p where l.organization_id=v_org and p.organization_id=l.organization_id and p.id=l.grooming_job_pet_id and p.grooming_job_id=v_id and l.deleted_at is null;
    update public.grooming_job_pets set deleted_at=v_now where organization_id=v_org and grooming_job_id=v_id and deleted_at is null;
    update public.grooming_jobs set metadata=metadata||jsonb_build_object('archived_at',v_now,'archive_scope',p_scope) where organization_id=v_org and booking_id=v_id;
    update public.bookings set deleted_at=v_now where organization_id=v_org and id=v_id;
    insert into public.timeline_events(organization_id,subject_type,subject_id,actor_id,event_type,summary,data)
    values(v_org,'booking',v_id,app.fn_current_user_id(),'booking.archived','Booking and linked visit archived',jsonb_build_object('scope',p_scope,'package_reservations_reconciled',true));
  end loop;
  return jsonb_build_object('scope',p_scope,'archived_count',cardinality(v_ids));
end $$;
revoke all on function app.archive_booking_scope(uuid,text) from public;
grant execute on function app.archive_booking_scope(uuid,text) to authenticated;
notify pgrst,'reload schema';
commit;
