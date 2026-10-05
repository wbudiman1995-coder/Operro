-- Dynamic tenant-owned size bands, part 2 (SB-02): per-band prices/durations
-- and the shadow sync that keeps the new tables equal to the legacy writers.
-- While an organization is in `legacy` mode, organization_dog_size_boundaries
-- and the 12 legacy service_catalog price/duration columns stay authoritative;
-- the old UI and RPCs keep writing them and these triggers mirror the result.
begin;

create table public.service_band_prices (
  organization_id uuid not null,
  service_id uuid not null,
  pricing_key text not null,
  price numeric(14,2) check (price is null or price >= 0),
  duration_minutes integer check (duration_minutes is null or duration_minutes >= 0),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  primary key (organization_id, service_id, pricing_key),
  constraint fk_service_band_prices_service foreign key (organization_id, service_id)
    references public.service_catalog (organization_id, id) on delete cascade,
  constraint fk_service_band_prices_band foreign key (organization_id, pricing_key)
    references public.organization_size_bands (organization_id, band_key)
);
create index idx_service_band_prices_band on public.service_band_prices (organization_id, pricing_key);
create trigger trg_service_band_prices_updated_at before update on public.service_band_prices
  for each row execute function app.tg_set_updated_at();

alter table public.service_band_prices enable row level security;
revoke all on public.service_band_prices from public, anon, authenticated;
grant select on public.service_band_prices to authenticated;
create policy service_band_prices_read on public.service_band_prices for select to authenticated
  using (app.is_operro_owner() or (organization_id = app.fn_active_organization() and app.has_membership()));
create policy service_band_prices_module_gate on public.service_band_prices as restrictive for select to authenticated
  using (app.is_platform_admin() or app.has_module('scheduling'));

-- Snapshot columns for new lines/entitlements. Additive and nullable: existing
-- rows are deliberately left untouched (no historical rewrite, no audit churn);
-- readers fall back to pet_size_snapshot / packages.size_band when NULL.
alter table public.grooming_job_pet_services
  add column pet_size_label_snapshot text,
  add column pet_weight_kg_snapshot numeric(6,2),
  add column size_layout_version_snapshot integer,
  add constraint chk_gjps_size_label_snapshot check (pet_size_label_snapshot is null or length(btrim(pet_size_label_snapshot)) between 1 and 60),
  add constraint chk_gjps_weight_snapshot check (pet_weight_kg_snapshot is null or pet_weight_kg_snapshot > 0),
  add constraint chk_gjps_layout_version_snapshot check (size_layout_version_snapshot is null or size_layout_version_snapshot >= 1);
alter table public.customer_packages
  add column size_band_snapshot text,
  add column size_label_snapshot text,
  add constraint chk_customer_packages_size_band_snapshot check (size_band_snapshot is null or size_band_snapshot ~ '^[a-z][a-z0-9_]{1,29}$'),
  add constraint chk_customer_packages_size_label_snapshot check (size_label_snapshot is null or length(btrim(size_label_snapshot)) between 1 and 60);

-- Legacy catalog columns -> service_band_prices (legacy mode only; in dynamic
-- mode the new table is authoritative and the legacy columns are a frozen mirror).
create function app.tg_sync_service_band_prices() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_mode text; r record;
begin
  if tg_op = 'UPDATE' and
     (old.price_extra_small, old.price_small, old.price_medium, old.price_large, old.price_extra_large, old.price_cat,
      old.duration_extra_small, old.duration_small, old.duration_medium, old.duration_large, old.duration_extra_large, old.duration_cat)
     is not distinct from
     (new.price_extra_small, new.price_small, new.price_medium, new.price_large, new.price_extra_large, new.price_cat,
      new.duration_extra_small, new.duration_small, new.duration_medium, new.duration_large, new.duration_extra_large, new.duration_cat)
  then return null; end if;
  select s.mode into v_mode from public.organization_size_band_settings s where s.organization_id = new.organization_id;
  if coalesce(v_mode, 'legacy') <> 'legacy' then return null; end if;
  for r in select * from (values
    ('extra_small', new.price_extra_small, new.duration_extra_small),
    ('small', new.price_small, new.duration_small),
    ('medium', new.price_medium, new.duration_medium),
    ('large', new.price_large, new.duration_large),
    ('extra_large', new.price_extra_large, new.duration_extra_large),
    ('cat', new.price_cat, new.duration_cat)
  ) as t(k, p, d)
  loop
    if r.p is null and r.d is null then
      delete from public.service_band_prices
      where organization_id = new.organization_id and service_id = new.id and pricing_key = r.k;
    else
      insert into public.service_band_prices(organization_id, service_id, pricing_key, price, duration_minutes, updated_by)
      values (new.organization_id, new.id, r.k, r.p, r.d, new.updated_by)
      on conflict (organization_id, service_id, pricing_key) do update
        set price = excluded.price, duration_minutes = excluded.duration_minutes, updated_by = excluded.updated_by;
    end if;
  end loop;
  return null;
