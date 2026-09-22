-- Branch-wide closure windows and dated served-city planning.
begin;

create table public.branch_availability_blocks (
  id uuid primary key default app.fn_uuid_v7(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  reason text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid, updated_by uuid, deleted_at timestamptz,
  constraint fk_branch_availability_blocks_branch foreign key (organization_id,branch_id) references public.branches(organization_id,id) on delete cascade,
  constraint chk_branch_availability_blocks_range check (ends_at>starts_at),
  constraint uq_branch_availability_blocks_org_id unique (organization_id,id)
);
create index idx_branch_availability_blocks_window on public.branch_availability_blocks(organization_id,branch_id,starts_at,ends_at) where deleted_at is null;

create table public.branch_served_city_dates (
  id uuid primary key default app.fn_uuid_v7(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid not null,
  service_date date not null,
  kabupaten_kota text not null,
  notes text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid, updated_by uuid, deleted_at timestamptz,
  constraint fk_branch_served_city_dates_branch foreign key (organization_id,branch_id) references public.branches(organization_id,id) on delete cascade,
  constraint uq_branch_served_city_dates unique nulls not distinct (organization_id,branch_id,service_date,kabupaten_kota,deleted_at),
  constraint uq_branch_served_city_dates_org_id unique (organization_id,id),
  constraint chk_branch_served_city_name check (length(trim(kabupaten_kota)) between 2 and 120)
);
create index idx_branch_served_city_dates_lookup on public.branch_served_city_dates(organization_id,branch_id,service_date) where deleted_at is null;

create trigger trg_branch_availability_blocks_updated before update on public.branch_availability_blocks for each row execute function app.tg_set_updated_at();
create trigger trg_branch_availability_blocks_cols before insert or update on public.branch_availability_blocks for each row execute function app.tg_set_audit_columns();
create trigger trg_branch_availability_blocks_audit after insert or update or delete on public.branch_availability_blocks for each row execute function app.tg_write_audit();
create trigger trg_branch_served_city_dates_updated before update on public.branch_served_city_dates for each row execute function app.tg_set_updated_at();
create trigger trg_branch_served_city_dates_cols before insert or update on public.branch_served_city_dates for each row execute function app.tg_set_audit_columns();
create trigger trg_branch_served_city_dates_audit after insert or update or delete on public.branch_served_city_dates for each row execute function app.tg_write_audit();

alter table public.branch_availability_blocks enable row level security;
alter table public.branch_served_city_dates enable row level security;
grant select,insert,update on public.branch_availability_blocks,public.branch_served_city_dates to authenticated;
create policy branch_blocks_tenant on public.branch_availability_blocks for all using (organization_id=app.fn_active_organization() and app.has_membership()) with check (organization_id=app.fn_active_organization() and app.has_membership());
create policy branch_blocks_write_ins on public.branch_availability_blocks as restrictive for insert with check (app.has_permission('resource.manage') and app.has_branch(branch_id));
create policy branch_blocks_write_upd on public.branch_availability_blocks as restrictive for update using (app.has_permission('resource.manage') and app.has_branch(branch_id)) with check (app.has_permission('resource.manage') and app.has_branch(branch_id));
create policy served_city_dates_tenant on public.branch_served_city_dates for all using (organization_id=app.fn_active_organization() and app.has_membership()) with check (organization_id=app.fn_active_organization() and app.has_membership());
create policy served_city_dates_write_ins on public.branch_served_city_dates as restrictive for insert with check (app.has_permission('resource.manage') and app.has_branch(branch_id));
create policy served_city_dates_write_upd on public.branch_served_city_dates as restrictive for update using (app.has_permission('resource.manage') and app.has_branch(branch_id)) with check (app.has_permission('resource.manage') and app.has_branch(branch_id));

create or replace function app.tg_reject_branch_block_booking_overlap() returns trigger language plpgsql security definer set search_path=app,public as $$
begin
  if new.deleted_at is null and exists (
    select 1 from public.bookings b join public.booking_resources br on br.organization_id=b.organization_id and br.booking_id=b.id and br.is_active
    where b.organization_id=new.organization_id and b.branch_id=new.branch_id and b.deleted_at is null and b.status not in ('canceled','no_show','completed')
      and br.during && tstzrange(new.starts_at,new.ends_at,'[)')
  ) then raise exception 'branch_block_booking_conflict' using errcode='23P01'; end if;
  return new;
end $$;
create trigger trg_branch_block_booking_overlap before insert or update on public.branch_availability_blocks for each row execute function app.tg_reject_branch_block_booking_overlap();

create or replace function app.tg_reject_booking_branch_block_overlap() returns trigger language plpgsql security definer set search_path=app,public as $$
declare v_branch uuid;
begin
  if not new.is_active then return new; end if;
  select branch_id into v_branch from public.bookings where organization_id=new.organization_id and id=new.booking_id and deleted_at is null;
  if exists (select 1 from public.branch_availability_blocks x where x.organization_id=new.organization_id and x.branch_id=v_branch and x.deleted_at is null and tstzrange(x.starts_at,x.ends_at,'[)') && new.during)
  then raise exception 'branch_closed' using errcode='23P01'; end if;
  return new;
end $$;
create trigger trg_booking_branch_block_overlap before insert or update of during,is_active on public.booking_resources for each row execute function app.tg_reject_booking_branch_block_overlap();

notify pgrst,'reload schema';
commit;
