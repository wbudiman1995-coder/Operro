-- Dynamic tenant-owned size bands, part 1 (SB-01): foundation tables.
-- Nothing here changes pricing, booking, package, or payroll behavior. Every
-- organization (including soft-deleted ones, so historical references stay
-- resolvable) receives the five legacy bands plus the permanent `cat`
-- pseudo-band, copied verbatim from its current dog-size boundaries.
begin;

-- A pet type whose key equals a legacy size key would be ambiguous as a
-- pricing key. Report instead of guessing; no data is rewritten.
do $$
declare v_bad text;
begin
  select string_agg(t.organization_id::text || ':' || t.key, ', ') into v_bad
  from (select organization_id, key from public.organization_pet_types
        where key in ('extra_small','small','medium','large','extra_large')
        order by organization_id, key limit 20) t;
  if v_bad is not null then
    raise exception 'size_band_preflight_failed: pet type keys collide with legacy size keys (organization:key) %', v_bad
      using errcode = '22023';
  end if;
end $$;

create table public.organization_size_band_settings (
  organization_id uuid primary key references public.organizations(id),
  mode text not null default 'legacy' check (mode in ('legacy','dynamic')),
  layout_version integer not null default 1 check (layout_version >= 1),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id)
);

create table public.organization_size_bands (
  id uuid primary key default app.fn_uuid_v7(),
  organization_id uuid not null references public.organizations(id),
  band_key text not null check (band_key ~ '^[a-z][a-z0-9_]{1,29}$'),
  band_kind text not null default 'dog_weight' check (band_kind in ('dog_weight','cat')),
  label text not null check (length(btrim(label)) between 1 and 40),
  sort_order integer not null check (sort_order >= 0),
  upper_kg numeric(6,2) check (upper_kg > 0 and upper_kg <= 999),
  upper_inclusive boolean not null default false,
  status text not null default 'active' check (status in ('active','archived')),
  archived_at timestamptz,
  archived_by uuid,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  constraint uq_size_bands_org_key unique (organization_id, band_key),
  constraint uq_size_bands_org_id unique (organization_id, id),
  constraint chk_size_bands_cat check (band_kind <> 'cat'
    or (band_key = 'cat' and upper_kg is null and not upper_inclusive and status = 'active')),
  constraint chk_size_bands_inclusive_needs_upper check (upper_kg is not null or not upper_inclusive),
  constraint chk_size_bands_archive_stamp check ((status = 'archived') = (archived_at is not null))
);
-- At most one open-ended active dog band; the deferred layout validator below
-- supplies the "at least one" half, which no partial index can express.
create unique index uq_size_band_open_top on public.organization_size_bands (organization_id)
  where band_kind = 'dog_weight' and status = 'active' and upper_kg is null;

create trigger trg_size_band_settings_updated_at before update on public.organization_size_band_settings
  for each row execute function app.tg_set_updated_at();
create trigger trg_size_bands_updated_at before update on public.organization_size_bands
  for each row execute function app.tg_set_updated_at();

-- Keys are permanent identifiers: historical snapshots, packages and payroll
-- matrices refer to them. Labels are the only owner-editable name.
create function app.tg_size_band_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' then
    if new.band_key is distinct from old.band_key then
      raise exception 'size_band_key_immutable' using errcode = '23514'; end if;
    if new.organization_id is distinct from old.organization_id
       or new.band_kind is distinct from old.band_kind then
      raise exception 'size_band_identity_immutable' using errcode = '23514'; end if;
  end if;
  if new.band_kind = 'dog_weight' and (
       new.band_key in ('dog','cat')
       or exists (select 1 from public.organization_pet_types t
                  where t.organization_id = new.organization_id and t.key = new.band_key)) then
    raise exception 'size_band_key_reserved' using errcode = '22023';
  end if;
  return new;
end $$;
create trigger trg_size_band_guard before insert or update on public.organization_size_bands
  for each row execute function app.tg_size_band_guard();

create function app.tg_size_band_cat_permanent() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if old.band_kind = 'cat' then
    raise exception 'size_band_cat_permanent' using errcode = '23514'; end if;
  return old;
end $$;
create trigger trg_size_band_cat_permanent before delete on public.organization_size_bands
  for each row execute function app.tg_size_band_cat_permanent();

-- A custom species must not take a key that is already a dog size band.
create function app.tg_pet_type_not_size_band() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.organization_size_bands b
             where b.organization_id = new.organization_id and b.band_key = new.key
               and b.band_kind = 'dog_weight') then
    raise exception 'pet_type_key_is_size_band' using errcode = '22023'; end if;
  return new;
end $$;
create trigger trg_pet_type_not_size_band before insert or update of key on public.organization_pet_types
  for each row execute function app.tg_pet_type_not_size_band();

