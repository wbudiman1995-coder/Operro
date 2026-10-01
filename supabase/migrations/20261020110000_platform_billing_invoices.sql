-- Operro-to-business subscription invoices are distinct from a business's
-- customer grooming invoices. Financial terms are snapshotted at issue time.
begin;

create table public.platform_invoices (
  id uuid primary key default app.fn_uuid_v7(),
  organization_id uuid not null references public.organizations(id),
  period_month date not null,
  invoice_number text not null unique,
  description text not null,
  amount_idr numeric(14,2) not null check (amount_idr > 0),
  due_date date not null,
  issued_at timestamptz not null default now(),
  issued_by uuid not null references auth.users(id),
  unique (organization_id, period_month),
  constraint chk_platform_invoice_month check (period_month=date_trunc('month',period_month)::date),
  constraint fk_platform_invoice_billing foreign key (organization_id,period_month)
    references public.platform_billing_periods(organization_id,period_month)
);
create index idx_platform_invoices_org_issued on public.platform_invoices(organization_id,issued_at desc);
alter table public.platform_invoices enable row level security;
revoke all on public.platform_invoices from anon,authenticated;

create function app.issue_operro_invoice(p_org uuid,p_month date,p_description text default null)
returns uuid language plpgsql security definer set search_path='' as $$
declare v_bill public.platform_billing_periods; v_existing public.platform_invoices; v_id uuid;
        v_description text;
begin
  if not app.is_operro_owner() then raise exception 'not_authorized' using errcode='42501'; end if;
  if p_month is null or p_month<>date_trunc('month',p_month)::date then
    raise exception 'invalid_invoice_month' using errcode='22023'; end if;
  select * into v_bill from public.platform_billing_periods
    where organization_id=p_org and period_month=p_month for update;
  if not found or v_bill.amount_idr<=0 or v_bill.status='waived' then
    raise exception 'bill_not_issuable' using errcode='22023'; end if;
  v_description:=left(coalesce(nullif(btrim(p_description),''),'Langganan Operro '||to_char(p_month,'TMMonth YYYY')),300);
  select * into v_existing from public.platform_invoices
    where organization_id=p_org and period_month=p_month;
  if found then
    if v_existing.amount_idr<>v_bill.amount_idr or v_existing.due_date<>v_bill.due_date
      or v_existing.description<>v_description then
      raise exception 'invoice_already_issued_with_different_terms' using errcode='23505'; end if;
    return v_existing.id;
  end if;
  v_id:=app.fn_uuid_v7();
  insert into public.platform_invoices(id,organization_id,period_month,invoice_number,description,amount_idr,due_date,issued_by)
  values(v_id,p_org,p_month,'OPR-'||to_char(p_month,'YYYYMM')||'-'||upper(right(replace(v_id::text,'-',''),8)),
    v_description,v_bill.amount_idr,v_bill.due_date,auth.uid());
  return v_id;
end;
$$;
revoke all on function app.issue_operro_invoice(uuid,date,text) from public;
grant execute on function app.issue_operro_invoice(uuid,date,text) to authenticated;

-- Once an invoice exists, payment state can change but the issued financial
-- terms cannot. A correction requires an explicit future credit-note flow.
create or replace function app.set_operro_billing_period(p_org uuid,p_month date,p_amount numeric,p_due date,p_status text,p_note text default null)
returns void language plpgsql security definer set search_path='' as $$
begin
  if not app.is_operro_owner() then raise exception 'not_authorized' using errcode='42501'; end if;
  if p_month is null or p_month<>date_trunc('month',p_month)::date or p_amount is null or p_amount<0
    or p_due is null or p_status not in ('awaiting_payment','paid','overdue','waived')
    or not exists(select 1 from public.organizations where id=p_org and deleted_at is null)
  then raise exception 'invalid_billing_period' using errcode='22023'; end if;
  perform 1 from public.platform_billing_periods where organization_id=p_org and period_month=p_month for update;
  if exists(select 1 from public.platform_invoices i where i.organization_id=p_org and i.period_month=p_month
    and (i.amount_idr<>p_amount or i.due_date<>p_due or p_status='waived')) then
    raise exception 'issued_invoice_terms_locked' using errcode='23514'; end if;
  insert into public.platform_billing_periods(organization_id,period_month,amount_idr,due_date,status,paid_at,note,updated_by)
    values(p_org,p_month,p_amount,p_due,p_status,case when p_status='paid' then now() end,left(p_note,500),auth.uid())
  on conflict (organization_id,period_month) do update set amount_idr=excluded.amount_idr,due_date=excluded.due_date,
    status=excluded.status,paid_at=case when excluded.status='paid' then coalesce(public.platform_billing_periods.paid_at,now()) else null end,
    note=excluded.note,updated_at=now(),updated_by=auth.uid();
