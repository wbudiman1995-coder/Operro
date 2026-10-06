-- Dynamic tenant-owned size bands, part 5 (SB-05): safe management RPCs.
-- Bundle 1 made the schema administrable; this migration adds the only write
-- paths (the tables stay without client DML grants):
--   app.preview_size_layout_impact  app.save_size_bands  app.archive_size_band
--   app.delete_size_band  app.set_service_band_prices  app.set_size_band_mode
-- and turns app.set_dog_size_boundaries into a compatibility wrapper.
--
-- Authority
--   layout preview/save/archive/delete : the real business owner of the ACTIVE
--       organization, only while the organization is already in `dynamic` mode;
--       the Operro platform owner only for the tenant it has actively selected.
--       Support/helper roles and every other member are denied.
--   mode switch                        : platform owner only, active tenant only.
--   service band prices                : `service.manage` in the active organization.
--
-- Locking: every write takes organization_size_band_settings FOR UPDATE first.
-- Bundle 1's assembly_add_line already takes it FOR SHARE; the package sale and
-- renewal guards are redefined below to take it FOR SHARE as their very first
-- statement, so a layout change and a line/sale are strictly ordered and every
-- path acquires locks in the same order (settings, then rows).
begin;

-- ------------------------------------------------------------------ helpers
create function app.size_band_slug(p_label text) returns text
language plpgsql immutable set search_path = '' as $$
declare s text;
begin
  s := btrim(regexp_replace(lower(btrim(coalesce(p_label, ''))), '[^a-z0-9]+', '_', 'g'), '_');
  if s !~ '^[a-z]' or length(s) < 2 then s := 'band_' || s; end if;
  s := regexp_replace(left(s, 24), '_+$', '');
  if length(s) < 2 then s := 'band'; end if;
  return s;
end $$;

-- Deterministic server-side key: slug of the label, then _2, _3 ... on collision
-- with any band of the organization, a species key, a reserved key or a key
-- generated earlier in the same request.
create function app.size_band_new_key(p_org uuid, p_label text, p_taken text[]) returns text
language plpgsql stable security definer set search_path = '' as $$
declare v_base text := app.size_band_slug(p_label); v_key text := v_base; n integer := 1;
begin
  while v_key in ('dog', 'cat') or v_key = any (coalesce(p_taken, '{}'))
        or exists (select 1 from public.organization_size_bands b where b.organization_id = p_org and b.band_key = v_key)
        or exists (select 1 from public.organization_pet_types t where t.organization_id = p_org and t.key = v_key) loop
    n := n + 1; v_key := v_base || '_' || n;
  end loop;
  return v_key;
end $$;

create function app.size_band_snapshot(p_org uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'mode', (select s.mode from public.organization_size_band_settings s where s.organization_id = p_org),
    'layout_version', (select s.layout_version from public.organization_size_band_settings s where s.organization_id = p_org),
    'bands', coalesce((select jsonb_agg(jsonb_build_object('id', b.id, 'key', b.band_key, 'kind', b.band_kind, 'label', b.label,
        'sort_order', b.sort_order, 'upper_kg', b.upper_kg, 'upper_inclusive', b.upper_inclusive, 'status', b.status)
        order by b.band_kind, b.status, b.sort_order)
      from public.organization_size_bands b where b.organization_id = p_org), '[]'::jsonb));
$$;

create function app.size_band_audit(p_org uuid, p_event text, p_before jsonb, p_after jsonb) returns void
language plpgsql security definer set search_path = '' as $$
begin
  insert into app.audit_log (organization_id, actor_id, action, entity_table, entity_id, diff)
  values (p_org, app.fn_current_user_id(), 'UPDATE', 'organization_size_band_settings', p_org,
          jsonb_build_object('event', p_event, 'old', p_before, 'new', p_after));
end $$;