-- Layout invariants (full contiguous partition), checked at commit so a
-- multi-row layout change may pass through intermediate states.
create function app.validate_size_band_layout(p_org uuid) returns void
language plpgsql stable security definer set search_path = '' as $$
declare v_n integer; v_open integer; v_cats integer;
begin
  if not exists (select 1 from public.organizations where id = p_org) then return; end if;
  select count(*), count(*) filter (where upper_kg is null) into v_n, v_open
  from public.organization_size_bands
  where organization_id = p_org and band_kind = 'dog_weight' and status = 'active';
  if v_n not between 1 and 12 then
    raise exception 'size_band_layout_invalid: % active dog bands (1 to 12 required)', v_n using errcode = '23514'; end if;
  if v_open <> 1 then
    raise exception 'size_band_layout_invalid: exactly one open-ended top band required, found %', v_open using errcode = '23514'; end if;
  if (select count(distinct sort_order) from public.organization_size_bands
      where organization_id = p_org and band_kind = 'dog_weight' and status = 'active') <> v_n then
    raise exception 'size_band_layout_invalid: duplicate sort_order' using errcode = '23514'; end if;
  if exists (
    select 1 from (
      select upper_kg,
             lag(upper_kg) over (order by sort_order) as prev_upper,
             row_number() over (order by sort_order) as rn
      from public.organization_size_bands
      where organization_id = p_org and band_kind = 'dog_weight' and status = 'active') x
    where (x.upper_kg is not null and x.prev_upper is not null and x.upper_kg <= x.prev_upper)
       or (x.upper_kg is null and x.rn <> v_n)
  ) then
    raise exception 'size_band_layout_invalid: upper bounds must strictly ascend with the open band last' using errcode = '23514'; end if;
  select count(*) into v_cats from public.organization_size_bands
  where organization_id = p_org and band_kind = 'cat' and status = 'active';
  if v_cats <> 1 then
    raise exception 'size_band_layout_invalid: exactly one cat band required, found %', v_cats using errcode = '23514'; end if;
end $$;

create function app.tg_validate_size_band_layout() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform app.validate_size_band_layout(coalesce(new.organization_id, old.organization_id));
  return null;
end $$;
create constraint trigger trg_validate_size_band_layout
  after insert or update or delete on public.organization_size_bands
  deferrable initially deferred for each row execute function app.tg_validate_size_band_layout();

-- Read-only derived ranges: lower bound is the previous active band's upper.
create view public.organization_size_band_ranges with (security_invoker = true) as
select b.organization_id, b.id as band_id, b.band_key, b.label, b.sort_order, b.upper_kg, b.upper_inclusive,
       coalesce(lag(b.upper_kg) over w, 0::numeric) as lower_kg,
       case when lag(b.upper_kg) over w is null then false else not lag(b.upper_inclusive) over w end as lower_inclusive
from public.organization_size_bands b
where b.band_kind = 'dog_weight' and b.status = 'active'
window w as (partition by b.organization_id order by b.sort_order);

-- RLS: members read only their active organization; the platform owner reads
-- all. No direct DML for any client role; writes arrive via later RPCs.
alter table public.organization_size_band_settings enable row level security;
alter table public.organization_size_bands enable row level security;
revoke all on public.organization_size_band_settings, public.organization_size_bands,
  public.organization_size_band_ranges from public, anon, authenticated;
grant select on public.organization_size_band_settings, public.organization_size_bands,
  public.organization_size_band_ranges to authenticated;
create policy organization_size_band_settings_read on public.organization_size_band_settings
  for select to authenticated
  using (app.is_operro_owner() or (organization_id = app.fn_active_organization() and app.has_membership()));
create policy organization_size_bands_read on public.organization_size_bands
  for select to authenticated
  using (app.is_operro_owner() or (organization_id = app.fn_active_organization() and app.has_membership()));

revoke all on function app.tg_size_band_guard(), app.tg_size_band_cat_permanent(),
  app.tg_pet_type_not_size_band(), app.validate_size_band_layout(uuid),
  app.tg_validate_size_band_layout() from public, anon, authenticated;

-- New organizations start on the legacy layout with default cutoffs 5/10/15/25.
create function app.seed_org_size_bands() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.organization_size_band_settings(organization_id) values (new.id)
  on conflict (organization_id) do nothing;
  insert into public.organization_size_bands(organization_id, band_key, band_kind, label, sort_order, upper_kg, upper_inclusive)
  values (new.id,'extra_small','dog_weight','XS',10,5,false),
         (new.id,'small','dog_weight','S',20,10,false),
         (new.id,'medium','dog_weight','M',30,15,false),
         (new.id,'large','dog_weight','L',40,25,true),
         (new.id,'extra_large','dog_weight','XL',50,null,false),
         (new.id,'cat','cat','Cat',1000,null,false)
  on conflict (organization_id, band_key) do nothing;
  return new;
end $$;
revoke all on function app.seed_org_size_bands() from public, anon, authenticated;
create trigger trg_seed_org_size_bands after insert on public.organizations
  for each row execute function app.seed_org_size_bands();

-- Backfill every existing organization (deleted ones included). Cutoffs are
-- copied verbatim; an organization without a boundary row gets 5/10/15/25.
-- `large` keeps its inclusive upper bound so exactly 25.00 kg stays large.
insert into public.organization_size_band_settings(organization_id)
select o.id from public.organizations o
on conflict (organization_id) do nothing;

insert into public.organization_size_bands(organization_id, band_key, band_kind, label, sort_order, upper_kg, upper_inclusive)
select o.id, d.band_key, d.band_kind, d.label, d.sort_order,
       case d.band_key
         when 'extra_small' then coalesce(b.xs_lt_kg, 5)
         when 'small' then coalesce(b.s_lt_kg, 10)
         when 'medium' then coalesce(b.m_lt_kg, 15)
         when 'large' then coalesce(b.l_lte_kg, 25)
       end,
       d.band_key = 'large'
from public.organizations o
left join public.organization_dog_size_boundaries b on b.organization_id = o.id
cross join (values
  ('extra_small','dog_weight','XS',10),('small','dog_weight','S',20),('medium','dog_weight','M',30),
  ('large','dog_weight','L',40),('extra_large','dog_weight','XL',50),('cat','cat','Cat',1000)
) as d(band_key, band_kind, label, sort_order)
on conflict (organization_id, band_key) do nothing;

commit;
