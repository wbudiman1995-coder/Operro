-- Forward fix for UUIDv7 timestamp-prefix invoice-number collisions.
-- Preserve the existing INV-YYYYMMDD-XXXXXXXX format for previously issued invoices.
begin;

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

  -- Use the UUIDv7's low-order (random) bytes, not the high-order timestamp bytes: two invoices
  -- issued within the same millisecond window would otherwise share the same 8-char prefix.
  v_invoice_number := 'INV-' || to_char(v_issued_at, 'YYYYMMDD') || '-' || upper(right(replace(v_order_id::text,'-',''),8));
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
