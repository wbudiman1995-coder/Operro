-- =====================================================================
-- MIGRATION MANIFEST
-- =====================================================================
-- Migration        20260924140000_invoice_discounts_charges
-- Purpose          HomePaw parity section 22 (discounts and charges).
--                  Adds an invoice-time discount layer on top of every
--                  discount mechanism that already exists (package
--                  coverage, the complimentary next-appointment offer,
--                  and the booking-time category_discounts snapshot):
--                  an invoice-level percent/fixed discount (optionally
--                  restricted to the Basic Grooming category), per-pet
--                  discounts, per-service discounts, per-category
--                  discounts (Basic Grooming/Styling/Special
--                  Charges/Other Fees), and a home-service transport fee
--                  line. All of it is computed and snapshotted inside
--                  ONE new SECURITY DEFINER RPC (app.issue_invoice_for_booking),
--                  atomic instead of the previous four sequential
--                  application-code inserts, plus a read-only preview
--                  twin (app.preview_invoice_pricing) sharing the same
--                  pure calculator (app._compute_invoice_pricing) so the
--                  UI can show exactly what issuing will produce before
--                  committing.
-- Compatibility    Forward-only, purely additive. Calling the new RPC
--                  with every discount argument left at its default
--                  (null/'[]') reproduces the exact pre-existing
--                  behavior (package coverage, complimentary offer,
--                  old category_discounts) byte-for-byte; every prior
--                  invoice/order/booking row is untouched. No existing
--                  migration is edited. issued/paid invoices stay
--                  immutable via the pre-existing freeze triggers,
--                  which this migration does not touch.
-- Objects Changed  ALTER order_items/invoice_lines item_type check to
--                  add 'fee' (transport fee, special-charge lines).
--                  CREATE app._compute_invoice_pricing (pure/stable
--                  calculator, no writes). CREATE
--                  app.preview_invoice_pricing (read-only wrapper).
--                  CREATE app.issue_invoice_for_booking (atomic write,
--                  replaces the app-code issuance sequence).
-- RLS/Capabilities Both new RPCs are SECURITY DEFINER and re-check
--                  app.assert_tenant_authorized themselves
--                  (finance/finance.read for preview,
--                  finance/invoice.issue for issuance) -- the same gate
--                  security_rls_capabilities.sql already requires for
--                  direct writes to orders/invoices/invoice_lines. No
--                  RLS policy changes needed: the underlying tables'
--                  policies are unchanged and untouched.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- SECTION 1 — allow a 'fee' line (transport fee / special charges) next
-- to the existing service/product item types.
-- ---------------------------------------------------------------------
alter table public.order_items drop constraint chk_order_items_type;
alter table public.order_items add constraint chk_order_items_type check (item_type in ('service','product','package','fee'));

alter table public.invoice_lines drop constraint chk_invoice_lines_type;
alter table public.invoice_lines add constraint chk_invoice_lines_type check (item_type in ('service','product','package','fee'));

