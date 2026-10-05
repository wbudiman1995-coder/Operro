-- Dynamic tenant-owned size bands, part 3 (SB-03): one authoritative resolver.
-- In `legacy` mode every result is identical to the definitions in
-- 20261019110000/20261020120000: weight maps through organization_dog_size_boundaries
-- (large is `<= l_lte_kg`) and prices/durations come from the 12 legacy catalog
-- columns. In `dynamic` mode weight maps through organization_size_bands and
-- prices come from service_band_prices. Public signatures, grants, SQLSTATEs and
-- error codes of assembly_add_line and the package guards are unchanged.
begin;

-- Weight -> active dog band key.
create or replace function app.dog_size_for_weight(p_org uuid, p_weight numeric) returns text
language plpgsql stable security definer set search_path = '' as $$
declare v_xs numeric := 5; v_s numeric := 10; v_m numeric := 15; v_l numeric := 25;
        v_mode text; v_key text;
begin
  if p_weight is null or p_weight<=0 then return null; end if;
  select s.mode into v_mode from public.organization_size_band_settings s where s.organization_id = p_org;
  if v_mode = 'dynamic' then
    select b.band_key into v_key
    from public.organization_size_bands b
    where b.organization_id = p_org and b.band_kind = 'dog_weight' and b.status = 'active'
      and (b.upper_kg is null or p_weight < b.upper_kg or (b.upper_inclusive and p_weight = b.upper_kg))
    order by b.upper_kg nulls last
    limit 1;
    return v_key;
  end if;
  select xs_lt_kg,s_lt_kg,m_lt_kg,l_lte_kg into v_xs,v_s,v_m,v_l
    from public.organization_dog_size_boundaries where organization_id=p_org;
  if not found then v_xs:=5; v_s:=10; v_m:=15; v_l:=25; end if;
  return case when p_weight<v_xs then 'extra_small' when p_weight<v_s then 'small'
    when p_weight<v_m then 'medium' when p_weight<=v_l then 'large' else 'extra_large' end;
end;
$$;

-- Serializes pricing against layout changes: layout writers (later RPCs) take
-- the settings row FOR UPDATE, line pricing takes it FOR SHARE.
create function app.size_layout_lock(p_org uuid) returns integer
language plpgsql security definer set search_path = '' as $$
declare v_version integer;
begin
  select s.layout_version into v_version
  from public.organization_size_band_settings s where s.organization_id = p_org for share;
  return v_version;
end $$;

-- Pet -> pricing key. Cats are the `cat` band, dogs resolve by weight (weight
-- wins over a stale stored size) and fall back to a stored size only when it is
-- an active dog band, any other species prices under its own species key.
create function app.pet_pricing_key(p_org uuid, p_species text, p_weight numeric, p_stored_size text)
returns text language plpgsql stable security definer set search_path = '' as $$
declare v_key text;
begin
  if p_species = 'cat' then return 'cat'; end if;
  if p_species = 'dog' then
    v_key := app.dog_size_for_weight(p_org, p_weight);
    if v_key is not null then return v_key; end if;
    if p_stored_size is not null and exists (
         select 1 from public.organization_size_bands b
         where b.organization_id = p_org and b.band_key = p_stored_size
           and b.band_kind = 'dog_weight' and b.status = 'active') then
      return p_stored_size;
    end if;
    return null;
  end if;
  return p_species;
end $$;

-- Catalog price + duration for one pet/service/quantity. Internal: takes an
-- organization id, so it is never granted to client roles.
create function app.resolve_service_line(
  p_org uuid, p_service uuid, p_species text, p_weight numeric, p_stored_size text, p_quantity integer)
returns table (pricing_key text, unit_price numeric, duration integer, price_source text,
               size_label text, layout_version integer, service_name text, currency text)