end $$;
revoke all on function app.tg_sync_service_band_prices() from public, anon, authenticated;
create trigger trg_sync_service_band_prices
  after insert or update of price_extra_small, price_small, price_medium, price_large, price_extra_large, price_cat,
    duration_extra_small, duration_small, duration_medium, duration_large, duration_extra_large, duration_cat
  on public.service_catalog for each row execute function app.tg_sync_service_band_prices();

-- organization_dog_size_boundaries -> the four legacy upper bounds (legacy mode
-- only). Deleting the row restores the 5/10/15/25 defaults, matching the old
-- resolver's behavior for organizations without a boundary row.
create function app.tg_sync_size_bands_from_boundaries() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := coalesce(new.organization_id, old.organization_id);
        v_mode text; v_xs numeric; v_s numeric; v_m numeric; v_l numeric; v_changed integer;
begin
  select s.mode into v_mode from public.organization_size_band_settings s where s.organization_id = v_org;
  if coalesce(v_mode, 'legacy') <> 'legacy' then return null; end if;
  if tg_op = 'DELETE' then v_xs := 5; v_s := 10; v_m := 15; v_l := 25;
  else v_xs := new.xs_lt_kg; v_s := new.s_lt_kg; v_m := new.m_lt_kg; v_l := new.l_lte_kg; end if;
  update public.organization_size_bands b
  set upper_kg = case b.band_key when 'extra_small' then v_xs when 'small' then v_s
                                 when 'medium' then v_m when 'large' then v_l end,
      updated_by = case when tg_op = 'DELETE' then null else new.updated_by end
  where b.organization_id = v_org and b.band_kind = 'dog_weight'
    and b.band_key in ('extra_small','small','medium','large')
    and b.upper_kg is distinct from case b.band_key when 'extra_small' then v_xs when 'small' then v_s
                                                    when 'medium' then v_m when 'large' then v_l end;
  get diagnostics v_changed = row_count;
  if v_changed > 0 then
    update public.organization_size_band_settings
    set layout_version = layout_version + 1,
        updated_by = case when tg_op = 'DELETE' then null else new.updated_by end
    where organization_id = v_org;
  end if;
  return null;
end $$;
revoke all on function app.tg_sync_size_bands_from_boundaries() from public, anon, authenticated;
create trigger trg_sync_size_bands_from_boundaries after insert or update or delete
  on public.organization_dog_size_boundaries for each row execute function app.tg_sync_size_bands_from_boundaries();

-- Backfill: one row per legacy (service, key) that has a price or duration.
-- NULL/NULL stays "no row" (resolution falls back to the service base values).
insert into public.service_band_prices(organization_id, service_id, pricing_key, price, duration_minutes)
select sc.organization_id, sc.id, v.k, v.p, v.d
from public.service_catalog sc
cross join lateral (values
  ('extra_small', sc.price_extra_small, sc.duration_extra_small),
  ('small', sc.price_small, sc.duration_small),
  ('medium', sc.price_medium, sc.duration_medium),
  ('large', sc.price_large, sc.duration_large),
  ('extra_large', sc.price_extra_large, sc.duration_extra_large),
  ('cat', sc.price_cat, sc.duration_cat)
) as v(k, p, d)
where v.p is not null or v.d is not null
on conflict (organization_id, service_id, pricing_key) do nothing;

commit;