-- ---------------------------------------------------------------------
-- SECTION 2 — pure pricing calculator. STABLE (no writes). Ported from
-- the pre-existing issueInvoiceForBookingAction TS logic (package
-- coverage full-discount, complimentary_next_discount.lineDiscounts,
-- and the booking-time metadata.category_discounts rules/fixed-pool),
-- with a new, additive, deterministic layer applied to whatever remains
-- after those: per-pet fixed/percent -> per-service fixed/percent ->
-- per-category fixed/percent (Basic Grooming/Styling/Special
-- Charges/Other Fees, matched against service_catalog.category, default
-- "Other Fees") -> a single invoice-level fixed/percent discount,
-- optionally restricted to Basic Grooming lines. A package-covered line
-- is fully skipped by every layer here (requirement: package coverage
-- must not be discounted again). Every discount is clamped so a line's
-- remaining total can never go below zero.
-- ---------------------------------------------------------------------
create or replace function app._compute_invoice_pricing(
  p_booking uuid,
  p_invoice_discount jsonb,
  p_pet_discounts jsonb,
  p_service_discounts jsonb,
  p_category_discounts jsonb,
  out lines jsonb,
  out transport_fee numeric,
  out subtotal numeric,
  out discount_total numeric,
  out total numeric
)
security definer set search_path = app, public
language plpgsql stable as $$
declare
  b public.bookings;
  v_line record;
  v_rule jsonb; v_type text; v_value numeric; v_key text;
  v_pet_percent jsonb := '{}'::jsonb; v_pet_fixed jsonb := '{}'::jsonb;
  v_service_percent jsonb := '{}'::jsonb; v_service_fixed jsonb := '{}'::jsonb;
  v_category_percent jsonb := '{}'::jsonb; v_category_fixed jsonb := '{}'::jsonb;
  v_invoice_type text; v_invoice_value numeric; v_invoice_basic_only boolean := false; v_invoice_fixed_remaining numeric := 0;
  v_offer_lines jsonb := '{}'::jsonb;
  v_old_rules jsonb := '[]'::jsonb; v_old_service_categories jsonb := '{}'::jsonb; v_old_category_fixed jsonb := '{}'::jsonb;
  v_gross numeric; v_remaining numeric; v_package_covered boolean;
  v_old_category text; v_old_rule jsonb; v_old_discount numeric; v_old_category_amt numeric;
  v_new_category text; v_pet_amt numeric; v_service_amt numeric; v_category_amt numeric; v_invoice_amt numeric;
  v_line_total numeric; v_breakdown jsonb;
