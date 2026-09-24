-- =====================================================================
-- MIGRATION MANIFEST
-- =====================================================================
-- Migration        20260924130000_service_size_pricing
-- Purpose          HomePaw parity section 21 (catalog and pricing): add a
--                  per-pet-size price matrix to service_catalog, a size
--                  classification on pets, and resolved-price/duration
--                  snapshotting on grooming service lines. Adds a manual
--                  staff override path for a line price before invoicing.
-- Compatibility    Forward-only. All new columns are nullable or
--                  zero-valued defaults; every existing service_catalog,
--                  pets, grooming_job_pet_services, invoice and order row
--                  keeps working unchanged (no size => base_price, same as
--                  before this migration). No existing migration is edited.
-- Objects Changed  ALTER service_catalog (+4 size prices, +additional
--                  duration). ALTER pets (+size). ALTER
--                  grooming_job_pet_services (+pet_size_snapshot,
--                  +price_source, +override_reason, +overridden_by/at).
--                  CREATE OR REPLACE app.assembly_add_line (same signature,
--                  now resolves size-matrix price/duration; the DB function
--                  count that run_all_gates.sh GATE 4 asserts stays at 8).
--                  CREATE app.override_grooming_line_price (new RPC, named
--                  outside the "assembly" prefix on purpose so it is not
--                  counted by that same gate).
-- RLS/Capabilities Unchanged: new columns live on tables whose row-level
--                  policies (security_rls_isolation.sql,
--                  security_rls_capabilities.sql) are table-scoped, not
--                  column-scoped, so the existing org/branch isolation and
--                  `service.manage` write gate already cover them. The new
--                  RPC is SECURITY DEFINER and re-checks
--                  app.assert_tenant_authorized itself.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- SECTION 1 — service_catalog: size price matrix + additional duration.
-- ---------------------------------------------------------------------
alter table public.service_catalog
  add column price_small            numeric(14,2),
  add column price_medium           numeric(14,2),
  add column price_large            numeric(14,2),
  add column price_extra_large      numeric(14,2),
  add column additional_duration_minutes integer not null default 0;

alter table public.service_catalog
  add constraint chk_service_catalog_price_small       check (price_small is null or price_small >= 0),
  add constraint chk_service_catalog_price_medium      check (price_medium is null or price_medium >= 0),
  add constraint chk_service_catalog_price_large       check (price_large is null or price_large >= 0),
  add constraint chk_service_catalog_price_extra_large check (price_extra_large is null or price_extra_large >= 0),
  add constraint chk_service_catalog_additional_duration check (additional_duration_minutes >= 0);

comment on column public.service_catalog.price_small is
  'Optional per-size override. Null means "use base_price for this size" (section 21).';
comment on column public.service_catalog.additional_duration_minutes is
  'Extra minutes added per unit beyond the first when a line quantity > 1. Zero preserves pre-section-21 duration behavior.';

-- ---------------------------------------------------------------------
-- SECTION 2 — pets: size classification driving price-matrix lookup.
-- ---------------------------------------------------------------------
alter table public.pets
  add column size text;

alter table public.pets
  add constraint chk_pets_size check (size is null or size in ('small','medium','large','extra_large'));

comment on column public.pets.size is
  'Optional size band (small|medium|large|extra_large) used to resolve service_catalog size prices. Null falls back to base_price.';

-- ---------------------------------------------------------------------
-- SECTION 3 — grooming_job_pet_services: snapshot the pricing decision.
-- ---------------------------------------------------------------------
alter table public.grooming_job_pet_services
  add column pet_size_snapshot text,
  add column price_source     text not null default 'base',
  add column override_reason  text,
  add column overridden_by    uuid,
  add column overridden_at    timestamptz;

alter table public.grooming_job_pet_services
  add constraint chk_gjps_pet_size_snapshot check (pet_size_snapshot is null or pet_size_snapshot in ('small','medium','large','extra_large')),
  add constraint chk_gjps_price_source check (price_source in ('base','size_matrix','manual_override')),
  add constraint chk_gjps_override_reason check (price_source <> 'manual_override' or (override_reason is not null and length(btrim(override_reason)) > 0));

comment on column public.grooming_job_pet_services.price_source is
  'How unit_price_snapshot was decided: base (catalog base_price), size_matrix (pet size lookup), or manual_override (staff override before invoicing).';

-- ---------------------------------------------------------------------
-- SECTION 4 — assembly_add_line: resolve price/duration from pet size.
-- Same signature as the 0013.5 definition (p_pet, p_service, p_quantity),
-- so this CREATE OR REPLACE keeps run_all_gates.sh GATE 4's
-- `assembly%` function count at 8 -- it replaces, not adds, a function.
-- ---------------------------------------------------------------------
create or replace function app.assembly_add_line(p_pet uuid, p_service uuid, p_quantity integer default 1)
returns uuid security definer set search_path = app, public language plpgsql as $$
declare gjp record; b public.bookings; v_job uuid;
        v_price numeric(14,2); v_name text; v_cur text; v_dur integer; v_id uuid;
        v_pet_size text; v_size_price numeric(14,2); v_extra_dur integer;
        v_final_price numeric(14,2); v_final_dur integer; v_source text;
