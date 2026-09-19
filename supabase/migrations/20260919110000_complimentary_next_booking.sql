-- One-use customer offer, consumed atomically by the next successfully assembled booking.
create table public.customer_next_discounts (
  id uuid primary key default app.fn_uuid_v7(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  customer_id uuid not null,
  label text not null default 'Complimentary next appointment',
  rules jsonb not null,
  currency text not null default 'IDR',
  status text not null default 'active' check (status in ('active','consumed','revoked','expired')),
  expires_at timestamptz,
  consumed_at timestamptz,
  consumed_booking_id uuid,
  note text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid, updated_by uuid,
  constraint fk_customer_next_discounts_customer foreign key (organization_id,customer_id) references public.customers(organization_id,id),
  constraint fk_customer_next_discounts_booking foreign key (organization_id,consumed_booking_id) references public.bookings(organization_id,id),
  constraint uq_customer_next_discounts_org_id unique (organization_id,id),
  constraint chk_customer_next_discounts_rules check (jsonb_typeof(rules)='object')
);
create unique index uq_customer_next_discounts_active on public.customer_next_discounts(organization_id,customer_id) where status='active';
create index idx_customer_next_discounts_customer on public.customer_next_discounts(organization_id,customer_id,created_at desc);
create trigger trg_customer_next_discounts_updated before update on public.customer_next_discounts for each row execute function app.tg_set_updated_at();
create trigger trg_customer_next_discounts_audit_cols before insert or update on public.customer_next_discounts for each row execute function app.tg_set_audit_columns();
create trigger trg_customer_next_discounts_audit after insert or update or delete on public.customer_next_discounts for each row execute function app.tg_write_audit();
alter table public.customer_next_discounts enable row level security;
grant select,insert,update on public.customer_next_discounts to authenticated;
create policy customer_next_discounts_read on public.customer_next_discounts for select
using (organization_id=app.fn_active_organization() and app.has_permission('customer.read'));
create policy customer_next_discounts_insert on public.customer_next_discounts for insert
with check (organization_id=app.fn_active_organization() and app.has_permission('customer.manage'));
create policy customer_next_discounts_update on public.customer_next_discounts for update
using (organization_id=app.fn_active_organization() and app.has_permission('customer.manage'))
with check (organization_id=app.fn_active_organization() and app.has_permission('customer.manage'));

create or replace function app.set_customer_next_discount(
  p_customer uuid, p_rules jsonb, p_expires_at timestamptz default null,
  p_note text default null, p_label text default 'Complimentary next appointment'
) returns uuid language plpgsql security definer set search_path=app,public as $$
declare v_org uuid:=app.fn_active_organization(); v_scope text; v_rule jsonb; v_type text; v_value numeric; v_clean jsonb:='{}'; v_id uuid;
begin
  if v_org is null or not app.has_permission('customer.manage') then raise exception 'not_authorized' using errcode='42501'; end if;
  if not exists(select 1 from public.customers where organization_id=v_org and id=p_customer and deleted_at is null) then raise exception 'customer_not_found' using errcode='P0002'; end if;
  if p_expires_at is not null and p_expires_at<=now() then raise exception 'expiry_must_be_future' using errcode='22023'; end if;
  if jsonb_typeof(p_rules)<>'object' then raise exception 'invalid_discount_rules' using errcode='22023'; end if;
  foreach v_scope in array array['basic_grooming','styling','other'] loop
    v_rule:=p_rules->v_scope;
    if v_rule is null then continue; end if;
    v_type:=v_rule->>'type';
    begin v_value:=(v_rule->>'value')::numeric; exception when others then raise exception 'invalid_discount_value:%',v_scope using errcode='22023'; end;
    if v_type not in ('percent','fixed') or v_value<=0 or (v_type='percent' and v_value>100) then raise exception 'invalid_discount_rule:%',v_scope using errcode='22023'; end if;
    v_clean:=v_clean||jsonb_build_object(v_scope,jsonb_build_object('type',v_type,'value',v_value));
  end loop;
  if v_clean='{}'::jsonb then raise exception 'at_least_one_discount_rule_required' using errcode='22023'; end if;
  update public.customer_next_discounts set status='revoked' where organization_id=v_org and customer_id=p_customer and status='active';
  insert into public.customer_next_discounts(organization_id,customer_id,label,rules,expires_at,note)
  values(v_org,p_customer,left(coalesce(nullif(trim(p_label),''),'Complimentary next appointment'),120),v_clean,p_expires_at,left(p_note,500)) returning id into v_id;
  return v_id;
end $$;

create or replace function app.revoke_customer_next_discount(p_offer uuid)
returns void language plpgsql security definer set search_path=app,public as $$
declare v_org uuid:=app.fn_active_organization();
begin
  if v_org is null or not app.has_permission('customer.manage') then raise exception 'not_authorized' using errcode='42501'; end if;
  update public.customer_next_discounts set status='revoked' where organization_id=v_org and id=p_offer and status='active';
  if not found then raise exception 'active_offer_not_found' using errcode='P0002'; end if;
end $$;

create or replace function app.consume_customer_next_discount(p_booking uuid)
returns jsonb language plpgsql security definer set search_path=app,public as $$
declare
  v_org uuid:=app.fn_active_organization(); v_booking public.bookings; v_offer public.customer_next_discounts;
  v_line record; v_scope text; v_rule jsonb; v_type text; v_value numeric; v_gross numeric; v_discount numeric;
  v_basic_remaining numeric:=0; v_styling_remaining numeric:=0; v_other_remaining numeric:=0;
  v_lines jsonb:='{}'; v_total numeric:=0; v_snapshot jsonb;
begin
  select * into v_booking from public.bookings where organization_id=v_org and id=p_booking and deleted_at is null for update;
  if not found then raise exception 'booking_not_found' using errcode='P0002'; end if;
  perform app.assert_tenant_authorized(v_org,'scheduling','booking.create',v_booking.branch_id);
  if v_booking.metadata ? 'complimentary_next_discount' then return v_booking.metadata->'complimentary_next_discount'; end if;
  update public.customer_next_discounts set status='expired'
   where organization_id=v_org and customer_id=v_booking.customer_id and status='active' and expires_at is not null and expires_at<=now();
  select * into v_offer from public.customer_next_discounts
   where organization_id=v_org and customer_id=v_booking.customer_id and status='active'
     and (expires_at is null or expires_at>now()) order by created_at limit 1 for update;
  if not found then return null; end if;
  v_basic_remaining:=case when v_offer.rules#>>'{basic_grooming,type}'='fixed' then (v_offer.rules#>>'{basic_grooming,value}')::numeric else 0 end;
  v_styling_remaining:=case when v_offer.rules#>>'{styling,type}'='fixed' then (v_offer.rules#>>'{styling,value}')::numeric else 0 end;
  v_other_remaining:=case when v_offer.rules#>>'{other,type}'='fixed' then (v_offer.rules#>>'{other,value}')::numeric else 0 end;
  for v_line in
    select l.id,l.quantity,l.unit_price_snapshot,l.service_name_snapshot,sc.category
      from public.grooming_job_pet_services l
      join public.grooming_job_pets p on p.organization_id=l.organization_id and p.id=l.grooming_job_pet_id
      left join public.service_catalog sc on sc.organization_id=l.organization_id and sc.id=l.service_id
     where l.organization_id=v_org and p.grooming_job_id=p_booking and l.deleted_at is null and p.deleted_at is null order by p.sequence,l.created_at
  loop
    v_scope:=case
      when lower(coalesce(v_line.category,'')||' '||coalesce(v_line.service_name_snapshot,'')) ~ '(basic|mandi|bath)' then 'basic_grooming'
      when lower(coalesce(v_line.category,'')||' '||coalesce(v_line.service_name_snapshot,'')) ~ '(styling|style|trim|potong)' then 'styling'
      else 'other' end;
    v_rule:=v_offer.rules->v_scope;
    if v_rule is null then continue; end if;
    v_type:=v_rule->>'type'; v_value:=(v_rule->>'value')::numeric;
    v_gross:=round(v_line.unit_price_snapshot*v_line.quantity,2);
    if v_type='percent' then v_discount:=least(v_gross,round(v_gross*v_value/100,2));
    elsif v_scope='basic_grooming' then v_discount:=least(v_gross,v_basic_remaining); v_basic_remaining:=v_basic_remaining-v_discount;
    elsif v_scope='styling' then v_discount:=least(v_gross,v_styling_remaining); v_styling_remaining:=v_styling_remaining-v_discount;
    else v_discount:=least(v_gross,v_other_remaining); v_other_remaining:=v_other_remaining-v_discount; end if;
    if v_discount>0 then
      v_lines:=v_lines||jsonb_build_object(v_line.id,jsonb_build_object('amount',v_discount,'scope',v_scope,'type',v_type,'value',v_value));
      v_total:=v_total+v_discount;
    end if;
  end loop;
  v_snapshot:=jsonb_build_object('offerId',v_offer.id,'label',v_offer.label,'currency',v_offer.currency,'rules',v_offer.rules,'lineDiscounts',v_lines,'totalDiscount',v_total,'consumedAt',now());
  update public.bookings set metadata=metadata||jsonb_build_object('complimentary_next_discount',v_snapshot) where organization_id=v_org and id=p_booking;
  update public.customer_next_discounts set status='consumed',consumed_at=now(),consumed_booking_id=p_booking where organization_id=v_org and id=v_offer.id;
  return v_snapshot;
end $$;

create or replace function public.tg_strip_recurring_complimentary_discount()
returns trigger language plpgsql as $$ begin if coalesce(new.recurrence_sequence,1)>1 then new.metadata:=new.metadata-'complimentary_next_discount'; end if; return new; end $$;
create trigger trg_bookings_strip_recurring_discount before insert on public.bookings for each row execute function public.tg_strip_recurring_complimentary_discount();

revoke all on function app.set_customer_next_discount(uuid,jsonb,timestamptz,text,text) from public;
revoke all on function app.revoke_customer_next_discount(uuid) from public;
revoke all on function app.consume_customer_next_discount(uuid) from public;
grant execute on function app.set_customer_next_discount(uuid,jsonb,timestamptz,text,text) to authenticated;
grant execute on function app.revoke_customer_next_discount(uuid) to authenticated;
grant execute on function app.consume_customer_next_discount(uuid) to authenticated;
notify pgrst,'reload schema';