begin
  select * into b from public.bookings where id = p_booking;
  if not found then raise exception 'booking_not_found' using errcode = 'no_data_found'; end if;
  -- Same gate as the pre-existing app.list_booking_package_coverage: previewing
  -- the invoice a booking would produce requires the same authority as issuing it.
  perform app.assert_tenant_authorized(b.organization_id, 'finance', 'invoice.issue', b.branch_id);

  -- --- validate + index the new discount inputs (constraints: type, percent range, fixed >= 0, category) ---
  if p_invoice_discount is not null and p_invoice_discount <> 'null'::jsonb then
    v_invoice_type := p_invoice_discount->>'type';
    if v_invoice_type not in ('percent','fixed') then raise exception 'invalid_discount_type:invoice' using errcode = 'check_violation'; end if;
    begin v_invoice_value := (p_invoice_discount->>'value')::numeric; exception when others then
      raise exception 'invalid_discount_value:invoice' using errcode = 'check_violation'; end;
    if v_invoice_value is null or v_invoice_value < 0 or (v_invoice_type = 'percent' and v_invoice_value > 100) then
      raise exception 'invalid_discount_value:invoice' using errcode = 'check_violation'; end if;
    v_invoice_basic_only := coalesce((p_invoice_discount->>'basicGroomingOnly')::boolean, false);
    if v_invoice_type = 'fixed' then v_invoice_fixed_remaining := v_invoice_value; end if;
  end if;

  for v_rule in select * from jsonb_array_elements(coalesce(p_pet_discounts, '[]'::jsonb)) loop
    v_key := v_rule->>'grooming_job_pet_id'; v_type := v_rule->>'type';
    if v_key is null or v_type not in ('percent','fixed') then raise exception 'invalid_discount_type:pet' using errcode = 'check_violation'; end if;
    begin v_value := (v_rule->>'value')::numeric; exception when others then raise exception 'invalid_discount_value:pet' using errcode = 'check_violation'; end;
    if v_value is null or v_value < 0 or (v_type = 'percent' and v_value > 100) then raise exception 'invalid_discount_value:pet' using errcode = 'check_violation'; end if;
    if v_type = 'percent' then v_pet_percent := jsonb_set(v_pet_percent, array[v_key], to_jsonb(v_value)); v_pet_fixed := v_pet_fixed - v_key;
    else v_pet_fixed := jsonb_set(v_pet_fixed, array[v_key], to_jsonb(v_value)); v_pet_percent := v_pet_percent - v_key; end if;
  end loop;

  for v_rule in select * from jsonb_array_elements(coalesce(p_service_discounts, '[]'::jsonb)) loop
    v_key := v_rule->>'service_id'; v_type := v_rule->>'type';
    if v_key is null or v_type not in ('percent','fixed') then raise exception 'invalid_discount_type:service' using errcode = 'check_violation'; end if;
    begin v_value := (v_rule->>'value')::numeric; exception when others then raise exception 'invalid_discount_value:service' using errcode = 'check_violation'; end;
    if v_value is null or v_value < 0 or (v_type = 'percent' and v_value > 100) then raise exception 'invalid_discount_value:service' using errcode = 'check_violation'; end if;
    if v_type = 'percent' then v_service_percent := jsonb_set(v_service_percent, array[v_key], to_jsonb(v_value)); v_service_fixed := v_service_fixed - v_key;
    else v_service_fixed := jsonb_set(v_service_fixed, array[v_key], to_jsonb(v_value)); v_service_percent := v_service_percent - v_key; end if;
  end loop;

  for v_rule in select * from jsonb_array_elements(coalesce(p_category_discounts, '[]'::jsonb)) loop
    v_key := v_rule->>'category'; v_type := v_rule->>'type';
    if v_key is null or v_key not in ('Basic Grooming','Styling','Special Charges','Other Fees') then
      raise exception 'invalid_discount_category:%', v_key using errcode = 'check_violation'; end if;
    if v_type not in ('percent','fixed') then raise exception 'invalid_discount_type:category' using errcode = 'check_violation'; end if;
    begin v_value := (v_rule->>'value')::numeric; exception when others then raise exception 'invalid_discount_value:category' using errcode = 'check_violation'; end;
    if v_value is null or v_value < 0 or (v_type = 'percent' and v_value > 100) then raise exception 'invalid_discount_value:category' using errcode = 'check_violation'; end if;
    if v_type = 'percent' then v_category_percent := jsonb_set(v_category_percent, array[v_key], to_jsonb(v_value)); v_category_fixed := v_category_fixed - v_key;
    else v_category_fixed := jsonb_set(v_category_fixed, array[v_key], to_jsonb(v_value)); v_category_percent := v_category_percent - v_key; end if;
  end loop;

  -- --- pre-existing discount state (preserved verbatim: complimentary offer + old booking-time category rules) ---
  if b.metadata ? 'complimentary_next_discount' then
    v_offer_lines := coalesce(b.metadata->'complimentary_next_discount'->'lineDiscounts', '{}'::jsonb);
  end if;
  if b.metadata ? 'category_discounts' then
    v_old_rules := coalesce(b.metadata->'category_discounts'->'rules', '[]'::jsonb);
    v_old_service_categories := coalesce(b.metadata->'category_discounts'->'service_categories', '{}'::jsonb);
  end if;
  -- Mirrors the pre-existing TS `fixedRemaining` Map exactly: one shared pool per
  -- literal category string across the whole booking, decremented as lines match it.
  select coalesce(jsonb_object_agg(r->>'category', (r->>'value')::numeric), '{}'::jsonb)
    into v_old_category_fixed from jsonb_array_elements(v_old_rules) r where r->>'type' = 'fixed';

  subtotal := 0; discount_total := 0; lines := '[]'::jsonb;

  for v_line in
    select l.id, l.grooming_job_pet_id, l.service_id, l.service_name_snapshot, l.quantity, l.unit_price_snapshot, sc.category
      from public.grooming_job_pet_services l
      join public.grooming_job_pets p on p.organization_id = l.organization_id and p.id = l.grooming_job_pet_id
      left join public.service_catalog sc on sc.organization_id = l.organization_id and sc.id = l.service_id
     where l.organization_id = b.organization_id and p.grooming_job_id = p_booking and l.deleted_at is null and p.deleted_at is null
     order by p.sequence, l.created_at
  loop
    v_gross := round(v_line.unit_price_snapshot * v_line.quantity, 2);
    select exists(
      select 1 from public.package_reservations pr
      where pr.organization_id = b.organization_id and pr.grooming_job_pet_service_id = v_line.id and pr.status in ('reserved','consumed')
    ) into v_package_covered;

    if v_package_covered then
      -- Package-covered lines are fully zeroed and skip every discount layer below
      -- (item 13): nothing is deducted from any fixed pool for them either.
      v_remaining := 0;
      v_breakdown := jsonb_build_object('source', 'grooming_job_line', 'package_coverage', true);
    else
      -- old layer: complimentary next-appointment + booking-time category rule, read
      -- from the immutable booking-time snapshot (service_categories), never a live
      -- service_catalog join -- a category edited after booking must not change an
      -- already-placed booking's discount, matching the pre-existing behavior.
      v_old_discount := greatest(0, coalesce((v_offer_lines->v_line.id::text->>'amount')::numeric, 0));
      v_old_category := coalesce(v_old_service_categories->>(v_line.service_id::text), 'Lainnya');
      select r into v_old_rule from jsonb_array_elements(v_old_rules) r where r->>'category' = v_old_category limit 1;
      if v_old_rule is not null then
        if v_old_rule->>'type' = 'percent' then
          v_old_discount := v_old_discount + least(v_gross, round(v_gross * least(100, greatest(0, (v_old_rule->>'value')::numeric)) / 100, 2));
        elsif v_old_rule->>'type' = 'fixed' then
          v_old_category_amt := least(v_gross, coalesce((v_old_category_fixed->>v_old_category)::numeric, 0));
          v_old_category_fixed := jsonb_set(v_old_category_fixed, array[v_old_category], to_jsonb(coalesce((v_old_category_fixed->>v_old_category)::numeric, 0) - v_old_category_amt));
          v_old_discount := v_old_discount + v_old_category_amt;
        end if;
      end if;
      v_old_discount := least(v_gross, v_old_discount);
      v_remaining := v_gross - v_old_discount;
      v_old_rule := null;

      -- new layer, fixed deterministic order: pet -> service -> category -> invoice.
      v_pet_amt := 0; v_service_amt := 0; v_category_amt := 0; v_invoice_amt := 0;
      v_key := v_line.grooming_job_pet_id::text;
      if v_pet_percent ? v_key then v_pet_amt := round(v_remaining * (v_pet_percent->>v_key)::numeric / 100, 2);
      elsif v_pet_fixed ? v_key then v_pet_amt := least(v_remaining, (v_pet_fixed->>v_key)::numeric); v_pet_fixed := jsonb_set(v_pet_fixed, array[v_key], to_jsonb((v_pet_fixed->>v_key)::numeric - v_pet_amt)); end if;
      v_remaining := v_remaining - v_pet_amt;

      v_key := v_line.service_id::text;
      if v_service_percent ? v_key then v_service_amt := round(v_remaining * (v_service_percent->>v_key)::numeric / 100, 2);
      elsif v_service_fixed ? v_key then v_service_amt := least(v_remaining, (v_service_fixed->>v_key)::numeric); v_service_fixed := jsonb_set(v_service_fixed, array[v_key], to_jsonb((v_service_fixed->>v_key)::numeric - v_service_amt)); end if;
      v_remaining := v_remaining - v_service_amt;

      v_new_category := coalesce(v_line.category, 'Other Fees');
      v_key := v_new_category;
      if v_category_percent ? v_key then v_category_amt := round(v_remaining * (v_category_percent->>v_key)::numeric / 100, 2);
      elsif v_category_fixed ? v_key then v_category_amt := least(v_remaining, (v_category_fixed->>v_key)::numeric); v_category_fixed := jsonb_set(v_category_fixed, array[v_key], to_jsonb((v_category_fixed->>v_key)::numeric - v_category_amt)); end if;
      v_remaining := v_remaining - v_category_amt;

      if v_invoice_type is not null and (not v_invoice_basic_only or v_new_category = 'Basic Grooming') then
        if v_invoice_type = 'percent' then v_invoice_amt := round(v_remaining * v_invoice_value / 100, 2);
        else v_invoice_amt := least(v_remaining, v_invoice_fixed_remaining); v_invoice_fixed_remaining := v_invoice_fixed_remaining - v_invoice_amt; end if;
        v_remaining := v_remaining - v_invoice_amt;
      end if;

      v_breakdown := jsonb_build_object('source', 'grooming_job_line', 'package_coverage', false)
        || case when v_old_discount > 0 then jsonb_build_object('legacy_discount', v_old_discount) else '{}'::jsonb end
        || case when v_pet_amt > 0 then jsonb_build_object('pet_discount', jsonb_build_object('grooming_job_pet_id', v_line.grooming_job_pet_id, 'amount', v_pet_amt)) else '{}'::jsonb end
        || case when v_service_amt > 0 then jsonb_build_object('service_discount', jsonb_build_object('service_id', v_line.service_id, 'amount', v_service_amt)) else '{}'::jsonb end
        || case when v_category_amt > 0 then jsonb_build_object('category_discount', jsonb_build_object('category', v_new_category, 'amount', v_category_amt)) else '{}'::jsonb end
        || case when v_invoice_amt > 0 then jsonb_build_object('invoice_discount', jsonb_build_object('type', v_invoice_type, 'amount', v_invoice_amt)) else '{}'::jsonb end;
    end if;

    v_line_total := greatest(0, round(v_remaining, 2));
    lines := lines || jsonb_build_array(jsonb_build_object(
      'line_id', v_line.id, 'name', v_line.service_name_snapshot, 'quantity', v_line.quantity,
      'unit_price', v_line.unit_price_snapshot, 'gross', v_gross, 'discount_amount', round(v_gross - v_line_total, 2),
      'line_total', v_line_total, 'category', coalesce(v_line.category, 'Other Fees'),
      'grooming_job_pet_id', v_line.grooming_job_pet_id, 'service_id', v_line.service_id, 'pricing_breakdown', v_breakdown));
    subtotal := subtotal + v_gross;
    discount_total := discount_total + round(v_gross - v_line_total, 2);
  end loop;

  transport_fee := case when b.fulfillment_mode = 'home' and coalesce(b.travel_fee, 0) > 0 then b.travel_fee else 0 end;
  if transport_fee > 0 then
    subtotal := subtotal + transport_fee;
    lines := lines || jsonb_build_array(jsonb_build_object(
      'line_id', null, 'name', 'Transport fee', 'quantity', 1, 'unit_price', transport_fee, 'gross', transport_fee,
      'discount_amount', 0, 'line_total', transport_fee, 'category', 'Other Fees', 'grooming_job_pet_id', null,
      'service_id', null, 'pricing_breakdown', jsonb_build_object('source', 'booking_travel_fee', 'item_type', 'fee')));
  end if;

  total := subtotal - discount_total;