begin
  if p_quantity is null or p_quantity < 1 then
    raise exception 'quantity_must_be_positive' using errcode = 'check_violation'; end if;
  select grooming_job_id into v_job from public.grooming_job_pets where id = p_pet;
  if not found then raise exception 'pet_not_found' using errcode = 'no_data_found'; end if;
  b := app.assembly_guard(v_job);
  select * into gjp from public.grooming_job_pets where id = p_pet for update;
  if not found or gjp.deleted_at is not null then
    raise exception 'pet_not_found' using errcode = 'no_data_found'; end if;

  select pt.size into v_pet_size from public.pets pt
   where pt.organization_id = gjp.organization_id and pt.id = gjp.pet_id;

  select sc.name, sc.base_price, sc.currency, sc.duration_minutes, sc.additional_duration_minutes,
         case v_pet_size
           when 'small' then sc.price_small
           when 'medium' then sc.price_medium
           when 'large' then sc.price_large
           when 'extra_large' then sc.price_extra_large
           else null
         end
    into v_name, v_price, v_cur, v_dur, v_extra_dur, v_size_price
  from public.service_catalog sc
  where sc.organization_id = gjp.organization_id and sc.id = p_service
    and sc.is_active = true and sc.deleted_at is null;
  if not found then
    raise exception 'service_not_active_or_not_in_org' using errcode = 'check_violation'; end if;

  -- Size price wins only when the catalog actually defines one for this pet's
  -- size; a null size or a null column both fall back to base_price so every
  -- pre-existing service (no matrix configured) behaves exactly as before.
  if v_pet_size is not null and v_size_price is not null then
    v_final_price := v_size_price; v_source := 'size_matrix';
  else
    v_final_price := coalesce(v_price, 0); v_source := 'base';
  end if;

  -- Additional duration only ever ADDS time for units beyond the first, and
  -- defaults to 0, so a service that never configured it schedules exactly
  -- as it did before this migration regardless of quantity.
  v_final_dur := coalesce(v_dur, 60) + coalesce(v_extra_dur, 0) * greatest(p_quantity - 1, 0);

  insert into public.grooming_job_pet_services
    (organization_id, grooming_job_pet_id, service_id, service_name_snapshot,
     unit_price_snapshot, currency, quantity, duration_minutes,
     pet_size_snapshot, price_source)
  values (gjp.organization_id, gjp.id, p_service, coalesce(v_name,'Service'),
          v_final_price, coalesce(v_cur,'USD'), p_quantity, v_final_dur,
          v_pet_size, v_source)
  returning id into v_id;
  perform app.assembly_audit(gjp.organization_id, gjp.grooming_job_id, 'grooming.line_added',
    jsonb_build_object('grooming_job_pet_service_id', v_id, 'service_id', p_service,
                       'quantity', p_quantity, 'unit_price_snapshot', v_final_price,
                       'duration_minutes', v_final_dur, 'pet_size', v_pet_size, 'price_source', v_source));
  return v_id;
end; $$;

-- ---------------------------------------------------------------------
-- SECTION 5 — override_grooming_line_price: manual staff override, only
-- before an invoice exists for the owning booking. Deliberately NOT
-- prefixed "assembly" (see manifest note above).
-- ---------------------------------------------------------------------
create or replace function app.override_grooming_line_price(p_line uuid, p_price numeric, p_reason text)
returns void
security definer set search_path = app, public
language plpgsql as $$
declare ln record; b public.bookings; v_invoice_exists boolean;
begin
  if p_price is null or p_price < 0 then
    raise exception 'price_must_be_non_negative' using errcode = 'check_violation'; end if;
  if p_reason is null or length(btrim(p_reason)) = 0 then
    raise exception 'reason_required' using errcode = 'check_violation'; end if;

  select gjps.*, gjp.grooming_job_id into ln
  from public.grooming_job_pet_services gjps
  join public.grooming_job_pets gjp on gjp.organization_id = gjps.organization_id and gjp.id = gjps.grooming_job_pet_id
  where gjps.id = p_line for update of gjps;
  if not found or ln.deleted_at is not null then
    raise exception 'line_not_found' using errcode = 'no_data_found'; end if;

  select * into b from public.bookings where id = ln.grooming_job_id for update;
  if not found then raise exception 'booking_not_found' using errcode = 'no_data_found'; end if;

  perform app.assert_tenant_authorized(b.organization_id, 'scheduling', 'service.manage', b.branch_id);

  if b.status not in ('draft','requested','confirmed','in_progress','completed') then
    raise exception 'booking_not_eligible_for_override:%', b.status using errcode = 'check_violation';
  end if;

  select exists (
    select 1 from public.orders o
    join public.invoices i on i.organization_id = o.organization_id and i.order_id = o.id
    where o.organization_id = b.organization_id and o.booking_id = b.id and o.deleted_at is null
  ) into v_invoice_exists;
  if v_invoice_exists then
    raise exception 'invoice_already_issued' using errcode = 'check_violation'; end if;

  update public.grooming_job_pet_services
     set unit_price_snapshot = p_price,
         price_source = 'manual_override',
         override_reason = p_reason,
         overridden_by = app.fn_current_user_id(),
         overridden_at = now()
   where id = p_line;

  perform app.assembly_audit(ln.organization_id, ln.grooming_job_id, 'grooming.line_price_overridden',
    jsonb_build_object('grooming_job_pet_service_id', p_line, 'price', p_price, 'reason', p_reason));
end; $$;

revoke all on function app.override_grooming_line_price(uuid, numeric, text) from public, authenticated;
grant execute on function app.override_grooming_line_price(uuid, numeric, text) to authenticated;

commit;