-- True when the active dog layout is exactly the five legacy keys with the
-- legacy semantics (first four finite and exclusive, `large` inclusive, XL open).
create function app.size_layout_is_legacy_five(p_org uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((
    select array_agg(b.band_key order by b.sort_order) = array['extra_small','small','medium','large','extra_large']
       and bool_and(case when b.band_key = 'large' then b.upper_inclusive else not b.upper_inclusive end)
       and bool_and((b.upper_kg is null) = (b.band_key = 'extra_large'))
    from public.organization_size_bands b
    where b.organization_id = p_org and b.band_kind = 'dog_weight' and b.status = 'active'), false);
$$;

-- Dual-write the legacy mirror (boundary row + the 12 legacy catalog columns),
-- but only while the active layout stays representable by the legacy five, so
-- an administrator can always roll back to `legacy` mode without data loss.
create function app.size_band_mirror_legacy(p_org uuid, p_service uuid default null) returns void
language plpgsql security definer set search_path = '' as $$
declare v_u numeric[];
begin
  if not app.size_layout_is_legacy_five(p_org) then return; end if;
  select array_agg(b.upper_kg order by b.sort_order) into v_u
  from public.organization_size_bands b
  where b.organization_id = p_org and b.band_kind = 'dog_weight' and b.status = 'active';
  if p_service is null then
    insert into public.organization_dog_size_boundaries(organization_id, xs_lt_kg, s_lt_kg, m_lt_kg, l_lte_kg, updated_by)
    values (p_org, v_u[1], v_u[2], v_u[3], v_u[4], auth.uid())
    on conflict (organization_id) do update
      set xs_lt_kg = excluded.xs_lt_kg, s_lt_kg = excluded.s_lt_kg, m_lt_kg = excluded.m_lt_kg,
          l_lte_kg = excluded.l_lte_kg, updated_at = now(), updated_by = excluded.updated_by
      where (organization_dog_size_boundaries.xs_lt_kg, organization_dog_size_boundaries.s_lt_kg,
             organization_dog_size_boundaries.m_lt_kg, organization_dog_size_boundaries.l_lte_kg)
        is distinct from (excluded.xs_lt_kg, excluded.s_lt_kg, excluded.m_lt_kg, excluded.l_lte_kg);
  end if;
  update public.service_catalog sc set
    price_extra_small = x.p_xs, price_small = x.p_s, price_medium = x.p_m, price_large = x.p_l,
    price_extra_large = x.p_xl, price_cat = x.p_cat,
    duration_extra_small = x.d_xs, duration_small = x.d_s, duration_medium = x.d_m, duration_large = x.d_l,
    duration_extra_large = x.d_xl, duration_cat = x.d_cat
  from (
    select s.id,
      max(p.price) filter (where p.pricing_key = 'extra_small') p_xs, max(p.price) filter (where p.pricing_key = 'small') p_s,
      max(p.price) filter (where p.pricing_key = 'medium') p_m, max(p.price) filter (where p.pricing_key = 'large') p_l,
      max(p.price) filter (where p.pricing_key = 'extra_large') p_xl, max(p.price) filter (where p.pricing_key = 'cat') p_cat,
      max(p.duration_minutes) filter (where p.pricing_key = 'extra_small') d_xs, max(p.duration_minutes) filter (where p.pricing_key = 'small') d_s,
      max(p.duration_minutes) filter (where p.pricing_key = 'medium') d_m, max(p.duration_minutes) filter (where p.pricing_key = 'large') d_l,
      max(p.duration_minutes) filter (where p.pricing_key = 'extra_large') d_xl, max(p.duration_minutes) filter (where p.pricing_key = 'cat') d_cat
    from public.service_catalog s
    left join public.service_band_prices p on p.organization_id = s.organization_id and p.service_id = s.id
    where s.organization_id = p_org and (p_service is null or s.id = p_service)
    group by s.id) x
  where sc.organization_id = p_org and sc.id = x.id
    and (sc.price_extra_small, sc.price_small, sc.price_medium, sc.price_large, sc.price_extra_large, sc.price_cat,
         sc.duration_extra_small, sc.duration_small, sc.duration_medium, sc.duration_large, sc.duration_extra_large, sc.duration_cat)
        is distinct from
        (x.p_xs, x.p_s, x.p_m, x.p_l, x.p_xl, x.p_cat, x.d_xs, x.d_s, x.d_m, x.d_l, x.d_xl, x.d_cat);
end $$;

-- Who may act: raises not_authorized (42501) for everyone else. Returns the role
-- that granted access. Never trusts p_org: it must equal the selected tenant.
create function app.size_band_authorize(p_org uuid, p_kind text) returns text
language plpgsql stable security definer set search_path = '' as $$
declare v_actor text;
begin
  if p_org is null or p_org is distinct from app.fn_active_organization() then
    raise exception 'not_authorized' using errcode = '42501'; end if;
  if app.is_operro_owner() then v_actor := 'platform';
  elsif p_kind <> 'mode' and app.is_business_owner(p_org) then v_actor := 'owner';
  else raise exception 'not_authorized' using errcode = '42501'; end if;
  if not exists (select 1 from public.organizations o where o.id = p_org and o.status in ('trial','active') and o.deleted_at is null) then
    raise exception 'organization_unavailable' using errcode = '22023'; end if;
  return v_actor;
end $$;

-- Locks the settings row FOR UPDATE, enforces optimistic concurrency and mode.
create function app.size_band_lock_settings(p_org uuid, p_expected integer, p_actor text, p_require_dynamic boolean)
returns integer language plpgsql security definer set search_path = '' as $$
declare v_version integer; v_mode text;
begin
  select s.layout_version, s.mode into v_version, v_mode
  from public.organization_size_band_settings s where s.organization_id = p_org for update;
  if not found then raise exception 'size_band_settings_missing' using errcode = '22023'; end if;
  if p_require_dynamic and v_mode <> 'dynamic' then
    raise exception 'dynamic_mode_required' using errcode = case when p_actor = 'platform' then '22023' else '42501' end; end if;
  if p_expected is distinct from v_version then
    raise exception 'stale_layout' using errcode = '40001', detail = jsonb_build_object('layout_version', v_version)::text; end if;
  return v_version;
end $$;

-- ------------------------------------------------------------- layout plan
-- Validates a desired active dog layout and computes its impact. Preview and
-- save both call this function, so they cannot disagree.
--   p_bands: ordered array of {id?, label, upper_kg, upper_inclusive}; `id`
--   identifies an existing (active or archived) band, no id = new band whose
--   key the server generates. p_omit: one active band the caller is archiving.
create function app.size_layout_plan(p_org uuid, p_bands jsonb, p_omit uuid default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_n integer; v_item jsonb; v_ord integer; v_label text; v_upper numeric; v_incl boolean; v_id uuid;
  v_row public.organization_size_bands; v_seen uuid[] := '{}'; v_taken text[] := '{}'; v_labels text[] := '{}';
  v_layout jsonb := '[]'::jsonb; v_prev numeric; v_key text; v_new boolean; v_react boolean;
  v_current jsonb; v_desired jsonb; v_changed boolean; v_impact jsonb; v_conflicts integer; v_by jsonb; v_rebanded integer; v_measured integer;
  v_new_bands jsonb;
begin
  if jsonb_typeof(p_bands) is distinct from 'array' then
    raise exception 'invalid_size_layout' using errcode = '22023', detail = 'shape'; end if;
  v_n := jsonb_array_length(p_bands);
  if v_n not between 1 and 12 then
    raise exception 'invalid_size_layout' using errcode = '22023', detail = 'count'; end if;
  for v_item, v_ord in select value, ordinality from jsonb_array_elements(p_bands) with ordinality loop
    if jsonb_typeof(v_item) is distinct from 'object' then
      raise exception 'invalid_size_layout' using errcode = '22023', detail = 'shape'; end if;
    v_label := btrim(coalesce(v_item->>'label', ''));
    if length(v_label) not between 1 and 40 then
      raise exception 'invalid_size_layout' using errcode = '22023', detail = 'label'; end if;
    if lower(v_label) = any (v_labels) then
      raise exception 'invalid_size_layout' using errcode = '22023', detail = 'duplicate_label'; end if;
    v_labels := v_labels || lower(v_label);
    begin
      v_incl := coalesce((v_item->>'upper_inclusive')::boolean, false);
      v_upper := case when jsonb_typeof(v_item->'upper_kg') in ('number') then (v_item->>'upper_kg')::numeric else null end;
      if jsonb_typeof(v_item->'upper_kg') not in ('number','null') and v_item ? 'upper_kg' then
        raise exception 'bad'; end if;
    exception when others then
      raise exception 'invalid_size_layout' using errcode = '22023', detail = 'shape';
    end;
    if v_ord = v_n then
      if v_upper is not null or v_incl then
        raise exception 'invalid_size_layout' using errcode = '22023', detail = 'open_top'; end if;
    else
      if v_upper is null or v_upper <= 0 or v_upper > 999 or v_upper <> round(v_upper, 2) then
        raise exception 'invalid_size_layout' using errcode = '22023', detail = 'upper'; end if;
      if v_prev is not null and v_upper <= v_prev then
        raise exception 'invalid_size_layout' using errcode = '22023', detail = 'order'; end if;
      v_prev := v_upper;
    end if;
    v_id := null; v_new := true; v_react := false; v_key := null;
    if v_item ? 'id' and jsonb_typeof(v_item->'id') = 'string' then
      begin v_id := (v_item->>'id')::uuid; exception when others then
        raise exception 'invalid_size_layout' using errcode = '22023', detail = 'unknown_band'; end;
      select * into v_row from public.organization_size_bands b
      where b.organization_id = p_org and b.id = v_id and b.band_kind = 'dog_weight';
      if not found then raise exception 'invalid_size_layout' using errcode = '22023', detail = 'unknown_band'; end if;
      if v_id = any (v_seen) then raise exception 'invalid_size_layout' using errcode = '22023', detail = 'duplicate_band'; end if;
      v_seen := v_seen || v_id; v_key := v_row.band_key; v_new := false; v_react := v_row.status = 'archived';
    else
      v_key := app.size_band_new_key(p_org, v_label, v_taken); v_taken := v_taken || v_key;
    end if;
    v_layout := v_layout || jsonb_build_array(jsonb_build_object('ord', v_ord, 'id', v_id, 'key', v_key, 'label', v_label,
      'upper_kg', v_upper, 'upper_inclusive', v_incl, 'is_new', v_new, 'reactivated', v_react));
  end loop;
  if exists (select 1 from public.organization_size_bands b
             where b.organization_id = p_org and b.band_kind = 'dog_weight' and b.status = 'active'
               and b.id <> all (v_seen) and b.id is distinct from p_omit) then
    raise exception 'invalid_size_layout' using errcode = '22023', detail = 'omitted_band'; end if;

  select coalesce(jsonb_agg(jsonb_build_object('id', b.id, 'label', b.label, 'upper_kg', b.upper_kg, 'upper_inclusive', b.upper_inclusive)
                            order by b.sort_order), '[]'::jsonb) into v_current
  from public.organization_size_bands b
  where b.organization_id = p_org and b.band_kind = 'dog_weight' and b.status = 'active';
  select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'label', x.label, 'upper_kg', x.upper_kg, 'upper_inclusive', x.upper_inclusive)
                            order by x.ord), '[]'::jsonb) into v_desired
  from jsonb_to_recordset(v_layout) as x(ord integer, id uuid, label text, upper_kg numeric, upper_inclusive boolean);
  v_changed := v_current is distinct from v_desired;

  select coalesce(jsonb_agg(jsonb_build_object('key', x.key, 'label', x.label)), '[]'::jsonb) into v_new_bands
  from jsonb_to_recordset(v_layout) as x(key text, label text, is_new boolean) where x.is_new;

  if not v_changed then
    v_impact := jsonb_build_object('pets_measured', 0, 'pets_rebanded', 0, 'by_change', '[]'::jsonb, 'package_conflicts', 0);
  else
    with layout as (
      select x.key, x.upper_kg, x.upper_inclusive
      from jsonb_to_recordset(v_layout) as x(key text, upper_kg numeric, upper_inclusive boolean)),
    measured as (
      select p.id, p.size as old_key, p.weight_kg,
             (select l.key from layout l
              where l.upper_kg is null or p.weight_kg < l.upper_kg or (l.upper_inclusive and p.weight_kg = l.upper_kg)
              order by l.upper_kg nulls last limit 1) as new_key
      from public.pets p
      where p.organization_id = p_org and p.species = 'dog' and p.weight_kg is not null and p.weight_kg > 0 and p.deleted_at is null)
    select count(*), count(*) filter (where m.old_key is distinct from m.new_key),
           coalesce((select jsonb_agg(jsonb_build_object('from', c.old_key, 'to', c.new_key, 'count', c.n) order by c.old_key nulls first, c.new_key)
                     from (select m2.old_key, m2.new_key, count(*) n from measured m2 where m2.old_key is distinct from m2.new_key group by 1, 2) c), '[]'::jsonb),
           (select count(*) from public.customer_packages cp
              join public.packages pk on pk.organization_id = cp.organization_id and pk.id = cp.package_id
              join measured m3 on m3.id = cp.pet_id
             where cp.organization_id = p_org and cp.status = 'active' and cp.deleted_at is null
               and pk.size_band is not null and pk.size_band is distinct from m3.new_key)
      into v_measured, v_rebanded, v_by, v_conflicts
    from measured m;
    v_impact := jsonb_build_object('pets_measured', v_measured, 'pets_rebanded', v_rebanded, 'by_change', v_by, 'package_conflicts', v_conflicts);
  end if;
  return jsonb_build_object('layout', v_layout, 'changed', v_changed, 'new_bands', v_new_bands, 'impact', v_impact);
