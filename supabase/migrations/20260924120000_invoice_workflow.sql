-- HomePaw-style invoice workflow on Operro's tenant-safe order/invoice snapshots.
begin;

alter table public.invoices
  add column billing_mode text not null default 'after_visit',
  add column document_type text not null default 'invoice',
  add column groomer_resource_id uuid,
  add column groomer_name_snapshot text,
  add column admin_notes text,
  add column request_key uuid,
  add column revision integer not null default 1,
  add constraint chk_invoices_billing_mode check (billing_mode in ('after_visit','package_sale')),
  add constraint chk_invoices_document_type check (document_type in ('invoice','service_report')),
  add constraint chk_invoices_revision check (revision > 0),
  add constraint fk_invoices_groomer foreign key (organization_id,groomer_resource_id)
    references public.resources(organization_id,id);

create unique index uq_invoice_request_key on public.invoices(organization_id,request_key) where request_key is not null;
create unique index uq_order_active_booking on public.orders(organization_id,booking_id)
  where booking_id is not null and status <> 'canceled' and deleted_at is null;

alter table public.order_items add column package_id uuid;
alter table public.invoice_lines add column package_id uuid;
alter table public.order_items add constraint fk_order_items_packages foreign key(organization_id,package_id) references public.packages(organization_id,id);
alter table public.invoice_lines add constraint fk_invoice_lines_packages foreign key(organization_id,package_id) references public.packages(organization_id,id);
alter table public.order_items drop constraint chk_order_items_type;
alter table public.invoice_lines drop constraint chk_invoice_lines_type;
alter table public.order_items add constraint chk_order_items_type check(item_type in ('service','product','package'));
alter table public.invoice_lines add constraint chk_invoice_lines_type check(item_type in ('service','product','package'));
alter table public.order_items add constraint chk_order_items_source check(
  (item_type='package' and package_id is not null and service_id is null and product_id is null)
  or (item_type<>'package' and package_id is null)
);
alter table public.invoice_lines add constraint chk_invoice_lines_source check(
  (item_type='package' and package_id is not null) or (item_type in ('service','product') and package_id is null)
);

create or replace function public.tg_invoices_freeze()
returns trigger language plpgsql as $$
begin
  if old.status in ('paid','void') and new is distinct from old then
    raise exception 'Final invoice % is locked.',old.invoice_number using errcode='restrict_violation';
  end if;
  if (new.subtotal,new.discount_total,new.tax_total,new.total,new.currency,new.invoice_number,new.order_id,new.billing_mode,new.request_key) is distinct from
     (old.subtotal,old.discount_total,old.tax_total,old.total,old.currency,old.invoice_number,old.order_id,old.billing_mode,old.request_key) then
    raise exception 'Issued invoice % monetary and identity fields are immutable.',old.invoice_number using errcode='restrict_violation';
  end if;
  return new;
end $$;

create or replace function app.update_unpaid_invoice_details(
  p_invoice uuid,p_revision integer,p_issued_at timestamptz,p_due_at timestamptz,
  p_document_type text,p_groomer uuid,p_manual_groomer text,p_admin_notes text)
returns public.invoices language plpgsql security definer set search_path=app,public as $$
declare v_org uuid:=app.fn_active_organization(); v_row public.invoices; v_name text;
begin
  if v_org is null or not app.has_membership() or not app.has_module('finance') or not app.has_permission('invoice.issue') then raise exception 'not_authorized' using errcode='42501'; end if;
  select * into v_row from public.invoices where organization_id=v_org and id=p_invoice for update;
  if not found then raise exception 'invoice_not_found' using errcode='P0002'; end if;
  if not app.has_branch(v_row.branch_id) then raise exception 'not_authorized' using errcode='42501'; end if;
  if v_row.status <> 'issued' or exists(select 1 from public.payments where organization_id=v_org and invoice_id=v_row.id and status='succeeded') then raise exception 'invoice_locked' using errcode='55000'; end if;
  if v_row.revision <> p_revision then raise exception 'stale_invoice' using errcode='40001'; end if;
  if p_document_type not in ('invoice','service_report') or p_issued_at is null or (p_due_at is not null and p_due_at < p_issued_at) then raise exception 'invalid_invoice_details' using errcode='22023'; end if;
  if p_groomer is not null then
    select name into v_name from public.resources where organization_id=v_org and id=p_groomer and branch_id=v_row.branch_id and kind='staff' and status='active' and deleted_at is null;
    if not found then raise exception 'groomer_not_found' using errcode='P0002'; end if;
  else
    v_name:=left(nullif(trim(p_manual_groomer),''),160);
  end if;
  update public.invoices set issued_at=p_issued_at,due_at=p_due_at,document_type=p_document_type,
    groomer_resource_id=p_groomer,groomer_name_snapshot=v_name,admin_notes=left(nullif(trim(p_admin_notes),''),2000),revision=revision+1
  where id=v_row.id returning * into v_row;
  return v_row;
