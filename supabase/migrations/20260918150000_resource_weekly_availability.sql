-- Atomic weekly working-hours editor for groomer resources.
create or replace function app.replace_resource_weekly_availability(p_resource uuid, p_windows jsonb)
returns integer
language plpgsql
security definer
set search_path = app, public
as $$
declare
  v_org uuid := app.fn_active_organization();
  v_branch uuid;
  v_item jsonb;
  v_day integer;
  v_start time;
  v_end time;
  v_count integer := 0;
begin
  if v_org is null or not app.has_permission('resource.manage') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select branch_id into v_branch from public.resources
   where organization_id = v_org and id = p_resource and kind = 'staff' and status = 'active' and deleted_at is null
   for update;
  if not found then raise exception 'resource_not_found' using errcode = 'P0002'; end if;
  perform app.assert_tenant_authorized(v_org, 'scheduling', 'resource.manage', v_branch);
  if jsonb_typeof(p_windows) <> 'array' or jsonb_array_length(p_windows) > 14 then
    raise exception 'invalid_windows' using errcode = '22023';
  end if;

  update public.resource_availability set deleted_at = now()
   where organization_id = v_org and resource_id = p_resource and kind = 'available' and deleted_at is null;

  for v_item in select value from jsonb_array_elements(p_windows) loop
    begin
      v_day := (v_item->>'dayOfWeek')::integer;
      v_start := (v_item->>'startTime')::time;
      v_end := (v_item->>'endTime')::time;
    exception when others then
      raise exception 'invalid_window_shape' using errcode = '22023';
    end;
    if v_day < 0 or v_day > 6 or v_end <= v_start then
      raise exception 'invalid_window_range' using errcode = '22023';
    end if;
    insert into public.resource_availability
      (organization_id, branch_id, resource_id, kind, day_of_week, start_time, end_time, effective_from, metadata)
    values
      (v_org, v_branch, p_resource, 'available', v_day, v_start, v_end, current_date,
       jsonb_build_object('source', 'weekly_schedule_editor'));
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

revoke all on function app.replace_resource_weekly_availability(uuid, jsonb) from public;
grant execute on function app.replace_resource_weekly_availability(uuid, jsonb) to authenticated;
notify pgrst, 'reload schema';
