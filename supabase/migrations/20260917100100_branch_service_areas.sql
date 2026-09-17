-- =====================================================================
-- Home-service coverage per branch: a configurable kecamatan/kabupaten
-- allow-list with a flat travel fee and estimated travel time.
--
-- Deliberately structured for radius/polygon support to follow later:
-- `kecamatan`/`kabupaten_kota` are the v1 matching keys, but latitude/
-- longitude/radius_meters are already present (nullable, unused today)
-- so a future geofence check can reuse this same table without a
-- migration that reshapes it.
-- =====================================================================

create table public.branch_service_areas (
  id                      uuid        not null default app.fn_uuid_v7(),
  organization_id         uuid        not null,
  branch_id               uuid        not null,
  kecamatan               text,
  kabupaten_kota          text        not null,
  travel_fee              numeric(14,2) not null default 0,
  estimated_travel_minutes integer    not null default 0,
  center_latitude         numeric(9,6),   -- reserved for future radius matching
  center_longitude        numeric(9,6),   -- reserved for future radius matching
  radius_meters           integer,        -- reserved for future radius matching
  is_active               boolean     not null default true,
  notes                   text,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  created_by              uuid,
  updated_by              uuid,
  deleted_at              timestamptz,
  constraint pk_branch_service_areas primary key (id),
  constraint fk_branch_service_areas_organizations foreign key (organization_id)
    references public.organizations (id) on delete cascade,
  constraint fk_branch_service_areas_branches foreign key (organization_id, branch_id)
    references public.branches (organization_id, id) on delete cascade,
  constraint uq_branch_service_areas_org_id unique (organization_id, id),
  constraint uq_branch_service_areas_zone unique (organization_id, branch_id, kabupaten_kota, kecamatan),
  constraint chk_branch_service_areas_fee check (travel_fee >= 0),
  constraint chk_branch_service_areas_minutes check (estimated_travel_minutes >= 0)
);
create index idx_branch_service_areas_org_branch on public.branch_service_areas (organization_id, branch_id) where deleted_at is null;

create trigger trg_branch_service_areas_updated_at before update on public.branch_service_areas
  for each row execute function app.tg_set_updated_at();
create trigger trg_branch_service_areas_audit_cols before insert or update on public.branch_service_areas
  for each row execute function app.tg_set_audit_columns();

alter table public.branch_service_areas enable row level security;

grant select, insert, update, delete on public.branch_service_areas to authenticated;

create policy branch_service_areas_org_isolation on public.branch_service_areas for all
  using (app.is_platform_admin() or (organization_id = app.fn_active_organization() and app.has_membership()))
  with check (app.is_platform_admin() or (organization_id = app.fn_active_organization() and app.has_membership()));

-- same gate as `branches` itself: no module gate, 'branches.manage' to write
create policy branch_service_areas_write_ins on public.branch_service_areas as restrictive for insert
  with check (app.is_platform_admin() or app.has_permission('branches.manage'));
create policy branch_service_areas_write_upd on public.branch_service_areas as restrictive for update
  using (app.is_platform_admin() or app.has_permission('branches.manage'))
  with check (app.is_platform_admin() or app.has_permission('branches.manage'));
create policy branch_service_areas_write_del on public.branch_service_areas as restrictive for delete
  using (app.is_platform_admin() or app.has_permission('branches.manage'));

-- Coverage + fee lookup for one branch/zone pair.
-- Permissive-by-default: a branch with zero configured rows has not set up
-- service areas yet, so every zone is accepted with no travel fee. This
-- matches Deliverable D's "new tenant is usable, not broken" requirement —
-- an org that hasn't configured coverage yet must still be able to take
-- home bookings, not have every one silently rejected.
create or replace function app.fn_check_service_area(
  p_branch uuid, p_kecamatan text, p_kabupaten_kota text
)
returns table (allowed boolean, travel_fee numeric, estimated_travel_minutes integer, matched_zone text)
language plpgsql
stable
security definer
set search_path = app, public
as $$
declare
  v_org uuid := app.fn_active_organization();
  v_configured integer;
  v_match record;
begin
  if not app.has_membership() then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select count(*) into v_configured
  from public.branch_service_areas
  where organization_id = v_org and branch_id = p_branch and is_active and deleted_at is null;

  if v_configured = 0 then
    return query select true, 0::numeric, 0, null::text;
    return;
  end if;

  select sa.travel_fee, sa.estimated_travel_minutes, sa.kecamatan, sa.kabupaten_kota
    into v_match
  from public.branch_service_areas sa
  where sa.organization_id = v_org and sa.branch_id = p_branch and sa.is_active and sa.deleted_at is null
    and sa.kabupaten_kota = p_kabupaten_kota
    and (sa.kecamatan is null or sa.kecamatan = p_kecamatan)
  order by (sa.kecamatan is not null) desc -- prefer an exact kecamatan match over a kabupaten-wide row
  limit 1;

  if v_match is null then
    return query select false, null::numeric, null::integer, null::text;
  else
    return query select true, v_match.travel_fee, v_match.estimated_travel_minutes,
      coalesce(v_match.kecamatan, v_match.kabupaten_kota);
  end if;
end;
$$;
revoke all on function app.fn_check_service_area(uuid, text, text) from public;
grant execute on function app.fn_check_service_area(uuid, text, text) to authenticated;
