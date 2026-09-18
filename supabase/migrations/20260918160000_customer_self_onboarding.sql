-- Customer self-onboarding: hashed single-use links and a review queue.
create table public.customer_onboarding_links (
  id uuid primary key default app.fn_uuid_v7(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  token_hash text not null unique,
  source text,
  internal_note text,
  status text not null default 'active' check (status in ('active','submitted','approved','rejected','revoked')),
  expires_at timestamptz not null default (now() + interval '2 days'),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid, updated_by uuid,
  constraint uq_customer_onboarding_links_org_id unique (organization_id,id)
);
create table public.customer_onboarding_submissions (
  id uuid primary key default app.fn_uuid_v7(),
  organization_id uuid not null,
  link_id uuid not null,
  payload jsonb not null,
  status text not null default 'submitted' check (status in ('submitted','approved','rejected')),
  reviewed_at timestamptz, reviewed_by uuid, merged_customer_id uuid,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  constraint fk_onboarding_submission_link foreign key (organization_id,link_id) references public.customer_onboarding_links(organization_id,id),
  constraint fk_onboarding_submission_customer foreign key (organization_id,merged_customer_id) references public.customers(organization_id,id),
  constraint uq_onboarding_submission_link unique (link_id),
  constraint uq_customer_onboarding_submissions_org_id unique (organization_id,id)
);
create index idx_onboarding_links_org_created on public.customer_onboarding_links(organization_id,created_at desc);
create index idx_onboarding_submissions_org_status on public.customer_onboarding_submissions(organization_id,status,created_at desc);
create trigger trg_onboarding_links_updated before update on public.customer_onboarding_links for each row execute function app.tg_set_updated_at();
create trigger trg_onboarding_submissions_updated before update on public.customer_onboarding_submissions for each row execute function app.tg_set_updated_at();
create trigger trg_onboarding_links_audit_cols before insert or update on public.customer_onboarding_links for each row execute function app.tg_set_audit_columns();
create trigger trg_onboarding_submissions_audit_cols before insert or update on public.customer_onboarding_submissions for each row execute function app.tg_set_audit_columns();
create trigger trg_onboarding_links_audit after insert or update or delete on public.customer_onboarding_links for each row execute function app.tg_write_audit();
create trigger trg_onboarding_submissions_audit after insert or update or delete on public.customer_onboarding_submissions for each row execute function app.tg_write_audit();
alter table public.customer_onboarding_links enable row level security;
alter table public.customer_onboarding_submissions enable row level security;
grant select,insert,update on public.customer_onboarding_links to authenticated;
grant select,update on public.customer_onboarding_submissions to authenticated;
create policy onboarding_links_org on public.customer_onboarding_links for all using (organization_id=app.fn_active_organization()) with check (organization_id=app.fn_active_organization());
create policy onboarding_links_manage on public.customer_onboarding_links as restrictive for all using (app.has_permission('customer.manage')) with check (app.has_permission('customer.manage'));
create policy onboarding_submissions_org on public.customer_onboarding_submissions for all using (organization_id=app.fn_active_organization()) with check (organization_id=app.fn_active_organization());
create policy onboarding_submissions_manage on public.customer_onboarding_submissions as restrictive for all using (app.has_permission('customer.manage')) with check (app.has_permission('customer.manage'));

create or replace function app.get_customer_onboarding_link(p_token text)
returns table(valid boolean,status text,expires_at timestamptz,organization_name text)
language sql security definer set search_path=app,public,extensions as $$
  select (l.status='active' and l.expires_at>now()), case when l.expires_at<=now() and l.status='active' then 'expired' else l.status end,
         l.expires_at,o.name
  from public.customer_onboarding_links l join public.organizations o on o.id=l.organization_id
  where l.token_hash=encode(extensions.digest(p_token,'sha256'),'hex') limit 1
$$;

create or replace function app.submit_customer_onboarding(p_token text,p_payload jsonb)
returns uuid language plpgsql security definer set search_path=app,public,extensions as $$
declare v_link public.customer_onboarding_links; v_id uuid; v_pets jsonb;
begin
  select * into v_link from public.customer_onboarding_links where token_hash=encode(extensions.digest(p_token,'sha256'),'hex') for update;
  if not found or v_link.status<>'active' then raise exception 'link_not_available' using errcode='P0002'; end if;
  if v_link.expires_at<=now() then raise exception 'link_expired' using errcode='22023'; end if;
  v_pets:=p_payload->'pets';
  if jsonb_typeof(p_payload)<>'object' or length(trim(coalesce(p_payload->>'customerName','')))<2 or length(trim(coalesce(p_payload->>'phone','')))<7
     or jsonb_typeof(v_pets)<>'array' or jsonb_array_length(v_pets)<1 or jsonb_array_length(v_pets)>5 then
    raise exception 'invalid_submission' using errcode='22023';
  end if;
  if exists(select 1 from jsonb_array_elements(v_pets) p where length(trim(coalesce(p->>'name','')))<1) then raise exception 'invalid_pet' using errcode='22023'; end if;
  insert into public.customer_onboarding_submissions(organization_id,link_id,payload) values(v_link.organization_id,v_link.id,p_payload) returning id into v_id;
  update public.customer_onboarding_links set status='submitted' where id=v_link.id;
  return v_id;
end $$;

create or replace function app.review_customer_onboarding(p_submission uuid,p_decision text,p_merge_customer uuid default null)
returns uuid language plpgsql security definer set search_path=app,public as $$
declare v_org uuid:=app.fn_active_organization(); v_sub public.customer_onboarding_submissions; v_link public.customer_onboarding_links; v_customer uuid; v_pet jsonb; v_payload jsonb; v_lat numeric; v_lng numeric;
begin
  if v_org is null or not app.has_permission('customer.manage') then raise exception 'not_authorized' using errcode='42501'; end if;
  if p_decision not in ('approve','reject') then raise exception 'invalid_decision' using errcode='22023'; end if;
  select * into v_sub from public.customer_onboarding_submissions where organization_id=v_org and id=p_submission and status='submitted' for update;
  if not found then raise exception 'submission_not_found' using errcode='P0002'; end if;
  select * into v_link from public.customer_onboarding_links where organization_id=v_org and id=v_sub.link_id for update;
  if p_decision='reject' then
    update public.customer_onboarding_submissions set status='rejected',reviewed_at=now(),reviewed_by=auth.uid() where id=v_sub.id;
    update public.customer_onboarding_links set status='rejected' where id=v_link.id; return null;
  end if;
  v_payload:=v_sub.payload;
  if p_merge_customer is not null then
    select id into v_customer from public.customers where organization_id=v_org and id=p_merge_customer and deleted_at is null;
    if not found then raise exception 'merge_customer_not_found' using errcode='P0002'; end if;
  else
    insert into public.customers(organization_id,display_name,phone,status,source,notes,metadata)
    values(v_org,left(trim(v_payload->>'customerName'),120),left(trim(v_payload->>'phone'),40),'active',coalesce(v_link.source,'Self onboarding'),left(v_payload->>'customerNotes',2000),jsonb_build_object('created_from','self_onboarding','onboarding_submission_id',v_sub.id)) returning id into v_customer;
  end if;
  for v_pet in select value from jsonb_array_elements(v_payload->'pets') loop
    insert into public.pets(organization_id,customer_id,name,species,breed,weight_kg,color,notes,status,metadata)
    values(v_org,v_customer,left(trim(v_pet->>'name'),80),case when v_pet->>'species'='cat' then 'cat' else 'dog' end,left(nullif(trim(v_pet->>'breed'),''),100),nullif(v_pet->>'weightKg','')::numeric,left(nullif(trim(v_pet->>'color'),''),80),left(nullif(trim(v_pet->>'notes'),''),1000),'active',jsonb_build_object('created_from','self_onboarding','stated_age',coalesce(v_pet->>'age','')));
  end loop;
  if p_merge_customer is null and length(trim(coalesce(v_payload->>'addressLine','')))>0 then
    begin v_lat:=nullif(v_payload->>'latitude','')::numeric; v_lng:=nullif(v_payload->>'longitude','')::numeric; exception when others then v_lat:=null;v_lng:=null; end;
    insert into public.customer_addresses(organization_id,customer_id,label,recipient_name,recipient_phone,line1,kecamatan,kabupaten_kota,latitude,longitude,is_default)
    values(v_org,v_customer,'Rumah',left(v_payload->>'customerName',120),left(v_payload->>'phone',40),left(v_payload->>'addressLine',200),left(nullif(v_payload->>'kecamatan',''),100),left(nullif(v_payload->>'kabupatenKota',''),100),case when abs(v_lat)<=90 then v_lat end,case when abs(v_lng)<=180 then v_lng end,true);
  end if;
  update public.customer_onboarding_submissions set status='approved',reviewed_at=now(),reviewed_by=auth.uid(),merged_customer_id=v_customer where id=v_sub.id;
  update public.customer_onboarding_links set status='approved' where id=v_link.id;
  return v_customer;
end $$;

revoke all on function app.get_customer_onboarding_link(text) from public;
revoke all on function app.submit_customer_onboarding(text,jsonb) from public;
revoke all on function app.review_customer_onboarding(uuid,text,uuid) from public;
grant execute on function app.get_customer_onboarding_link(text) to anon,authenticated;
grant execute on function app.submit_customer_onboarding(text,jsonb) to anon,authenticated;
grant execute on function app.review_customer_onboarding(uuid,text,uuid) to authenticated;
notify pgrst,'reload schema';
