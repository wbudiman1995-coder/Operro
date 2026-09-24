-- GPS/photo attendance tied to the real groomer resource, booking and payroll cycle.
begin;

create table public.attendance_records (
  id uuid primary key default app.fn_uuid_v7(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid not null,
  booking_id uuid not null,
  resource_id uuid not null,
  membership_id uuid not null,
  scheduled_at timestamptz not null,
  checked_in_at timestamptz not null default now(),
  latitude numeric(10,7), longitude numeric(10,7), accuracy_meters numeric(10,2),
  classification text not null,
  late_minutes integer not null default 0,
  photo_attachment_id uuid,
  late_reason text,
  waived_at timestamptz, waived_by uuid, waiver_reason text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid, updated_by uuid, deleted_at timestamptz,
  constraint fk_attendance_branch foreign key (organization_id,branch_id) references public.branches(organization_id,id),
  constraint fk_attendance_booking foreign key (organization_id,booking_id) references public.bookings(organization_id,id),
  constraint fk_attendance_resource foreign key (organization_id,resource_id) references public.resources(organization_id,id),
  constraint fk_attendance_membership foreign key (organization_id,membership_id) references public.memberships(organization_id,id),
  constraint fk_attendance_photo foreign key (organization_id,photo_attachment_id) references public.attachments(organization_id,id),
  constraint uq_attendance_booking_resource unique (organization_id,booking_id,resource_id),
  constraint uq_attendance_org_id unique (organization_id,id),
  constraint chk_attendance_classification check (classification in ('on_time','late','missing_photo')),
  constraint chk_attendance_late_minutes check (late_minutes>=0),
  constraint chk_attendance_lat check (latitude is null or latitude between -90 and 90),
  constraint chk_attendance_lng check (longitude is null or longitude between -180 and 180),
  constraint chk_attendance_accuracy check (accuracy_meters is null or accuracy_meters>=0)
);
create index idx_attendance_cycle on public.attendance_records(organization_id,checked_in_at,membership_id) where deleted_at is null;
create index idx_attendance_resource on public.attendance_records(organization_id,resource_id,checked_in_at) where deleted_at is null;
create trigger trg_attendance_updated before update on public.attendance_records for each row execute function app.tg_set_updated_at();
create trigger trg_attendance_cols before insert or update on public.attendance_records for each row execute function app.tg_set_audit_columns();
create trigger trg_attendance_audit after insert or update or delete on public.attendance_records for each row execute function app.tg_write_audit();

alter table public.attendance_records enable row level security;
grant select on public.attendance_records to authenticated;
create policy attendance_read on public.attendance_records for select to authenticated using (
  organization_id=app.fn_active_organization() and app.has_membership() and (
    app.has_permission('payroll.read') or app.has_permission('resource.manage') or
    membership_id in (select m.id from public.memberships m where m.organization_id=app.fn_active_organization() and m.user_id=auth.uid() and m.status='active' and m.deleted_at is null)
  )
);

create or replace function app.record_attendance_checkin(p_booking uuid,p_resource uuid,p_attachment uuid,p_latitude numeric,p_longitude numeric,p_accuracy numeric,p_late_reason text default null)
returns public.attendance_records language plpgsql security definer set search_path=app,public as $$
declare v_org uuid:=app.fn_active_organization(); v_membership uuid; v_booking public.bookings%rowtype; v_grace integer:=10; v_checked timestamptz:=now(); v_late integer; v_class text; v_row public.attendance_records;
begin
  select m.id into v_membership from public.memberships m where m.organization_id=v_org and m.user_id=auth.uid() and m.status='active' and m.deleted_at is null;
  if v_membership is null then raise exception 'attendance_membership_not_found' using errcode='42501'; end if;
  if not exists(select 1 from public.resources r where r.organization_id=v_org and r.id=p_resource and r.membership_id=v_membership and r.kind='staff' and r.status='active' and r.deleted_at is null) then raise exception 'attendance_resource_not_owned' using errcode='42501'; end if;
  select * into v_booking from public.bookings b where b.organization_id=v_org and b.id=p_booking and b.deleted_at is null and b.status not in ('canceled','no_show') for share;
  if not found then raise exception 'attendance_booking_not_found' using errcode='P0002'; end if;
  if not exists(select 1 from public.grooming_job_pets p where p.organization_id=v_org and p.grooming_job_id=p_booking and p.assigned_resource_id=p_resource and p.deleted_at is null) then raise exception 'attendance_not_assigned' using errcode='42501'; end if;
  if p_attachment is null or not exists(
    select 1 from public.attachments a
    join public.attachment_links l on l.organization_id=a.organization_id and l.attachment_id=a.id
    where a.organization_id=v_org and a.id=p_attachment and a.uploaded_by=auth.uid() and a.deleted_at is null
      and a.metadata->>'category'='attendance' and l.subject_type='booking' and l.subject_id=p_booking
  ) then raise exception 'attendance_photo_required' using errcode='22023'; end if;
  if p_latitude is null or p_latitude not between -90 and 90 or p_longitude is null or p_longitude not between -180 and 180 then raise exception 'attendance_location_required' using errcode='22023'; end if;
  select case when o.settings#>>'{attendance,lateGraceMinutes}' ~ '^\d{1,3}$' then (o.settings#>>'{attendance,lateGraceMinutes}')::integer else 10 end
    into v_grace from public.organizations o where o.id=v_org;
  v_grace:=greatest(0,least(coalesce(v_grace,10),120));
  v_late:=greatest(0,ceil(extract(epoch from (v_checked-v_booking.starts_at))/60)::integer);
  v_class:=case when v_late>v_grace then 'late' else 'on_time' end;
  insert into public.attendance_records(organization_id,branch_id,booking_id,resource_id,membership_id,scheduled_at,checked_in_at,latitude,longitude,accuracy_meters,classification,late_minutes,photo_attachment_id,late_reason)
  values(v_org,v_booking.branch_id,p_booking,p_resource,v_membership,v_booking.starts_at,v_checked,p_latitude,p_longitude,p_accuracy,v_class,v_late,p_attachment,left(nullif(trim(p_late_reason),''),500)) returning * into v_row;
  insert into public.timeline_events(organization_id,subject_type,subject_id,actor_id,event_type,summary,data) values(v_org,'booking',p_booking,auth.uid(),'attendance.checked_in','Groomer attendance recorded',jsonb_build_object('resource_id',p_resource,'classification',v_class,'late_minutes',v_late));
  return v_row;
exception when unique_violation then raise exception 'attendance_already_recorded' using errcode='23505';
end $$;

create or replace function app.waive_attendance_lateness(p_attendance uuid,p_reason text)
returns public.attendance_records language plpgsql security definer set search_path=app,public as $$
declare v_org uuid:=app.fn_active_organization(); v_row public.attendance_records;
begin
  if length(trim(coalesce(p_reason,'')))<3 then raise exception 'waiver_reason_required' using errcode='22023'; end if;
  perform app.assert_tenant_authorized(v_org,'payroll','payroll.manage',null);
  update public.attendance_records set waived_at=now(),waived_by=auth.uid(),waiver_reason=left(trim(p_reason),500)
   where organization_id=v_org and id=p_attendance and deleted_at is null and classification='late' returning * into v_row;
  if v_row.id is null then raise exception 'attendance_not_found_or_not_late' using errcode='P0002'; end if;
  insert into public.timeline_events(organization_id,subject_type,subject_id,actor_id,event_type,summary,data) values(v_org,'resource',v_row.resource_id,auth.uid(),'attendance.lateness_waived','Attendance lateness waived',jsonb_build_object('attendance_id',v_row.id,'reason',v_row.waiver_reason));
  return v_row;
end $$;

create or replace function app.materialize_missing_attendance(p_from timestamptz,p_to timestamptz)
returns integer language plpgsql security definer set search_path=app,public as $$
declare v_org uuid:=app.fn_active_organization(); v_count integer;
begin
  perform app.assert_tenant_authorized(v_org,'payroll','payroll.manage',null);
  if p_from is null or p_to is null or p_to<=p_from or p_to-p_from>interval '62 days' then raise exception 'invalid_attendance_window' using errcode='22023'; end if;
  with candidates as (
    select distinct b.organization_id,b.branch_id,b.id booking_id,r.id resource_id,r.membership_id,b.starts_at
    from public.bookings b join public.grooming_job_pets p on p.organization_id=b.organization_id and p.grooming_job_id=b.id and p.deleted_at is null
    join public.resources r on r.organization_id=p.organization_id and r.id=p.assigned_resource_id and r.membership_id is not null
    where b.organization_id=v_org and b.starts_at>=p_from and b.starts_at<p_to and b.starts_at<now()-interval '2 hours'
      and b.deleted_at is null and b.status not in ('canceled','no_show')
  ), inserted as (
    insert into public.attendance_records(organization_id,branch_id,booking_id,resource_id,membership_id,scheduled_at,checked_in_at,classification,metadata)
    select c.organization_id,c.branch_id,c.booking_id,c.resource_id,c.membership_id,c.starts_at,c.starts_at+interval '2 hours','missing_photo',jsonb_build_object('materialized_at',now()) from candidates c
    on conflict (organization_id,booking_id,resource_id) do nothing returning 1
  ) select count(*) into v_count from inserted;
  return coalesce(v_count,0);
end $$;

revoke all on function app.record_attendance_checkin(uuid,uuid,uuid,numeric,numeric,numeric,text),app.waive_attendance_lateness(uuid,text),app.materialize_missing_attendance(timestamptz,timestamptz) from public;
grant execute on function app.record_attendance_checkin(uuid,uuid,uuid,numeric,numeric,numeric,text),app.waive_attendance_lateness(uuid,text),app.materialize_missing_attendance(timestamptz,timestamptz) to authenticated;
notify pgrst,'reload schema';
commit;
