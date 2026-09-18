-- Materialized recurring booking series with tenant-safe lineage.
-- A series is created atomically from an existing grooming booking. Every child keeps
-- immutable commercial/location snapshots and gets independent operational rows.

alter table public.booking_recurrence
  add constraint uq_booking_recurrence_org_id unique (organization_id, id);

alter table public.bookings
  add column booking_recurrence_id uuid,
  add column recurrence_sequence integer,
  add constraint fk_bookings_recurrence foreign key (organization_id, booking_recurrence_id)
    references public.booking_recurrence (organization_id, id) on delete set null,
  add constraint chk_bookings_recurrence_sequence check (recurrence_sequence is null or recurrence_sequence > 0);

create index idx_bookings_recurrence on public.bookings (organization_id, booking_recurrence_id, recurrence_sequence)
  where booking_recurrence_id is not null;

grant insert (booking_recurrence_id, recurrence_sequence), update (booking_recurrence_id, recurrence_sequence)
  on public.bookings to authenticated;

create or replace function app.create_booking_series(
  p_template_booking uuid,
  p_frequency text,
  p_occurrences integer,
  p_conflict_mode text default 'skip'
) returns jsonb
language plpgsql
security definer
set search_path = app, public
as $$
declare
  v_org uuid := app.fn_active_organization();
  v_template public.bookings%rowtype;
  v_series uuid;
  v_new_booking uuid;
  v_new_pet uuid;
  v_step interval;
  v_offset interval;
  v_created integer := 1;
  v_skipped integer[] := '{}';
  i integer;
  r_pet record;
  r_line record;
begin
  if v_org is null or not app.has_permission('booking.create') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_frequency not in ('weekly','biweekly','monthly') then
    raise exception 'invalid_frequency' using errcode = '22023';
  end if;
  if p_occurrences < 2 or p_occurrences > 52 then
    raise exception 'invalid_occurrence_count' using errcode = '22023';
  end if;
  if p_conflict_mode not in ('skip','stop') then
    raise exception 'invalid_conflict_mode' using errcode = '22023';
  end if;

  select * into v_template from public.bookings
   where organization_id = v_org and id = p_template_booking and deleted_at is null
   for update;
  if not found then raise exception 'booking_not_found' using errcode = 'P0002'; end if;
  if v_template.booking_type <> 'grooming' then raise exception 'unsupported_booking_type' using errcode = '22023'; end if;
  if v_template.status in ('completed','canceled','no_show') then raise exception 'booking_closed' using errcode = '22023'; end if;
  perform app.assert_tenant_authorized(v_org, 'scheduling', 'booking.create', v_template.branch_id);
  if v_template.booking_recurrence_id is not null then raise exception 'booking_already_in_series' using errcode = '23505'; end if;

  v_step := case p_frequency when 'weekly' then interval '1 week' when 'biweekly' then interval '2 weeks' else interval '1 month' end;
  insert into public.booking_recurrence (organization_id, template_booking_id, rrule, max_count, metadata)
  values (v_org, v_template.id,
    case p_frequency when 'weekly' then 'FREQ=WEEKLY' when 'biweekly' then 'FREQ=WEEKLY;INTERVAL=2' else 'FREQ=MONTHLY' end || ';COUNT=' || p_occurrences,
    p_occurrences, jsonb_build_object('frequency', p_frequency, 'conflict_mode', p_conflict_mode, 'materialized', true))
  returning id into v_series;

  update public.bookings set booking_recurrence_id = v_series, recurrence_sequence = 1
   where organization_id = v_org and id = v_template.id;

  for i in 2..p_occurrences loop
    v_offset := v_step * (i - 1);
    begin
      insert into public.bookings (
        organization_id, branch_id, customer_id, pet_id, booking_type, status, fulfillment_mode,
        starts_at, ends_at, service_id, service_name_snapshot, price_snapshot, currency, notes, metadata,
        customer_address_id, address_snapshot, travel_fee, travel_minutes_snapshot, service_area_matched,
        dispatch_stage, booking_recurrence_id, recurrence_sequence
      ) values (
        v_org, v_template.branch_id, v_template.customer_id, v_template.pet_id, v_template.booking_type,
        v_template.status, v_template.fulfillment_mode, v_template.starts_at + v_offset, v_template.ends_at + v_offset,
        v_template.service_id, v_template.service_name_snapshot, v_template.price_snapshot, v_template.currency,
        v_template.notes, v_template.metadata || jsonb_build_object('series_template', v_template.id),
        v_template.customer_address_id, v_template.address_snapshot, v_template.travel_fee,
        v_template.travel_minutes_snapshot, v_template.service_area_matched,
        case when v_template.fulfillment_mode = 'home' then 'scheduled' else null end, v_series, i
      ) returning id into v_new_booking;

      insert into public.grooming_jobs (booking_id, organization_id, checklist, photos, groomer_notes, coat_condition, metadata)
      select v_new_booking, v_org, '{}'::jsonb, '[]'::jsonb, null, coat_condition,
             metadata || jsonb_build_object('series_template_booking', v_template.id)
        from public.grooming_jobs where organization_id = v_org and booking_id = v_template.id;

      for r_pet in
        select * from public.grooming_job_pets
         where organization_id = v_org and grooming_job_id = v_template.id and deleted_at is null order by sequence
      loop
        insert into public.grooming_job_pets (
          organization_id, grooming_job_id, pet_id, sequence, assigned_resource_id, status,
          is_required, instructions, warnings, preferences, evidence_required, metadata
        ) values (
          v_org, v_new_booking, r_pet.pet_id, r_pet.sequence, r_pet.assigned_resource_id, 'pending',
          r_pet.is_required, r_pet.instructions, r_pet.warnings, r_pet.preferences, r_pet.evidence_required, r_pet.metadata
        ) returning id into v_new_pet;

        for r_line in
          select * from public.grooming_job_pet_services
           where organization_id = v_org and grooming_job_pet_id = r_pet.id and deleted_at is null
        loop
          insert into public.grooming_job_pet_services (
            organization_id, grooming_job_pet_id, service_id, service_name_snapshot, duration_minutes,
            quantity, unit_price_snapshot, currency, assigned_resource_id, commission_basis,
            inventory_basis, instructions, metadata
          ) values (
            v_org, v_new_pet, r_line.service_id, r_line.service_name_snapshot, r_line.duration_minutes,
            r_line.quantity, r_line.unit_price_snapshot, r_line.currency, r_line.assigned_resource_id,
            r_line.commission_basis, r_line.inventory_basis, r_line.instructions, r_line.metadata
          );
        end loop;
      end loop;

      insert into public.booking_resources (booking_id, resource_id, organization_id, during, is_active)
      select v_new_booking, resource_id, v_org,
             tstzrange(lower(during) + v_offset, upper(during) + v_offset, '[)'), true
        from public.booking_resources
       where organization_id = v_org and booking_id = v_template.id and is_active;
      v_created := v_created + 1;
    exception when exclusion_violation then
      if p_conflict_mode = 'stop' then raise; end if;
      v_skipped := array_append(v_skipped, i);
    end;
  end loop;

  update public.booking_recurrence
     set metadata = metadata || jsonb_build_object('created_count', v_created, 'skipped_sequences', to_jsonb(v_skipped))
   where organization_id = v_org and id = v_series;
  return jsonb_build_object('series_id', v_series, 'created_count', v_created, 'skipped_sequences', to_jsonb(v_skipped));
end;
$$;

revoke all on function app.create_booking_series(uuid, text, integer, text) from public;
grant execute on function app.create_booking_series(uuid, text, integer, text) to authenticated;

notify pgrst, 'reload schema';
