-- Transactional calendar moves and mass cancellation. Selected bookings move by
-- one shared offset, preserving their relative timing and every multi-pet grouping.
begin;

create or replace function app.move_schedule_bookings(
  p_bookings uuid[], p_delta_minutes integer, p_target_resource uuid default null
) returns jsonb language plpgsql security definer set search_path=app,public as $$
declare
  v_org uuid:=app.fn_active_organization(); v_ids uuid[]; v_count integer; v_row record;
  v_active jsonb:='[]'; v_delta interval:=make_interval(mins=>p_delta_minutes);
begin
  if v_org is null then raise exception 'not_authorized' using errcode='42501'; end if;
  select array_agg(distinct value order by value) into v_ids
    from unnest(coalesce(p_bookings,array[]::uuid[])) as input(value);
  v_count:=coalesce(cardinality(v_ids),0);
  if v_count<1 or v_count>50 then raise exception 'invalid_selection_size' using errcode='22023'; end if;
  if p_delta_minutes=0 or abs(p_delta_minutes)>43200 then raise exception 'invalid_move_offset' using errcode='22023'; end if;
  if p_target_resource is not null and v_count<>1 then raise exception 'target_resource_requires_single_booking' using errcode='22023'; end if;

  -- Stable lock order prevents two bulk moves from deadlocking each other.
  for v_row in select * from public.bookings where organization_id=v_org and id=any(v_ids) and deleted_at is null order by id for update loop
    if v_row.status not in ('draft','requested','confirmed') then raise exception 'booking_not_reschedulable:%',v_row.id using errcode='22023'; end if;
    perform app.assert_tenant_authorized(v_org,'scheduling','booking.update',v_row.branch_id);
  end loop;
  if (select count(*) from public.bookings where organization_id=v_org and id=any(v_ids) and deleted_at is null)<>v_count then raise exception 'booking_not_found' using errcode='P0002'; end if;
  if (select count(distinct branch_id) from public.bookings where organization_id=v_org and id=any(v_ids))<>1 then raise exception 'selection_must_share_branch' using errcode='22023'; end if;
  if p_target_resource is not null and not exists(
    select 1 from public.resources r join public.bookings b on b.organization_id=r.organization_id and b.branch_id=r.branch_id
     where b.organization_id=v_org and b.id=v_ids[1] and r.id=p_target_resource and r.kind='staff' and r.status='active' and r.deleted_at is null
  ) then raise exception 'resource_not_available_in_branch' using errcode='22023'; end if;

  select coalesce(jsonb_agg(jsonb_build_object('booking',booking_id,'resource',resource_id)),'[]'::jsonb)
    into v_active from public.booking_resources where organization_id=v_org and booking_id=any(v_ids) and is_active;
  update public.booking_resources set is_active=false where organization_id=v_org and booking_id=any(v_ids) and is_active;
  update public.bookings set starts_at=starts_at+v_delta,ends_at=ends_at+v_delta,
    metadata=metadata||jsonb_build_object('last_schedule_move',jsonb_build_object('minutes',p_delta_minutes,'at',now(),'by',auth.uid()))
    where organization_id=v_org and id=any(v_ids);
  update public.booking_resources set during=tstzrange(lower(during)+v_delta,upper(during)+v_delta,'[)')
    where organization_id=v_org and booking_id=any(v_ids);

  if p_target_resource is not null then
    update public.grooming_job_pets set assigned_resource_id=p_target_resource
      where organization_id=v_org and grooming_job_id=v_ids[1] and deleted_at is null;
    insert into public.booking_resources(organization_id,booking_id,resource_id,during,is_active)
    select v_org,b.id,p_target_resource,tstzrange(b.starts_at,b.ends_at,'[)'),false from public.bookings b where b.organization_id=v_org and b.id=v_ids[1]
    on conflict(booking_id,resource_id) do update set during=excluded.during,is_active=false;
    v_active:=jsonb_build_array(jsonb_build_object('booking',v_ids[1],'resource',p_target_resource));
  end if;

  if exists(
    select 1 from jsonb_array_elements(v_active) a
    join public.booking_resources br on br.organization_id=v_org and br.booking_id=(a->>'booking')::uuid and br.resource_id=(a->>'resource')::uuid
    join public.resource_availability ra on ra.organization_id=v_org and ra.resource_id=br.resource_id and ra.kind='blackout' and ra.deleted_at is null
     and ra.starts_at is not null and ra.ends_at is not null and tstzrange(ra.starts_at,ra.ends_at,'[)')&&br.during
  ) then raise exception 'resource_blackout_conflict' using errcode='23P01'; end if;

  update public.booking_resources br set is_active=true
   where br.organization_id=v_org and exists(
     select 1 from jsonb_array_elements(v_active) a
      where (a->>'booking')::uuid=br.booking_id and (a->>'resource')::uuid=br.resource_id
   );

  insert into public.timeline_events
    (organization_id, subject_type, subject_id, actor_id, event_type, summary, data)
  select v_org, 'booking', id, app.fn_current_user_id(), 'booking.schedule_moved',
    format('Jadwal dipindahkan %s menit', p_delta_minutes),
    jsonb_build_object('delta_minutes',p_delta_minutes,'target_resource_id',p_target_resource)
  from public.bookings where organization_id=v_org and id=any(v_ids);
  return jsonb_build_object('moved',v_count,'delta_minutes',p_delta_minutes);
end $$;

create or replace function app.cancel_schedule_bookings(p_bookings uuid[])
returns jsonb language plpgsql security definer set search_path=app,public as $$
declare v_org uuid:=app.fn_active_organization(); v_ids uuid[]; v_row record; v_count integer:=0;
begin
  if v_org is null then raise exception 'not_authorized' using errcode='42501'; end if;
  select array_agg(distinct value order by value) into v_ids
    from unnest(coalesce(p_bookings,array[]::uuid[])) as input(value);
  if coalesce(cardinality(v_ids),0)<1 or cardinality(v_ids)>50 then raise exception 'invalid_selection_size' using errcode='22023'; end if;
  for v_row in select * from public.bookings where organization_id=v_org and id=any(v_ids) and deleted_at is null order by id for update loop
    perform app.assert_tenant_authorized(v_org,'scheduling','booking.cancel',v_row.branch_id);
    if v_row.status not in ('draft','requested','confirmed','in_progress') then raise exception 'booking_not_cancellable:%',v_row.id using errcode='22023'; end if;
    perform app.transition_booking_status(v_row.id,'canceled'); v_count:=v_count+1;
  end loop;
  if v_count<>cardinality(v_ids) then raise exception 'booking_not_found' using errcode='P0002'; end if;
  return jsonb_build_object('canceled',v_count);
end $$;

revoke all on function app.move_schedule_bookings(uuid[],integer,uuid) from public;
revoke all on function app.cancel_schedule_bookings(uuid[]) from public;
grant execute on function app.move_schedule_bookings(uuid[],integer,uuid) to authenticated;
grant execute on function app.cancel_schedule_bookings(uuid[]) to authenticated;
notify pgrst,'reload schema';
commit;
