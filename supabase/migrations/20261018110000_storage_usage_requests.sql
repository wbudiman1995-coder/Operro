-- Storage visibility is tenant-scoped. Project-wide metrics are only returned
-- to a platform admin; tenant owners must not infer other tenants' usage.
create table public.storage_upgrade_requests (
  id uuid primary key default app.fn_uuid_v7(),
  organization_id uuid not null references public.organizations(id),
  requested_gb integer not null check (requested_gb in (1, 5, 10, 25, 50, 100)),
  note text check (length(note) <= 1000),
  status text not null default 'requested' check (status in ('requested', 'contacted', 'fulfilled', 'declined')),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  reviewed_by uuid references auth.users(id),
  reviewed_at timestamptz,
  constraint uq_storage_upgrade_request_org_id unique (organization_id, id)
);
create index idx_storage_upgrade_requests_queue on public.storage_upgrade_requests(status, created_at desc);
create unique index uq_storage_upgrade_requests_one_open on public.storage_upgrade_requests(organization_id)
  where status in ('requested', 'contacted');
create trigger trg_storage_upgrade_requests_updated before update on public.storage_upgrade_requests
  for each row execute function app.tg_set_updated_at();
alter table public.storage_upgrade_requests enable row level security;
grant select, insert, update on public.storage_upgrade_requests to authenticated;
create policy storage_upgrade_requests_read on public.storage_upgrade_requests for select to authenticated
  using (app.is_platform_admin() or (organization_id = app.fn_active_organization() and app.has_permission('settings.manage')));
create policy storage_upgrade_requests_insert on public.storage_upgrade_requests for insert to authenticated
  with check (organization_id = app.fn_active_organization() and app.has_permission('settings.manage')
    and created_by = auth.uid() and status = 'requested' and reviewed_by is null and reviewed_at is null);
create policy storage_upgrade_requests_admin_update on public.storage_upgrade_requests for update to authenticated
  using (app.is_platform_admin()) with check (app.is_platform_admin());

create or replace function app.storage_usage_snapshot()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_org uuid := app.fn_active_organization();
  v_is_admin boolean := app.is_platform_admin();
  v_org_bytes bigint := 0;
  v_org_files bigint := 0;
  v_project_files bigint := 0;
  v_project_bytes bigint := 0;
  v_database_bytes bigint := 0;
begin
  if v_org is null or not (v_is_admin or app.has_permission('settings.manage')) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select coalesce(sum(case when (o.metadata->>'size') ~ '^\d+$' then (o.metadata->>'size')::bigint else 0 end),0), count(*)
    into v_org_bytes, v_org_files
  from storage.objects o where o.name like v_org::text || '/%';
  if v_is_admin then
    select coalesce(sum(case when (o.metadata->>'size') ~ '^\d+$' then (o.metadata->>'size')::bigint else 0 end),0), count(*)
      into v_project_bytes, v_project_files from storage.objects o;
    select pg_catalog.pg_database_size(pg_catalog.current_database()) into v_database_bytes;
  end if;
  return jsonb_build_object('organization_id',v_org,'organization_file_bytes',v_org_bytes,
    'organization_file_count',v_org_files,'is_platform_admin',v_is_admin,
    'project_file_bytes',case when v_is_admin then v_project_bytes else null end,
    'project_file_count',case when v_is_admin then v_project_files else null end,
    'project_database_bytes',case when v_is_admin then v_database_bytes else null end,
    'measured_at',now());
end $$;
revoke all on function app.storage_usage_snapshot() from public;
grant execute on function app.storage_usage_snapshot() to authenticated;