end $$;

-- Writes a validated plan. Order matters because uq_size_band_open_top is an
-- immediate index while the layout validator is deferred to commit: every band
-- that keeps a finite upper bound is written first (closing the old open band),
-- the band that becomes open-ended is written last.
create function app.size_layout_apply(p_org uuid, p_layout jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare r record; v_pass integer;
begin
  for v_pass in 1..2 loop
    for r in select x.* from jsonb_to_recordset(p_layout) as x(ord integer, id uuid, key text, label text, upper_kg numeric, upper_inclusive boolean, is_new boolean)
             where (v_pass = 1) = (x.upper_kg is not null) order by x.ord loop
      if r.is_new then
        insert into public.organization_size_bands(organization_id, band_key, band_kind, label, sort_order, upper_kg, upper_inclusive, created_by, updated_by)
        values (p_org, r.key, 'dog_weight', r.label, r.ord * 10, r.upper_kg, r.upper_inclusive, app.fn_current_user_id(), app.fn_current_user_id());
      else
        update public.organization_size_bands b
        set label = r.label, sort_order = r.ord * 10, upper_kg = r.upper_kg, upper_inclusive = r.upper_inclusive,
            status = 'active', archived_at = null, archived_by = null, updated_by = app.fn_current_user_id()
        where b.organization_id = p_org and b.id = r.id
          and (b.label, b.sort_order, b.upper_kg, b.upper_inclusive, b.status)
              is distinct from (r.label, r.ord * 10, r.upper_kg, r.upper_inclusive, 'active');
      end if;
    end loop;
  end loop;
end $$;

-- Measured dogs follow the new layout in the same transaction. Only pets whose
-- derived size really changes are touched; booking/invoice/entitlement
-- snapshots are never rewritten.
create function app.size_layout_reband_pets(p_org uuid) returns integer
language plpgsql security definer set search_path = '' as $$
declare v_n integer;
begin
  update public.pets set weight_kg = weight_kg
  where organization_id = p_org and species = 'dog' and weight_kg is not null and deleted_at is null
    and size is distinct from app.dog_size_for_weight(p_org, weight_kg);
  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- ------------------------------------------------------------------- RPCs
create function app.preview_size_layout_impact(p_org uuid, p_bands jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_actor text; v_version integer; v_mode text; v_plan jsonb;
begin
  v_actor := app.size_band_authorize(p_org, 'layout');
  select s.layout_version, s.mode into v_version, v_mode from public.organization_size_band_settings s where s.organization_id = p_org for share;
  if v_mode is distinct from 'dynamic' then
    raise exception 'dynamic_mode_required' using errcode = case when v_actor = 'platform' then '22023' else '42501' end; end if;
  v_plan := app.size_layout_plan(p_org, p_bands);
  return v_plan || jsonb_build_object('layout_version', v_version);
end $$;

create function app.save_size_bands(p_org uuid, p_expected_version integer, p_bands jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_actor text; v_version integer; v_plan jsonb; v_before jsonb; v_rebanded integer;
begin
  v_actor := app.size_band_authorize(p_org, 'layout');
  v_version := app.size_band_lock_settings(p_org, p_expected_version, v_actor, true);
  v_plan := app.size_layout_plan(p_org, p_bands);
  if not (v_plan->>'changed')::boolean then
    return v_plan || jsonb_build_object('layout_version', v_version);
  end if;
  if (v_plan->'impact'->>'package_conflicts')::integer > 0 then
    raise exception 'active_package_size_would_change' using errcode = '23514', detail = (v_plan->'impact')::text; end if;
  v_before := app.size_band_snapshot(p_org);
  perform app.size_layout_apply(p_org, v_plan->'layout');
  v_rebanded := app.size_layout_reband_pets(p_org);
  update public.organization_size_band_settings
  set layout_version = layout_version + 1, updated_by = auth.uid() where organization_id = p_org
  returning layout_version into v_version;
  perform app.size_band_mirror_legacy(p_org);
  perform app.size_band_audit(p_org, 'save_size_bands', v_before, app.size_band_snapshot(p_org) || jsonb_build_object('impact', v_plan->'impact'));
  return v_plan || jsonb_build_object('layout_version', v_version, 'pets_rebanded', v_rebanded);
end $$;

create function app.archive_size_band(p_org uuid, p_expected_version integer, p_band uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_actor text; v_version integer; v_band public.organization_size_bands; v_payload jsonb; v_plan jsonb;
  v_manual integer; v_sellable integer; v_before jsonb; v_rebanded integer; v_top boolean;
begin
  v_actor := app.size_band_authorize(p_org, 'layout');
  v_version := app.size_band_lock_settings(p_org, p_expected_version, v_actor, true);
  select * into v_band from public.organization_size_bands b where b.organization_id = p_org and b.id = p_band;
  if not found then raise exception 'size_band_not_found' using errcode = 'P0002'; end if;
  if v_band.band_kind = 'cat' then raise exception 'size_band_cat_permanent' using errcode = '23514'; end if;
  if v_band.status <> 'active' then raise exception 'size_band_not_active' using errcode = '22023'; end if;
  if (select count(*) from public.organization_size_bands b
      where b.organization_id = p_org and b.band_kind = 'dog_weight' and b.status = 'active') <= 1 then
    raise exception 'last_size_band' using errcode = '22023'; end if;
  select count(*) into v_manual from public.pets p
  where p.organization_id = p_org and p.species = 'dog' and p.weight_kg is null and p.size = v_band.band_key and p.deleted_at is null;
  select count(*) into v_sellable from public.packages k
  where k.organization_id = p_org and k.size_band = v_band.band_key and k.is_active and k.deleted_at is null;
  if v_manual > 0 or v_sellable > 0 then
    raise exception 'size_band_in_use' using errcode = '23514',
      detail = jsonb_build_object('manual_pets', v_manual, 'sellable_packages', v_sellable)::text; end if;
  v_top := v_band.upper_kg is null;
  -- the remaining bands: the next-larger band absorbs the range; archiving the
  -- top band promotes the previous band to open-ended
  select jsonb_agg(jsonb_build_object('id', b.id, 'label', b.label,
           'upper_kg', case when v_top and b.sort_order = (select max(b2.sort_order) from public.organization_size_bands b2
                                                            where b2.organization_id = p_org and b2.band_kind = 'dog_weight' and b2.status = 'active' and b2.id <> p_band)
                            then null else b.upper_kg end,
           'upper_inclusive', case when v_top and b.sort_order = (select max(b2.sort_order) from public.organization_size_bands b2
                                                                   where b2.organization_id = p_org and b2.band_kind = 'dog_weight' and b2.status = 'active' and b2.id <> p_band)
                                   then false else b.upper_inclusive end)
         order by b.sort_order) into v_payload
  from public.organization_size_bands b
  where b.organization_id = p_org and b.band_kind = 'dog_weight' and b.status = 'active' and b.id <> p_band;
  v_plan := app.size_layout_plan(p_org, v_payload, p_band);
  if (v_plan->'impact'->>'package_conflicts')::integer > 0 then
    raise exception 'active_package_size_would_change' using errcode = '23514', detail = (v_plan->'impact')::text; end if;
  v_before := app.size_band_snapshot(p_org);
  update public.organization_size_bands
  set status = 'archived', archived_at = now(), archived_by = app.fn_current_user_id(), updated_by = app.fn_current_user_id()
  where organization_id = p_org and id = p_band;
  perform app.size_layout_apply(p_org, v_plan->'layout');
  v_rebanded := app.size_layout_reband_pets(p_org);
  update public.organization_size_band_settings
  set layout_version = layout_version + 1, updated_by = auth.uid() where organization_id = p_org
  returning layout_version into v_version;
  perform app.size_band_mirror_legacy(p_org);
  perform app.size_band_audit(p_org, 'archive_size_band', v_before, app.size_band_snapshot(p_org) || jsonb_build_object('impact', v_plan->'impact', 'archived', v_band.band_key));
  return jsonb_build_object('layout_version', v_version, 'archived_key', v_band.band_key, 'impact', v_plan->'impact', 'pets_rebanded', v_rebanded);
end $$;

create function app.size_band_references(p_org uuid, p_key text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'pets', (select count(*) from public.pets where organization_id = p_org and size = p_key),
    'packages', (select count(*) from public.packages where organization_id = p_org and size_band = p_key),
    'entitlements', (select count(*) from public.customer_packages where organization_id = p_org and size_band_snapshot = p_key),
    'lines', (select count(*) from public.grooming_job_pet_services where organization_id = p_org and pet_size_snapshot = p_key),
    'payroll', (select count(*) from public.payroll_cycle_settings where organization_id = p_org and coalesce(per_pet_size_matrix_default, '{}'::jsonb) ? p_key)
             + (select count(*) from public.staff_payroll_settings where organization_id = p_org and coalesce(per_pet_size_matrix, '{}'::jsonb) ? p_key),
    'prices', (select count(*) from public.service_band_prices where organization_id = p_org and pricing_key = p_key
               and (price is not null or duration_minutes is not null)));
$$;

create function app.delete_size_band(p_org uuid, p_expected_version integer, p_band uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_actor text; v_version integer; v_band public.organization_size_bands; v_refs jsonb; v_before jsonb;
begin
  v_actor := app.size_band_authorize(p_org, 'layout');
  v_version := app.size_band_lock_settings(p_org, p_expected_version, v_actor, true);
  select * into v_band from public.organization_size_bands b where b.organization_id = p_org and b.id = p_band;
  if not found then raise exception 'size_band_not_found' using errcode = 'P0002'; end if;
  if v_band.band_kind = 'cat' then raise exception 'size_band_cat_permanent' using errcode = '23514'; end if;
  if v_band.status <> 'archived' then raise exception 'size_band_not_archived' using errcode = '22023'; end if;
  v_refs := app.size_band_references(p_org, v_band.band_key);
  if exists (select 1 from jsonb_each_text(v_refs) e where e.value::integer > 0) then
    raise exception 'size_band_in_use' using errcode = '23503', detail = v_refs::text; end if;
  v_before := app.size_band_snapshot(p_org);
  delete from public.service_band_prices where organization_id = p_org and pricing_key = v_band.band_key;
  delete from public.organization_size_bands where organization_id = p_org and id = p_band;
  perform app.size_band_audit(p_org, 'delete_size_band', v_before, app.size_band_snapshot(p_org) || jsonb_build_object('deleted', v_band.band_key));
  return jsonb_build_object('layout_version', v_version, 'deleted_key', v_band.band_key);
end $$;

-- Replaces the full set of band prices/durations of one service. An item is
-- {band_key, price?, duration_minutes?} or {band_key, copy_from} (the server
-- copies the source band's CURRENT stored values). Absent bands and items with
-- no price and no duration fall back to the service base values.
create function app.set_service_band_prices(p_org uuid, p_service uuid, p_expected_version integer, p_prices jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_version integer; v_item jsonb; v_key text; v_src text; v_price numeric; v_dur numeric; v_before jsonb; v_after jsonb;
  v_seen text[] := '{}'; v_rows jsonb := '[]'::jsonb; r record;
begin
  if p_org is null or p_org is distinct from app.fn_active_organization() or not app.has_permission('service.manage') then
    raise exception 'not_authorized' using errcode = '42501'; end if;
  if not exists (select 1 from public.organizations o where o.id = p_org and o.status in ('trial','active') and o.deleted_at is null) then
    raise exception 'organization_unavailable' using errcode = '22023'; end if;
  v_version := app.size_band_lock_settings(p_org, p_expected_version, 'manager', true);
  perform 1 from public.service_catalog s where s.organization_id = p_org and s.id = p_service and s.deleted_at is null for update;
  if not found then raise exception 'service_not_found' using errcode = 'P0002'; end if;
  if jsonb_typeof(p_prices) is distinct from 'array' then raise exception 'invalid_band_prices' using errcode = '22023'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('key', pricing_key, 'price', price, 'duration', duration_minutes) order by pricing_key), '[]'::jsonb)
    into v_before from public.service_band_prices where organization_id = p_org and service_id = p_service;
  for v_item in select value from jsonb_array_elements(p_prices) loop
    if jsonb_typeof(v_item) is distinct from 'object' or jsonb_typeof(v_item->'band_key') is distinct from 'string' then
      raise exception 'invalid_band_prices' using errcode = '22023'; end if;
    v_key := v_item->>'band_key';
    if v_key = any (v_seen) or not exists (select 1 from public.organization_size_bands b
         where b.organization_id = p_org and b.band_key = v_key and b.status = 'active') then
      raise exception 'invalid_band_prices' using errcode = '22023', detail = 'band'; end if;
    v_seen := v_seen || v_key;
    v_price := null; v_dur := null;
    if v_item ? 'copy_from' then
      v_src := v_item->>'copy_from';
      select p.price, p.duration_minutes into v_price, v_dur from public.service_band_prices p
      where p.organization_id = p_org and p.service_id = p_service and p.pricing_key = v_src;
      if not found then raise exception 'copy_source_empty' using errcode = '22023'; end if;
    else
      begin
        v_price := case when jsonb_typeof(v_item->'price') = 'number' then (v_item->>'price')::numeric end;
        v_dur := case when jsonb_typeof(v_item->'duration_minutes') = 'number' then (v_item->>'duration_minutes')::numeric end;
      exception when others then raise exception 'invalid_band_prices' using errcode = '22023'; end;
      if (v_item ? 'price' and jsonb_typeof(v_item->'price') not in ('number','null'))
         or (v_item ? 'duration_minutes' and jsonb_typeof(v_item->'duration_minutes') not in ('number','null')) then
        raise exception 'invalid_band_prices' using errcode = '22023'; end if;
    end if;
    if (v_price is not null and (v_price < 0 or v_price > 999999999 or v_price <> round(v_price, 2)))
       or (v_dur is not null and (v_dur < 0 or v_dur > 1440 or v_dur <> trunc(v_dur))) then
      raise exception 'invalid_band_prices' using errcode = '22023', detail = 'range'; end if;
    v_rows := v_rows || jsonb_build_array(jsonb_build_object('key', v_key, 'price', v_price, 'duration', v_dur::integer));
  end loop;
  delete from public.service_band_prices p
  where p.organization_id = p_org and p.service_id = p_service
    and p.pricing_key <> all (coalesce((select array_agg(x.key) from jsonb_to_recordset(v_rows) as x(key text, price numeric, duration integer)
                                         where x.price is not null or x.duration is not null), '{}'));
  for r in select * from jsonb_to_recordset(v_rows) as x(key text, price numeric, duration integer) where x.price is not null or x.duration is not null loop
    insert into public.service_band_prices(organization_id, service_id, pricing_key, price, duration_minutes, updated_by)
    values (p_org, p_service, r.key, r.price, r.duration, app.fn_current_user_id())
    on conflict (organization_id, service_id, pricing_key) do update
      set price = excluded.price, duration_minutes = excluded.duration_minutes, updated_by = excluded.updated_by
      where (service_band_prices.price, service_band_prices.duration_minutes) is distinct from (excluded.price, excluded.duration_minutes);
  end loop;
  perform app.size_band_mirror_legacy(p_org, p_service);
  select coalesce(jsonb_agg(jsonb_build_object('key', pricing_key, 'price', price, 'duration', duration_minutes) order by pricing_key), '[]'::jsonb)
    into v_after from public.service_band_prices where organization_id = p_org and service_id = p_service;
  if v_before is distinct from v_after then
    perform app.size_band_audit(p_org, 'set_service_band_prices', jsonb_build_object('service_id', p_service, 'rows', v_before),
                                jsonb_build_object('service_id', p_service, 'rows', v_after));
  end if;
  return jsonb_build_object('layout_version', v_version, 'rows', v_after);
end $$;

create function app.set_size_band_mode(p_org uuid, p_mode text, p_expected_version integer) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_actor text; v_version integer; v_current text; v_before jsonb;
begin
  v_actor := app.size_band_authorize(p_org, 'mode');
  if p_mode is null or p_mode not in ('legacy','dynamic') then
    raise exception 'invalid_mode' using errcode = '22023'; end if;
  v_version := app.size_band_lock_settings(p_org, p_expected_version, v_actor, false);
  select s.mode into v_current from public.organization_size_band_settings s where s.organization_id = p_org;
  if v_current = p_mode then
    return jsonb_build_object('layout_version', v_version, 'mode', v_current, 'changed', false); end if;
  v_before := app.size_band_snapshot(p_org);
  if p_mode = 'legacy' then
    if not app.size_layout_is_legacy_five(p_org) then
      raise exception 'rollback_blocked_custom_bands' using errcode = '22023'; end if;
    -- re-sync the authoritative legacy writers before handing control back
    perform app.size_band_mirror_legacy(p_org);
  end if;
  update public.organization_size_band_settings
  set mode = p_mode, layout_version = layout_version + 1, updated_by = auth.uid() where organization_id = p_org
  returning layout_version into v_version;
  perform app.size_band_audit(p_org, 'set_size_band_mode', v_before, app.size_band_snapshot(p_org));
  return jsonb_build_object('layout_version', v_version, 'mode', p_mode, 'changed', true);
end $$;

-- ------------------------------------------------ compatibility wrapper
-- Same signature, grants and error codes. Legacy mode behaves exactly as before
-- (plus the shadow sync from Bundle 1); dynamic mode may translate only a
-- layout that is still the legacy five.
create or replace function app.set_dog_size_boundaries(p_org uuid,p_xs numeric,p_s numeric,p_m numeric,p_l numeric)
returns void language plpgsql security definer set search_path = '' as $$
declare v_mode text; v_version integer; v_payload jsonb;
begin
  if not app.is_business_owner(p_org)
     or (app.is_operro_owner() and p_org is distinct from app.fn_active_organization()) then
    raise exception 'not_authorized' using errcode='42501'; end if;
  if p_xs is null or p_s is null or p_m is null or p_l is null
    or not (p_xs>0 and p_xs<p_s and p_s<p_m and p_m<p_l and p_l<=999)
  then raise exception 'invalid_boundaries' using errcode='22023'; end if;
  perform 1 from public.organizations where id=p_org and status in ('trial','active') for update;
  if not found then raise exception 'organization_unavailable' using errcode='22023'; end if;
  select s.mode, s.layout_version into v_mode, v_version
  from public.organization_size_band_settings s where s.organization_id = p_org for update;
  if v_mode = 'dynamic' then
    if not app.size_layout_is_legacy_five(p_org) then
      raise exception 'use_size_band_editor' using errcode = '22023'; end if;
    select jsonb_agg(jsonb_build_object('id', b.id, 'label', b.label,
             'upper_kg', case b.band_key when 'extra_small' then p_xs when 'small' then p_s when 'medium' then p_m when 'large' then p_l end,
             'upper_inclusive', b.upper_inclusive) order by b.sort_order) into v_payload
    from public.organization_size_bands b
    where b.organization_id = p_org and b.band_kind = 'dog_weight' and b.status = 'active';
    perform app.save_size_bands(p_org, v_version, v_payload);
    return;
  end if;
  -- A sold active size-specific package must never silently become unusable.
  if exists (
    select 1 from public.customer_packages cp
    join public.packages pkg on pkg.id=cp.package_id and pkg.organization_id=cp.organization_id
    join public.pets pet on pet.id=cp.pet_id and pet.organization_id=cp.organization_id
    where cp.organization_id=p_org and cp.status='active' and cp.deleted_at is null
      and pkg.size_band is not null and pet.species='dog' and pet.weight_kg is not null
      and pkg.size_band is distinct from case
        when pet.weight_kg<p_xs then 'extra_small' when pet.weight_kg<p_s then 'small'
        when pet.weight_kg<p_m then 'medium' when pet.weight_kg<=p_l then 'large' else 'extra_large' end
  ) then raise exception 'active_package_size_would_change' using errcode='23514'; end if;
  insert into public.organization_dog_size_boundaries(organization_id,xs_lt_kg,s_lt_kg,m_lt_kg,l_lte_kg,updated_at,updated_by)
  values(p_org,p_xs,p_s,p_m,p_l,now(),auth.uid())
  on conflict (organization_id) do update set xs_lt_kg=excluded.xs_lt_kg,s_lt_kg=excluded.s_lt_kg,
    m_lt_kg=excluded.m_lt_kg,l_lte_kg=excluded.l_lte_kg,updated_at=excluded.updated_at,updated_by=excluded.updated_by;
  -- Trigger recomputes authoritative size for every measured dog; historical
  -- invoice/job snapshots remain unchanged.
  update public.pets set weight_kg=weight_kg
    where organization_id=p_org and species='dog' and weight_kg is not null and deleted_at is null;
end;
$$;

-- --------------------- package guards: serialize with layout writers
-- Identical rules and errors to 20261023120000, plus the layout lock as the
-- FIRST statement so sale/renewal cannot interleave with a layout change.
create or replace function app.tg_homepaw_package_pet_band() returns trigger
language plpgsql security definer set search_path=pg_catalog as $$
declare v_band text; v_species text; v_size text; v_weight numeric; v_per_pet boolean; v_pkg_band text;
begin
  perform app.size_layout_lock(new.organization_id);
  select size_band, per_pet into v_pkg_band, v_per_pet from public.packages
  where id=new.package_id and organization_id=new.organization_id for share;
  if v_pkg_band is null then return new; end if;
  if not v_per_pet or new.pet_id is null then
    raise exception 'pet_required_for_size_package' using errcode='22023';
  end if;
  select species,size,weight_kg into v_species,v_size,v_weight from public.pets
  where id=new.pet_id and organization_id=new.organization_id and customer_id=new.customer_id and deleted_at is null for share;
  if not found then raise exception 'pet_not_found_for_customer' using errcode='P0002'; end if;
  v_band := case when v_species in ('dog','cat')
    then app.pet_pricing_key(new.organization_id, v_species, v_weight, v_size) else null end;
  if v_band is distinct from v_pkg_band then
    raise exception 'package_size_mismatch' using errcode='22023';
  end if;
  new.size_band_snapshot := v_pkg_band;
  new.size_label_snapshot := (select b.label from public.organization_size_bands b
    where b.organization_id=new.organization_id and b.band_key=v_pkg_band);
  return new;
end $$;

create or replace function app.tg_homepaw_renewal_pet_band() returns trigger
language plpgsql security definer set search_path=pg_catalog as $$
declare v_band text; v_pkg_band text; v_species text; v_size text; v_weight numeric;
begin
  if new.reason <> 'renewal' then return new; end if;
  perform app.size_layout_lock(new.organization_id);
  select pkg.size_band, pet.species, pet.size, pet.weight_kg
    into v_pkg_band, v_species, v_size, v_weight
  from public.customer_packages cp
  join public.packages pkg on pkg.id=cp.package_id and pkg.organization_id=cp.organization_id
  left join public.pets pet on pet.id=cp.pet_id and pet.organization_id=cp.organization_id
  where cp.id=new.customer_package_id and cp.organization_id=new.organization_id;
  if v_pkg_band is null then return new; end if;
  v_band := case when v_species in ('dog','cat')
    then app.pet_pricing_key(new.organization_id, v_species, v_weight, v_size) else null end;
  if v_band is distinct from v_pkg_band then
    raise exception 'package_size_mismatch_on_renewal' using errcode='22023';
  end if;
  return new;
end $$;

-- --------------------------------------------------------------- grants
-- Internals are not callable by any client role. The six management RPCs are
-- granted to authenticated only (anon and PUBLIC revoked); each re-derives the
-- caller's authority server-side.
revoke all on function app.size_band_slug(text), app.size_band_new_key(uuid,text,text[]), app.size_band_snapshot(uuid),
  app.size_band_audit(uuid,text,jsonb,jsonb), app.size_layout_is_legacy_five(uuid), app.size_band_mirror_legacy(uuid,uuid),
  app.size_band_authorize(uuid,text), app.size_band_lock_settings(uuid,integer,text,boolean), app.size_layout_plan(uuid,jsonb,uuid),
  app.size_layout_apply(uuid,jsonb), app.size_layout_reband_pets(uuid), app.size_band_references(uuid,text)
  from public, anon, authenticated;
revoke all on function app.preview_size_layout_impact(uuid,jsonb), app.save_size_bands(uuid,integer,jsonb),
  app.archive_size_band(uuid,integer,uuid), app.delete_size_band(uuid,integer,uuid),
  app.set_service_band_prices(uuid,uuid,integer,jsonb), app.set_size_band_mode(uuid,text,integer) from public, anon, authenticated;
grant execute on function app.preview_size_layout_impact(uuid,jsonb), app.save_size_bands(uuid,integer,jsonb),
  app.archive_size_band(uuid,integer,uuid), app.delete_size_band(uuid,integer,uuid),
  app.set_service_band_prices(uuid,uuid,integer,jsonb), app.set_size_band_mode(uuid,text,integer) to authenticated;

commit;