language plpgsql stable security definer set search_path = '' as $$
declare sc record; v_mode text; v_size_price numeric; v_size_dur integer;
begin
  select s.mode, s.layout_version into v_mode, layout_version
  from public.organization_size_band_settings s where s.organization_id = p_org;
  v_mode := coalesce(v_mode, 'legacy');

  select c.* into sc from public.service_catalog c
  where c.organization_id = p_org and c.id = p_service and c.is_active = true and c.deleted_at is null;
  if not found then
    raise exception 'service_not_active_or_not_in_org' using errcode = 'check_violation'; end if;

  pricing_key := app.pet_pricing_key(p_org, p_species, p_weight, p_stored_size);

  if p_species in ('dog','cat') then
    if v_mode = 'dynamic' then
      select sbp.price, sbp.duration_minutes into v_size_price, v_size_dur
      from public.service_band_prices sbp
      where sbp.organization_id = p_org and sbp.service_id = p_service and sbp.pricing_key = resolve_service_line.pricing_key;
    else
      v_size_price := case pricing_key
        when 'extra_small' then sc.price_extra_small when 'small' then sc.price_small
        when 'medium' then sc.price_medium when 'large' then sc.price_large
        when 'extra_large' then sc.price_extra_large when 'cat' then sc.price_cat else null end;
      v_size_dur := case pricing_key
        when 'extra_small' then sc.duration_extra_small when 'small' then sc.duration_small
        when 'medium' then sc.duration_medium when 'large' then sc.duration_large
        when 'extra_large' then sc.duration_extra_large when 'cat' then sc.duration_cat else null end;
    end if;
  else
    v_size_price := (sc.species_pricing->p_species->>'price')::numeric;
    v_size_dur := (sc.species_pricing->p_species->>'duration')::integer;
    if p_species is not null and v_size_price is null then
      raise exception 'species_price_not_configured' using errcode = '22023'; end if;
  end if;

  -- Size price wins only when one is defined for this pet's key; otherwise
  -- base_price, exactly as before. Duration: coalesce keeps an explicit 0
  -- (zero-minute add-ons) and only defaults when NULL; additional minutes add
  -- only for units beyond the first.
  if pricing_key is not null and v_size_price is not null then
    unit_price := v_size_price; price_source := 'size_matrix';
  else
    unit_price := coalesce(sc.base_price, 0); price_source := 'base';
  end if;
  duration := coalesce(v_size_dur, sc.duration_minutes, 60)
              + coalesce(sc.additional_duration_minutes, 0) * greatest(p_quantity - 1, 0);
  size_label := case
    when pricing_key is null then null
    when p_species in ('dog','cat') then
      (select b.label from public.organization_size_bands b where b.organization_id = p_org and b.band_key = resolve_service_line.pricing_key)
    else (select t.label from public.organization_pet_types t where t.organization_id = p_org and t.key = resolve_service_line.pricing_key)
  end;
  service_name := sc.name;
  currency := sc.currency;
  return next;
end $$;

revoke all on function app.size_layout_lock(uuid), app.pet_pricing_key(uuid,text,numeric,text),
  app.resolve_service_line(uuid,uuid,text,numeric,text,integer) from public, anon, authenticated;
revoke all on function app.dog_size_for_weight(uuid,numeric) from public;

create or replace function app.assembly_add_line(p_pet uuid, p_service uuid, p_quantity integer default 1)
returns uuid security definer set search_path = app, public language plpgsql as $$
declare gjp record; b public.bookings; v_job uuid; v_id uuid;
        v_pet_species text; v_pet_size text; v_pet_weight numeric; r record;
begin
  if p_quantity is null or p_quantity < 1 then
    raise exception 'quantity_must_be_positive' using errcode = 'check_violation'; end if;
  select grooming_job_id into v_job from public.grooming_job_pets where id = p_pet;
  if not found then raise exception 'pet_not_found' using errcode = 'no_data_found'; end if;
  b := app.assembly_guard(v_job);
  select * into gjp from public.grooming_job_pets where id = p_pet for update;
  if not found or gjp.deleted_at is not null then
    raise exception 'pet_not_found' using errcode = 'no_data_found'; end if;

  select pt.species, pt.size, pt.weight_kg into v_pet_species, v_pet_size, v_pet_weight
  from public.pets pt where pt.organization_id = gjp.organization_id and pt.id = gjp.pet_id;

  perform app.size_layout_lock(gjp.organization_id);
  select * into r from app.resolve_service_line(
    gjp.organization_id, p_service, v_pet_species, v_pet_weight, v_pet_size, p_quantity);

  insert into public.grooming_job_pet_services
    (organization_id, grooming_job_pet_id, service_id, service_name_snapshot,
     unit_price_snapshot, currency, quantity, duration_minutes,
     pet_size_snapshot, price_source,
     pet_size_label_snapshot, pet_weight_kg_snapshot, size_layout_version_snapshot)
  values (gjp.organization_id, gjp.id, p_service, coalesce(r.service_name,'Service'),
          r.unit_price, coalesce(r.currency,'USD'), p_quantity, r.duration,
          r.pricing_key, r.price_source,
          r.size_label, case when v_pet_weight > 0 then v_pet_weight end, r.layout_version)
  returning id into v_id;
  perform app.assembly_audit(gjp.organization_id, gjp.grooming_job_id, 'grooming.line_added',
    jsonb_build_object('grooming_job_pet_service_id', v_id, 'service_id', p_service,
                       'quantity', p_quantity, 'unit_price_snapshot', r.unit_price,
                       'duration_minutes', r.duration, 'pet_size', r.pricing_key,
                       'price_source', r.price_source, 'pet_size_label', r.size_label));
  return v_id;
end; $$;

-- Package sale/renewal guards: same rules and error codes, now keyed through
-- the resolver. Sold-package snapshots are recorded on the new entitlement.
create or replace function app.tg_homepaw_package_pet_band() returns trigger
language plpgsql security definer set search_path=pg_catalog as $$
declare v_band text; v_species text; v_size text; v_weight numeric; v_per_pet boolean; v_pkg_band text;
begin
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

commit;