end; $$;

revoke all on function app._compute_invoice_pricing(uuid, jsonb, jsonb, jsonb, jsonb) from public, authenticated;

-- ---------------------------------------------------------------------
-- SECTION 3 — read-only preview: identical math, zero writes.
-- ---------------------------------------------------------------------
create or replace function app.preview_invoice_pricing(
  p_booking uuid, p_invoice_discount jsonb default null, p_pet_discounts jsonb default '[]'::jsonb,
  p_service_discounts jsonb default '[]'::jsonb, p_category_discounts jsonb default '[]'::jsonb
)
returns jsonb
security definer set search_path = app, public
language plpgsql stable as $$
declare v_pricing record;
begin
  select * into v_pricing from app._compute_invoice_pricing(p_booking, p_invoice_discount, p_pet_discounts, p_service_discounts, p_category_discounts);
  return jsonb_build_object('lines', v_pricing.lines, 'transport_fee', v_pricing.transport_fee,
    'subtotal', v_pricing.subtotal, 'discount_total', v_pricing.discount_total, 'total', v_pricing.total);
end; $$;

revoke all on function app.preview_invoice_pricing(uuid, jsonb, jsonb, jsonb, jsonb) from public, authenticated;
grant execute on function app.preview_invoice_pricing(uuid, jsonb, jsonb, jsonb, jsonb) to authenticated;