end $$;

create or replace function app.list_operro_billing(p_org uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
  if not app.is_operro_owner() then raise exception 'not_authorized' using errcode='42501'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('month',b.period_month,'amount',b.amount_idr,'due',b.due_date,
    'status',b.status,'paid_at',b.paid_at,'note',b.note,'invoice_id',i.id,'invoice_number',i.invoice_number)
    order by b.period_month desc)
    from public.platform_billing_periods b left join public.platform_invoices i
      on i.organization_id=b.organization_id and i.period_month=b.period_month
    where b.organization_id=p_org),'[]'::jsonb);
end $$;

-- The recipient can still read an invoice when their workspace is suspended
-- for non-payment. This RPC discloses only their own organization's document.
create function app.can_read_operro_invoice(p_org uuid) returns boolean
language sql stable security definer set search_path='' as $$
  select app.is_operro_owner() or exists (
    select 1 from public.memberships m join public.roles r on r.id=m.role_id and r.organization_id=m.organization_id
      join public.users u on u.id=m.user_id
    where m.user_id=auth.uid() and m.organization_id=p_org and m.status='active' and m.deleted_at is null
      and r.name in ('Pemilik','Owner','Pemilik Demo') and r.deleted_at is null
      and u.status='active' and u.deleted_at is null
  );
$$;
revoke all on function app.can_read_operro_invoice(uuid) from public;

create function app.get_operro_invoice(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare v_invoice public.platform_invoices; v_org_name text; v_status text; v_paid_at timestamptz; v_email text;
begin
  select * into v_invoice from public.platform_invoices where id=p_id;
  if not found then return null; end if;
  if not app.can_read_operro_invoice(v_invoice.organization_id) then
    raise exception 'not_authorized' using errcode='42501'; end if;
  select o.name,b.status,b.paid_at into v_org_name,v_status,v_paid_at
    from public.organizations o join public.platform_billing_periods b on b.organization_id=o.id
    where o.id=v_invoice.organization_id and b.period_month=v_invoice.period_month;
  select u.email into v_email from public.memberships m
    join public.roles r on r.id=m.role_id and r.organization_id=m.organization_id
    join public.users u on u.id=m.user_id
    where m.organization_id=v_invoice.organization_id and m.status='active' and m.deleted_at is null
      and r.name in ('Pemilik','Owner','Pemilik Demo') and u.status='active' and u.deleted_at is null
    order by m.created_at limit 1;
  return jsonb_build_object('id',v_invoice.id,'organization_id',v_invoice.organization_id,
    'organization_name',v_org_name,'recipient_email',v_email,'invoice_number',v_invoice.invoice_number,
    'period_month',v_invoice.period_month,'description',v_invoice.description,
    'amount_idr',v_invoice.amount_idr,'due_date',v_invoice.due_date,'issued_at',v_invoice.issued_at,
    'status',v_status,'paid_at',v_paid_at);
end;
$$;
revoke all on function app.get_operro_invoice(uuid) from public;
grant execute on function app.get_operro_invoice(uuid) to authenticated;

create function app.list_my_operro_invoices() returns jsonb
language sql stable security definer set search_path='' as $$
  select coalesce(jsonb_agg(app.get_operro_invoice(i.id) order by i.issued_at desc),'[]'::jsonb)
  from (select id,issued_at from public.platform_invoices
    where app.can_read_operro_invoice(organization_id)
    order by issued_at desc limit 100) i;
$$;
revoke all on function app.list_my_operro_invoices() from public;
grant execute on function app.list_my_operro_invoices() to authenticated;

commit;
