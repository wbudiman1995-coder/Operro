-- Tenant-safe complaint lifecycle with operational links, recovery notes and audit history.
begin;

insert into public.subject_types(key,description) values('complaint','Customer complaint') on conflict(key) do nothing;

create table public.complaints (
  id uuid primary key default app.fn_uuid_v7(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid not null,
  reference_code text not null default ('CMP-'||upper(substr(replace(gen_random_uuid()::text,'-',''),1,8))),
  customer_id uuid not null,
  booking_id uuid,
  pet_id uuid,
  assigned_resource_id uuid,
  category text not null,
  severity text not null,
  status text not null default 'open',
  title text not null,
  description text not null,
  resolution_notes text,
  recovery_action text,
  reported_at timestamptz not null default now(),
  acknowledged_at timestamptz,
  resolved_at timestamptz,
  closed_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid, updated_by uuid, deleted_at timestamptz,
  constraint fk_complaint_branch foreign key(organization_id,branch_id) references public.branches(organization_id,id),
  constraint fk_complaint_customer foreign key(organization_id,customer_id) references public.customers(organization_id,id),
  constraint fk_complaint_booking foreign key(organization_id,booking_id) references public.bookings(organization_id,id),
  constraint fk_complaint_pet foreign key(organization_id,pet_id) references public.pets(organization_id,id),
  constraint fk_complaint_resource foreign key(organization_id,assigned_resource_id) references public.resources(organization_id,id),
  constraint uq_complaint_org_id unique(organization_id,id),
  constraint uq_complaint_reference unique(organization_id,reference_code),
  constraint chk_complaint_category check(category in ('service_quality','injury','behavior','billing','lateness','communication','other')),
  constraint chk_complaint_severity check(severity in ('low','medium','high','critical')),
  constraint chk_complaint_status check(status in ('open','investigating','resolved','closed')),
  constraint chk_complaint_title check(length(trim(title)) between 3 and 160),
  constraint chk_complaint_description check(length(trim(description)) between 3 and 4000)
);
create index idx_complaints_queue on public.complaints(organization_id,status,severity,reported_at desc) where deleted_at is null;
create index idx_complaints_customer on public.complaints(organization_id,customer_id,reported_at desc) where deleted_at is null;
create index idx_complaints_resource on public.complaints(organization_id,assigned_resource_id,reported_at desc) where deleted_at is null;
create trigger trg_complaints_updated before update on public.complaints for each row execute function app.tg_set_updated_at();
create trigger trg_complaints_cols before insert or update on public.complaints for each row execute function app.tg_set_audit_columns();
create trigger trg_complaints_audit after insert or update or delete on public.complaints for each row execute function app.tg_write_audit();

alter table public.complaints enable row level security;
revoke insert,update,delete on public.complaints from anon,authenticated;
grant select on public.complaints to authenticated;
create policy complaints_read on public.complaints for select to authenticated using (
  organization_id=app.fn_active_organization() and app.has_membership() and app.has_module('crm')
  and (app.has_permission('customer.read') or app.has_permission('task.manage') or app.has_permission('reports.view'))
  and app.has_branch(branch_id)
);

create or replace function app.create_complaint(
  p_branch uuid,p_customer uuid,p_booking uuid,p_pet uuid,p_resource uuid,
  p_category text,p_severity text,p_title text,p_description text)
returns public.complaints language plpgsql security definer set search_path=app,public as $$
declare v_org uuid:=app.fn_active_organization(); v_row public.complaints;
begin
  if v_org is null or not app.has_membership() or not app.has_module('crm') or not (app.has_permission('task.manage') or app.has_permission('customer.manage')) or not app.has_branch(p_branch) then raise exception 'not_authorized' using errcode='42501'; end if;
  if p_category not in ('service_quality','injury','behavior','billing','lateness','communication','other') or p_severity not in ('low','medium','high','critical') or length(trim(coalesce(p_title,'')))<3 or length(trim(coalesce(p_description,'')))<3 then raise exception 'invalid_complaint' using errcode='22023'; end if;
  if not exists(select 1 from public.customers c where c.organization_id=v_org and c.id=p_customer and c.deleted_at is null) then raise exception 'customer_not_found' using errcode='P0002'; end if;
  if p_booking is not null and not exists(select 1 from public.bookings b where b.organization_id=v_org and b.id=p_booking and b.branch_id=p_branch and b.customer_id=p_customer and b.deleted_at is null) then raise exception 'booking_mismatch' using errcode='22023'; end if;
  if p_pet is not null and not exists(select 1 from public.pets p where p.organization_id=v_org and p.id=p_pet and p.customer_id=p_customer and p.deleted_at is null) then raise exception 'pet_mismatch' using errcode='22023'; end if;
  if p_resource is not null and not exists(select 1 from public.resources r where r.organization_id=v_org and r.id=p_resource and r.branch_id=p_branch and r.kind='staff' and r.deleted_at is null) then raise exception 'resource_mismatch' using errcode='22023'; end if;
  insert into public.complaints(organization_id,branch_id,customer_id,booking_id,pet_id,assigned_resource_id,category,severity,title,description)
  values(v_org,p_branch,p_customer,p_booking,p_pet,p_resource,p_category,p_severity,left(trim(p_title),160),left(trim(p_description),4000)) returning * into v_row;
  insert into public.timeline_events(organization_id,subject_type,subject_id,actor_id,event_type,summary,data)
  values(v_org,'complaint',v_row.id,auth.uid(),'complaint.created','Complaint created',jsonb_build_object('reference_code',v_row.reference_code,'severity',v_row.severity,'customer_id',v_row.customer_id,'booking_id',v_row.booking_id,'resource_id',v_row.assigned_resource_id));
  return v_row;
end $$;

create or replace function app.update_complaint(
  p_complaint uuid,p_severity text,p_resource uuid,p_resolution_notes text,p_recovery_action text)
returns public.complaints language plpgsql security definer set search_path=app,public as $$
declare v_org uuid:=app.fn_active_organization(); v_row public.complaints;
begin
  if v_org is null or not app.has_membership() or not (app.has_permission('task.manage') or app.has_permission('customer.manage')) then raise exception 'not_authorized' using errcode='42501'; end if;
  if p_severity not in ('low','medium','high','critical') then raise exception 'invalid_severity' using errcode='22023'; end if;
  select * into v_row from public.complaints where organization_id=v_org and id=p_complaint and deleted_at is null for update;
  if not found then raise exception 'complaint_not_found' using errcode='P0002'; end if;
  if not app.has_branch(v_row.branch_id) then raise exception 'not_authorized' using errcode='42501'; end if;
  if p_resource is not null and not exists(select 1 from public.resources r where r.organization_id=v_org and r.id=p_resource and r.branch_id=v_row.branch_id and r.kind='staff' and r.deleted_at is null) then raise exception 'resource_mismatch' using errcode='22023'; end if;
  update public.complaints set severity=p_severity,assigned_resource_id=p_resource,resolution_notes=left(nullif(trim(p_resolution_notes),''),4000),recovery_action=left(nullif(trim(p_recovery_action),''),2000) where id=v_row.id returning * into v_row;
  insert into public.timeline_events(organization_id,subject_type,subject_id,actor_id,event_type,summary,data)
  values(v_org,'complaint',v_row.id,auth.uid(),'complaint.updated','Complaint details updated',jsonb_build_object('severity',v_row.severity,'resource_id',v_row.assigned_resource_id,'has_recovery_action',v_row.recovery_action is not null));
  return v_row;
end $$;

create or replace function app.transition_complaint(p_complaint uuid,p_to text,p_resolution_notes text default null,p_recovery_action text default null)
returns public.complaints language plpgsql security definer set search_path=app,public as $$
declare v_org uuid:=app.fn_active_organization(); v_row public.complaints; v_allowed boolean;
begin
  if v_org is null or not app.has_membership() or not (app.has_permission('task.manage') or app.has_permission('customer.manage')) then raise exception 'not_authorized' using errcode='42501'; end if;
  select * into v_row from public.complaints where organization_id=v_org and id=p_complaint and deleted_at is null for update;
  if not found then raise exception 'complaint_not_found' using errcode='P0002'; end if;
  if not app.has_branch(v_row.branch_id) then raise exception 'not_authorized' using errcode='42501'; end if;
  v_allowed:=case v_row.status when 'open' then p_to in ('investigating','resolved','closed') when 'investigating' then p_to in ('resolved','closed') when 'resolved' then p_to in ('investigating','closed') when 'closed' then p_to='investigating' else false end;
  if not v_allowed then raise exception 'invalid_complaint_transition:%->%',v_row.status,p_to using errcode='22023'; end if;
  if p_to in ('resolved','closed') and length(trim(coalesce(p_resolution_notes,v_row.resolution_notes,'')))<3 then raise exception 'resolution_notes_required' using errcode='22023'; end if;
  update public.complaints set status=p_to,
    resolution_notes=coalesce(left(nullif(trim(p_resolution_notes),''),4000),resolution_notes),
    recovery_action=coalesce(left(nullif(trim(p_recovery_action),''),2000),recovery_action),
    acknowledged_at=case when p_to='investigating' then coalesce(acknowledged_at,now()) else acknowledged_at end,
    resolved_at=case when p_to='resolved' then now() when p_to='investigating' then null else resolved_at end,
    closed_at=case when p_to='closed' then now() when p_to='investigating' then null else closed_at end
  where id=v_row.id returning * into v_row;
  insert into public.timeline_events(organization_id,subject_type,subject_id,actor_id,event_type,summary,data)
  values(v_org,'complaint',v_row.id,auth.uid(),'complaint.status_changed','Complaint status changed',jsonb_build_object('to',p_to,'resolution_notes',v_row.resolution_notes,'recovery_action',v_row.recovery_action));
  return v_row;
end $$;

revoke all on function app.create_complaint(uuid,uuid,uuid,uuid,uuid,text,text,text,text),app.update_complaint(uuid,text,uuid,text,text),app.transition_complaint(uuid,text,text,text) from public;
grant execute on function app.create_complaint(uuid,uuid,uuid,uuid,uuid,text,text,text,text),app.update_complaint(uuid,text,uuid,text,text),app.transition_complaint(uuid,text,text,text) to authenticated;
notify pgrst,'reload schema';
commit;