-- ---------------------------------------------------------------------
-- SECTION 4 — atomic issuance: same guards as the previous app-code
-- flow (booking must be completed, no existing order/invoice), using
-- the shared calculator, all writes in one PL/pgSQL transaction.
-- ---------------------------------------------------------------------
create or replace function app.issue_invoice_for_booking(
  p_booking uuid, p_invoice_discount jsonb default null, p_pet_discounts jsonb default '[]'::jsonb,
  p_service_discounts jsonb default '[]'::jsonb, p_category_discounts jsonb default '[]'::jsonb,
  p_issued_at timestamptz default null, p_due_at timestamptz default null,
  p_document_type text default null, p_groomer uuid default null,
  p_manual_groomer text default null, p_admin_notes text default null
)
returns uuid
security definer set search_path = app, public
language plpgsql as $$
declare
  b public.bookings; v_pricing record; v_order_id uuid; v_invoice_id uuid; v_invoice_number text;
  v_line jsonb; v_item_type text; v_issued_at timestamptz; v_due_at timestamptz;
  v_document_type text; v_groomer_name text; v_groomer uuid;
begin
  select * into b from public.bookings where id = p_booking for update;
  if not found then raise exception 'booking_not_found' using errcode = 'no_data_found'; end if;
  perform app.assert_tenant_authorized(b.organization_id, 'finance', 'invoice.issue', b.branch_id);
  if b.status <> 'completed' then raise exception 'booking_not_completed' using errcode = 'check_violation'; end if;
  if exists (select 1 from public.orders where organization_id = b.organization_id and booking_id = b.id and deleted_at is null) then
    raise exception 'order_already_exists' using errcode = 'unique_violation'; end if;

  select * into v_pricing from app._compute_invoice_pricing(p_booking, p_invoice_discount, p_pet_discounts, p_service_discounts, p_category_discounts);
  if jsonb_array_length(v_pricing.lines) = 0 then raise exception 'no_service_lines' using errcode = 'check_violation'; end if;
  v_issued_at := coalesce(p_issued_at, now());
  v_due_at := coalesce(p_due_at, v_issued_at + interval '1 day');
  if v_due_at < v_issued_at then raise exception 'due_date_before_invoice_date' using errcode = 'check_violation'; end if;
  v_document_type := coalesce(p_document_type, case when v_pricing.total = 0 then 'service_report' else 'invoice' end);
  if v_document_type not in ('invoice','service_report') then raise exception 'invalid_document_type' using errcode = 'check_violation'; end if;
  v_groomer := p_groomer;
  if v_groomer is null and nullif(btrim(coalesce(p_manual_groomer,'')), '') is null then
    select gjp.assigned_resource_id into v_groomer from public.grooming_job_pets gjp
      where gjp.organization_id=b.organization_id and gjp.grooming_job_id=b.id and gjp.deleted_at is null
        and gjp.assigned_resource_id is not null
        and (select count(distinct assigned_resource_id) from public.grooming_job_pets
             where organization_id=b.organization_id and grooming_job_id=b.id and deleted_at is null)=1
      limit 1;
  end if;
  if v_groomer is not null then
    select r.name into v_groomer_name from public.resources r
      where r.organization_id=b.organization_id and r.branch_id=b.branch_id and r.id=v_groomer
        and r.kind='staff' and r.status='active' and r.deleted_at is null;
    if not found then raise exception 'groomer_not_found' using errcode = 'no_data_found'; end if;
  else
    v_groomer_name := left(nullif(btrim(p_manual_groomer),''),160);
  end if;

  insert into public.orders (organization_id, branch_id, customer_id, booking_id, status, currency, metadata)
  values (b.organization_id, b.branch_id, b.customer_id, b.id, 'confirmed', 'IDR', jsonb_build_object('created_from', 'homepaw_pilot'))
  returning id into v_order_id;

  for v_line in select * from jsonb_array_elements(v_pricing.lines) loop
    v_item_type := case when v_line->>'line_id' is null then 'fee' else 'service' end;
    insert into public.order_items (organization_id, order_id, item_type, service_id, name_snapshot, quantity, unit_price, discount_amount, line_total, pricing_breakdown, metadata)
    values (b.organization_id, v_order_id, v_item_type, nullif(v_line->>'service_id','')::uuid, v_line->>'name', (v_line->>'quantity')::numeric,
            (v_line->>'unit_price')::numeric, (v_line->>'discount_amount')::numeric, (v_line->>'line_total')::numeric, v_line->'pricing_breakdown',
            jsonb_build_object('created_from', 'homepaw_pilot') || case when v_line->>'line_id' is not null then jsonb_build_object('grooming_job_pet_service_id', v_line->>'line_id') else '{}'::jsonb end);
  end loop;

  v_invoice_number := 'INV-' || to_char(v_issued_at, 'YYYYMMDD') || '-' || upper(substr(replace(v_order_id::text,'-',''),1,8));
  insert into public.invoices (organization_id, branch_id, customer_id, order_id, invoice_number, status, currency, subtotal, discount_total, tax_total, total, issued_at, due_at, billing_mode, document_type, groomer_resource_id, groomer_name_snapshot, admin_notes, metadata)
  values (b.organization_id, b.branch_id, b.customer_id, v_order_id, v_invoice_number, 'issued', 'IDR', v_pricing.subtotal, v_pricing.discount_total, 0, v_pricing.total,
          v_issued_at, v_due_at, 'after_visit', v_document_type, v_groomer, v_groomer_name, left(nullif(btrim(p_admin_notes),''),2000), jsonb_build_object('created_from', 'homepaw_pilot', 'booking_id', b.id, 'discount_inputs', jsonb_build_object(
            'invoice', p_invoice_discount, 'pets', p_pet_discounts, 'services', p_service_discounts, 'categories', p_category_discounts)))
  returning id into v_invoice_id;

  for v_line in select * from jsonb_array_elements(v_pricing.lines) loop
    v_item_type := case when v_line->>'line_id' is null then 'fee' else 'service' end;
    insert into public.invoice_lines (organization_id, invoice_id, item_type, name_snapshot, quantity, unit_price, discount_amount, line_total, pricing_breakdown)
    values (b.organization_id, v_invoice_id, v_item_type, v_line->>'name', (v_line->>'quantity')::numeric, (v_line->>'unit_price')::numeric,
            (v_line->>'discount_amount')::numeric, (v_line->>'line_total')::numeric, v_line->'pricing_breakdown');
  end loop;

  perform app.assembly_audit(b.organization_id, b.id, 'finance.invoice_issued',
    jsonb_build_object('invoice_id', v_invoice_id, 'order_id', v_order_id, 'total', v_pricing.total, 'discount_total', v_pricing.discount_total));
  return v_invoice_id;
end; $$;

revoke all on function app.issue_invoice_for_booking(uuid, jsonb, jsonb, jsonb, jsonb, timestamptz, timestamptz, text, uuid, text, text) from public, authenticated;
grant execute on function app.issue_invoice_for_booking(uuid, jsonb, jsonb, jsonb, jsonb, timestamptz, timestamptz, text, uuid, text, text) to authenticated;

commit;