end $$;

create or replace function app.create_package_invoice(
  p_branch uuid,p_customer uuid,p_package uuid,p_issued_at timestamptz,p_due_at timestamptz,
  p_admin_notes text,p_request_key uuid)
returns public.invoices language plpgsql security definer set search_path=app,public as $$
declare v_org uuid:=app.fn_active_organization(); v_pkg public.packages; v_order public.orders; v_invoice public.invoices; v_cp uuid; v_number text;
begin
  if v_org is null or not app.has_membership() or not app.has_module('finance') or not app.has_module('membership')
     or not app.has_permission('invoice.issue') or not app.has_permission('membership.manage') or not app.has_branch(p_branch) then raise exception 'not_authorized' using errcode='42501'; end if;
  if p_request_key is null or p_issued_at is null or (p_due_at is not null and p_due_at<p_issued_at) then raise exception 'invalid_invoice_details' using errcode='22023'; end if;
  select * into v_invoice from public.invoices where organization_id=v_org and request_key=p_request_key;
  if found then return v_invoice; end if;
  if not exists(select 1 from public.customers where organization_id=v_org and id=p_customer and deleted_at is null) then raise exception 'customer_not_found' using errcode='P0002'; end if;
  select * into v_pkg from public.packages where organization_id=v_org and id=p_package and is_active and deleted_at is null;
  if not found then raise exception 'package_not_found' using errcode='P0002'; end if;
  insert into public.orders(organization_id,branch_id,customer_id,status,currency,metadata)
  values(v_org,p_branch,p_customer,'confirmed',v_pkg.currency,jsonb_build_object('billing_mode','package_sale','request_key',p_request_key)) returning * into v_order;
  insert into public.order_items(organization_id,order_id,item_type,package_id,name_snapshot,quantity,unit_price,line_total,pricing_breakdown,metadata)
  values(v_org,v_order.id,'package',v_pkg.id,v_pkg.name,1,v_pkg.price,v_pkg.price,jsonb_build_object('sessions',v_pkg.total_sessions,'validity_days',v_pkg.validity_days),jsonb_build_object('source','package_catalog'));
  select * into v_order from public.orders where id=v_order.id;
  v_number:='PKG-'||to_char(p_issued_at at time zone 'Asia/Jakarta','YYYYMMDD')||'-'||upper(substr(replace(p_request_key::text,'-',''),1,8));
  insert into public.invoices(organization_id,branch_id,customer_id,order_id,invoice_number,status,currency,subtotal,discount_total,tax_total,total,issued_at,due_at,billing_mode,document_type,admin_notes,request_key,metadata)
  values(v_org,p_branch,p_customer,v_order.id,v_number,'issued',v_order.currency,v_order.subtotal,v_order.discount_total,v_order.tax_total,v_order.total,p_issued_at,p_due_at,'package_sale','invoice',left(nullif(trim(p_admin_notes),''),2000),p_request_key,jsonb_build_object('package_id',v_pkg.id)) returning * into v_invoice;
  insert into public.invoice_lines(organization_id,invoice_id,item_type,package_id,name_snapshot,quantity,unit_price,line_total,pricing_breakdown)
  values(v_org,v_invoice.id,'package',v_pkg.id,v_pkg.name,1,v_pkg.price,v_pkg.price,jsonb_build_object('sessions',v_pkg.total_sessions,'validity_days',v_pkg.validity_days));
  insert into public.customer_packages(organization_id,customer_id,package_id,service_id,sessions_remaining,purchased_at,expires_at,status,source_ref,metadata)
  values(v_org,p_customer,v_pkg.id,v_pkg.service_id,0,p_issued_at,case when v_pkg.validity_days is null then null else p_issued_at+(v_pkg.validity_days||' days')::interval end,'active',v_number,jsonb_build_object('source_invoice_id',v_invoice.id)) returning id into v_cp;
  insert into public.customer_package_ledger(organization_id,customer_package_id,delta,reason,notes)
  values(v_org,v_cp,v_pkg.total_sessions,'purchase','Invoice '||v_number);
  return v_invoice;
end $$;

revoke all on function app.update_unpaid_invoice_details(uuid,integer,timestamptz,timestamptz,text,uuid,text,text),app.create_package_invoice(uuid,uuid,uuid,timestamptz,timestamptz,text,uuid) from public;
grant execute on function app.update_unpaid_invoice_details(uuid,integer,timestamptz,timestamptz,text,uuid,text,text),app.create_package_invoice(uuid,uuid,uuid,timestamptz,timestamptz,text,uuid) to authenticated;
notify pgrst,'reload schema';
commit;
