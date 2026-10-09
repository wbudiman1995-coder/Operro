-- Organization-wide visibility for the four dashboard metric cards.
begin;

create function app.update_dashboard_card_settings(p_cards jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := app.fn_active_organization();
  v_key text;
  v_settings jsonb;
  v_dashboard jsonb;
begin
  if v_org is null or not app.has_membership() or not app.has_permission('settings.manage') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_cards is null or jsonb_typeof(p_cards) <> 'object' then
    raise exception 'invalid_dashboard_cards' using errcode = '22023';
  end if;
  -- The complete allowlist, exactly: every card present as a boolean, nothing else.
  for v_key in select jsonb_object_keys(p_cards) loop
    if v_key <> all(array['booking_today','revenue_today','active_customers','open_tasks']) then
      raise exception 'invalid_dashboard_card_key' using errcode = '22023';
    end if;
  end loop;
  foreach v_key in array array['booking_today','revenue_today','active_customers','open_tasks'] loop
    if jsonb_typeof(p_cards -> v_key) is distinct from 'boolean' then
      raise exception 'invalid_dashboard_card_value' using errcode = '22023';
    end if;
  end loop;

  select settings into v_settings from public.organizations where id = v_org for update;
  if not found then raise exception 'not_authorized' using errcode = '42501'; end if;
  if jsonb_typeof(v_settings) is distinct from 'object' then v_settings := '{}'::jsonb; end if;
  if jsonb_typeof(v_settings -> 'dashboard') = 'object' then
    v_dashboard := v_settings -> 'dashboard';
  else
    v_dashboard := '{}'::jsonb;
  end if;

  update public.organizations
     set settings = v_settings || jsonb_build_object('dashboard', v_dashboard || jsonb_build_object('cards', p_cards))
   where id = v_org;
end $$;

revoke all on function app.update_dashboard_card_settings(jsonb) from public, anon, authenticated;
grant execute on function app.update_dashboard_card_settings(jsonb) to authenticated;

notify pgrst, 'reload schema';
commit;
