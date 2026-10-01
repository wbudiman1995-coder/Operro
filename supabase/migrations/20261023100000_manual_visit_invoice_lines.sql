-- Multi-line manual-visit invoices. The existing single-amount RPC remains for
-- older clients; the new editor submits an explicit, immutable line snapshot.
begin;

create function app.create_invoice_from_manual_visit_lines(
  p_visit uuid, p_issued_at timestamptz, p_due_at timestamptz,
  p_lines jsonb, p_admin_notes text, p_request_key uuid
) returns public.invoices
language plpgsql security definer set search_path = app, public as $$
declare
  v_org uuid := app.fn_active_organization();
  v_visit public.manual_visits;
  v_order public.orders;
  v_invoice public.invoices;
  v_currency text;
  v_number text;
  v_line jsonb;
  v_name text;
  v_quantity numeric;
  v_unit_price numeric;
  v_total numeric := 0;
  v_fingerprint text;
  v_admin_notes text;
begin
  if v_org is null or not app.has_membership() or not app.has_module('finance')
     or not app.has_permission('invoice.issue') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_request_key is null or p_issued_at is null
     or (p_due_at is not null and p_due_at < p_issued_at)
     or jsonb_typeof(p_lines) is distinct from 'array'
     or jsonb_array_length(p_lines) not between 1 and 50 then
    raise exception 'invalid_invoice_details' using errcode = '22023';
  end if;

  -- Validate the full payload before any insert. Keep both numeric precision and
  -- aggregate within the storage type; do not allow a zero-value invoice.
  for v_line in select value from jsonb_array_elements(p_lines) loop
    if jsonb_typeof(v_line) <> 'object' then
      raise exception 'invalid_invoice_line' using errcode = '22023';
    end if;
    v_name := trim(v_line->>'name');
    if v_name is null or length(v_name) not between 2 and 160
       or (v_line->>'quantity') !~ '^[0-9]+(\.[0-9]{1,3})?$'
       or (v_line->>'unitPrice') !~ '^[0-9]+(\.[0-9]{1,2})?$' then
      raise exception 'invalid_invoice_line' using errcode = '22023';
    end if;
    v_quantity := (v_line->>'quantity')::numeric;
    v_unit_price := (v_line->>'unitPrice')::numeric;
    if v_quantity <= 0 or v_quantity > 10000 or v_unit_price < 0
       or v_unit_price > 999999999 or v_quantity * v_unit_price > 999999999999.99 then
      raise exception 'invalid_invoice_line' using errcode = '22023';
    end if;
    v_total := v_total + v_quantity * v_unit_price;
  end loop;
  if v_total <= 0 or v_total > 999999999999.99 then
    raise exception 'invalid_invoice_total' using errcode = '22023';
  end if;
  v_fingerprint := encode(extensions.digest(p_lines::text,'sha256'),'hex');
  v_admin_notes := left(nullif(trim(p_admin_notes),''),2000);

  perform pg_advisory_xact_lock(hashtext(v_org::text || ':' || p_request_key::text));
  select * into v_invoice from public.invoices
    where organization_id = v_org and request_key = p_request_key;
  if found then
    if not app.has_branch(v_invoice.branch_id) then
      raise exception 'not_authorized' using errcode = '42501';
    end if;
    if v_invoice.metadata->>'visit_id' is distinct from p_visit::text
       or v_invoice.metadata->>'line_fingerprint' is distinct from v_fingerprint
       or v_invoice.issued_at is distinct from p_issued_at
       or v_invoice.due_at is distinct from p_due_at
       or v_invoice.admin_notes is distinct from v_admin_notes then
      raise exception 'request_key_reused' using errcode = '22023';
    end if;
    return v_invoice;
  end if;

  select * into v_visit from public.manual_visits
    where organization_id = v_org and id = p_visit and deleted_at is null for update;
  if not found then raise exception 'visit_not_found' using errcode = 'P0002'; end if;
  if not app.has_branch(v_visit.branch_id) then raise exception 'not_authorized' using errcode = '42501'; end if;
  if v_visit.invoice_id is not null then raise exception 'visit_already_invoiced' using errcode = '55000'; end if;
  if exists (
    select 1 from public.visit_manual_billing
    where organization_id = v_org and source_type = 'manual_visit'
      and source_id = v_visit.id and undone_at is null
  ) then raise exception 'visit_has_active_manual_billing' using errcode = '55000'; end if;

  select coalesce(nullif(settings->>'currency',''),'IDR') into v_currency
    from public.organizations where id = v_org;
  insert into public.orders (organization_id, branch_id, customer_id, status, currency, metadata)
  values (v_org, v_visit.branch_id, v_visit.customer_id, 'confirmed', v_currency,
    jsonb_build_object('billing_mode','after_visit','source','manual_visit','request_key',p_request_key))
  returning * into v_order;

  for v_line in select value from jsonb_array_elements(p_lines) loop
    v_name := trim(v_line->>'name');
    v_quantity := (v_line->>'quantity')::numeric;
    v_unit_price := (v_line->>'unitPrice')::numeric;
    insert into public.order_items
      (organization_id, order_id, item_type, name_snapshot, quantity, unit_price, line_total, metadata)
    values (v_org, v_order.id, 'fee', v_name, v_quantity, v_unit_price,
      v_quantity * v_unit_price, jsonb_build_object('source','manual_visit','visit_id',v_visit.id));
  end loop;
  select * into v_order from public.orders where id = v_order.id;
  v_number := 'VIS-' || to_char(p_issued_at at time zone 'Asia/Jakarta', 'YYYYMMDD')
    || '-' || upper(substr(replace(p_request_key::text,'-',''),1,8));
  insert into public.invoices
    (organization_id,branch_id,customer_id,order_id,invoice_number,status,currency,
     subtotal,discount_total,tax_total,total,issued_at,due_at,billing_mode,document_type,
     admin_notes,request_key,metadata)
  values (v_org,v_visit.branch_id,v_visit.customer_id,v_order.id,v_number,'issued',v_order.currency,
    v_order.subtotal,v_order.discount_total,v_order.tax_total,v_order.total,p_issued_at,p_due_at,
    'after_visit','invoice',v_admin_notes,p_request_key,
    jsonb_build_object('source','manual_visit','visit_id',v_visit.id,'line_fingerprint',v_fingerprint))
  returning * into v_invoice;
  insert into public.invoice_lines
    (organization_id,invoice_id,item_type,name_snapshot,quantity,unit_price,line_total)
  select v_org,v_invoice.id,'fee',trim(value->>'name'),(value->>'quantity')::numeric,
    (value->>'unitPrice')::numeric,(value->>'quantity')::numeric * (value->>'unitPrice')::numeric
  from jsonb_array_elements(p_lines);
  update public.manual_visits set invoice_id = v_invoice.id, updated_by = auth.uid()
    where id = v_visit.id;
  return v_invoice;
end $$;

revoke all on function app.create_invoice_from_manual_visit_lines(uuid,timestamptz,timestamptz,jsonb,text,uuid) from public;
grant execute on function app.create_invoice_from_manual_visit_lines(uuid,timestamptz,timestamptz,jsonb,text,uuid) to authenticated;
commit;
