-- Customer 360 standalone pet editing.
--
-- The caller supplies only the pet/customer references, an optimistic version,
-- and editable pet facts. The active organization comes from the authenticated
-- session. Dog sizing remains authoritative in trg_homepaw_pet_size_from_weight:
-- a positive weight always replaces the submitted manual band, while a
-- weightless dog may keep an active manual band from this tenant's layout.
begin;

create function app.update_customer_pet(
  p_pet uuid,
  p_customer uuid,
  p_expected_updated_at timestamptz,
  p_name text,
  p_species text,
  p_breed text,
  p_sex text,
  p_birthdate date,
  p_weight_kg numeric,
  p_manual_size text,
  p_color text,
  p_temperament text,
  p_notes text
)
returns table (pet_id uuid, updated_at timestamptz, stored_size text, size_label text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := app.fn_active_organization();
  v_pet public.pets;
  v_name text := btrim(coalesce(p_name, ''));
  v_breed text := nullif(btrim(coalesce(p_breed, '')), '');
  v_size text := nullif(btrim(coalesce(p_manual_size, '')), '');
  v_color text := nullif(btrim(coalesce(p_color, '')), '');
  v_temperament text := nullif(btrim(coalesce(p_temperament, '')), '');
  v_notes text := nullif(btrim(coalesce(p_notes, '')), '');
begin
  if v_org is null or not app.has_membership() or not app.has_module('crm')
     or not app.has_permission('customer.manage') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_pet is null or p_customer is null or p_expected_updated_at is null then
    raise exception 'invalid_pet' using errcode = '22023';
  end if;

  -- Match the established writer lock order: layout first, pet second. This
  -- avoids deadlocking save_size_bands, which locks settings before re-banding.
  perform app.size_layout_lock(v_org);

  select p.* into v_pet
  from public.pets p
  join public.customers c
    on c.organization_id = p.organization_id and c.id = p.customer_id
  where p.organization_id = v_org
    and p.id = p_pet
    and p.customer_id = p_customer
    and p.deleted_at is null
    and c.deleted_at is null
  for update of p;
  if not found then raise exception 'pet_not_found' using errcode = 'P0002'; end if;
  if v_pet.updated_at is distinct from p_expected_updated_at then
    raise exception 'stale_pet' using errcode = '40001';
  end if;

  if length(v_name) not between 1 and 80
     or p_species is null
     or not exists (
       select 1 from public.organization_pet_types t
       where t.organization_id = v_org and t.key = p_species and t.is_active
     )
     or p_sex not in ('male', 'female', 'unknown')
     or (p_birthdate is not null and p_birthdate > current_date)
     or (p_weight_kg is not null and (
       p_weight_kg <= 0 or p_weight_kg > 999 or p_weight_kg <> round(p_weight_kg, 2)
     ))
     or length(coalesce(v_breed, '')) > 100
     or length(coalesce(v_color, '')) > 80
     or length(coalesce(v_temperament, '')) > 120
     or length(coalesce(v_notes, '')) > 1000 then
    raise exception 'invalid_pet' using errcode = '22023';
  end if;

  if p_species = 'dog' then
    if v_size is not null and not exists (
      select 1 from public.organization_size_bands b
      where b.organization_id = v_org
        and b.band_key = v_size
        and b.band_kind = 'dog_weight'
        and b.status = 'active'
    ) then
      raise exception 'invalid_pet_size' using errcode = '22023';
    end if;
  elsif v_size is not null then
    raise exception 'invalid_pet_size' using errcode = '22023';
  end if;

  update public.pets p
  set name = v_name,
      species = p_species,
      breed = v_breed,
      sex = p_sex,
      birthdate = p_birthdate,
      weight_kg = p_weight_kg,
      size = v_size,
      color = v_color,
      temperament = v_temperament,
      notes = v_notes
  where p.organization_id = v_org and p.id = v_pet.id;

  return query
  select p.id, p.updated_at, p.size, b.label
  from public.pets p
  left join public.organization_size_bands b
    on b.organization_id = p.organization_id and b.band_key = p.size
  where p.organization_id = v_org and p.id = v_pet.id;
end;
$$;

revoke all on function app.update_customer_pet(
  uuid, uuid, timestamptz, text, text, text, text, date, numeric, text, text, text, text
) from public, anon, authenticated;
grant execute on function app.update_customer_pet(
  uuid, uuid, timestamptz, text, text, text, text, date, numeric, text, text, text, text
) to authenticated;

commit;
