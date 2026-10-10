-- E1.3 Pet coat profile and derived visit count (parity #4).
--
-- Adds only the structured grooming fields the HomePaw dog form actually has: coat type
-- (Short / Long / Curly / Double coat) and skin history. Coat colour is the existing
-- pets.color. The "visit/wash count" is NEVER stored: app.pet_visit_stats derives it on
-- demand from authoritative completed work (completed bookings that include the pet, plus
-- off-books manual visits reported separately), so a pet edit can neither inflate nor
-- reset it. Booking, invoice, evidence and snapshot tables are not touched.
begin;

alter table public.pets
  add column coat_type text,
  add column skin_history text,
  add constraint chk_pets_coat_type check (coat_type is null or coat_type in ('short','long','curly','double_coat')),
  add constraint chk_pets_skin_history_len check (skin_history is null or length(skin_history) between 1 and 1000);

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
  p_notes text,
  p_coat_type text,
  p_skin_history text
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
  v_coat text := nullif(btrim(coalesce(p_coat_type, '')), '');
  v_skin text := nullif(btrim(coalesce(p_skin_history, '')), '');
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
     or length(coalesce(v_notes, '')) > 1000
     or (v_coat is not null and v_coat not in ('short', 'long', 'curly', 'double_coat'))
     or length(coalesce(v_skin, '')) > 1000 then
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
      notes = v_notes,
      coat_type = v_coat,
      skin_history = v_skin
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
  uuid, uuid, timestamptz, text, text, text, text, date, numeric, text, text, text, text, text, text
) from public, anon, authenticated;
grant execute on function app.update_customer_pet(
  uuid, uuid, timestamptz, text, text, text, text, date, numeric, text, text, text, text, text, text
) to authenticated;

-- The 13-argument signature from 20261026100000 stays callable and now preserves the stored
-- coat profile instead of ignoring it, so existing callers cannot wipe the new fields.
create or replace function app.update_customer_pet(
  p_pet uuid, p_customer uuid, p_expected_updated_at timestamptz, p_name text, p_species text, p_breed text,
  p_sex text, p_birthdate date, p_weight_kg numeric, p_manual_size text, p_color text, p_temperament text, p_notes text
)
returns table (pet_id uuid, updated_at timestamptz, stored_size text, size_label text)
language plpgsql
security definer
set search_path = ''
as $$
declare v_coat text; v_skin text;
begin
  select p.coat_type, p.skin_history into v_coat, v_skin
    from public.pets p where p.organization_id = app.fn_active_organization() and p.id = p_pet;
  return query select * from app.update_customer_pet(
    p_pet, p_customer, p_expected_updated_at, p_name, p_species, p_breed, p_sex, p_birthdate,
    p_weight_kg, p_manual_size, p_color, p_temperament, p_notes, v_coat, v_skin);
end;
$$;
revoke all on function app.update_customer_pet(
  uuid, uuid, timestamptz, text, text, text, text, date, numeric, text, text, text, text
) from public, anon, authenticated;
grant execute on function app.update_customer_pet(
  uuid, uuid, timestamptz, text, text, text, text, date, numeric, text, text, text, text
) to authenticated;

-- ---------------------------------------------------------------------------
-- Derived counts. SECURITY DEFINER so a user with customer.read but without
-- booking.read gets the true number rather than an RLS-filtered zero; it exposes
-- only aggregates, only for pets of the caller's active organization, max 100 pets.
--  completed_jobs  : distinct bookings in status 'completed' (not deleted) that include
--                    the pet and where the pet's job line is neither deleted nor skipped
--  manual_visits   : off-books visits recorded for the pet (never double counted with bookings)
--  last_visit_at   : latest completed booking start or manual visit
-- Cancelled, no-show, draft, requested, confirmed and in-progress work never counts.
-- ---------------------------------------------------------------------------
create function app.pet_visit_stats(p_pet_ids uuid[])
returns table (pet_id uuid, completed_jobs integer, manual_visits integer, last_visit_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare v_org uuid := app.fn_active_organization();
begin
  if v_org is null or not app.has_membership() or not app.has_module('crm')
     or not app.has_permission('customer.read') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_pet_ids is null or coalesce(array_length(p_pet_ids, 1), 0) > 100 then
    raise exception 'invalid_pet_ids' using errcode = '22023';
  end if;

  return query
  with wanted as (
    select p.id from public.pets p where p.organization_id = v_org and p.id = any (p_pet_ids)
  ), jobs as (
    select g.pet_id as pid, b.id as bid, b.starts_at
      from public.grooming_job_pets g
      join public.bookings b on b.organization_id = g.organization_id and b.id = g.grooming_job_id
     where g.organization_id = v_org and g.pet_id = any (p_pet_ids)
       and g.deleted_at is null and g.status <> 'skipped'
       and b.status = 'completed' and b.deleted_at is null
  ), manual as (
    select m.pet_id as pid, m.id, m.visit_at
      from public.manual_visits m
     where m.organization_id = v_org and m.pet_id = any (p_pet_ids) and m.deleted_at is null
  )
  select w.id,
         (select count(*)::integer from jobs j where j.pid = w.id),
         (select count(*)::integer from manual m where m.pid = w.id),
         greatest((select max(j.starts_at) from jobs j where j.pid = w.id),
                  (select max(m.visit_at) from manual m where m.pid = w.id))
    from wanted w;
end;
$$;
revoke all on function app.pet_visit_stats(uuid[]) from public, anon, authenticated;
grant execute on function app.pet_visit_stats(uuid[]) to authenticated;

-- Make the new RPCs visible to PostgREST without waiting for its schema-cache refresh.
notify pgrst, 'reload schema';
commit;
