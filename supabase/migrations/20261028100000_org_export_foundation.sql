-- E3.1: owner-authorized organization export. This creates an export archive,
-- not a backup: restoring into another project is deliberately out of scope and
-- no disaster-recovery claim is made until a disposable-project restore drill exists.
--
-- Shape: a job is started by the business owner, the web server then pulls bounded
-- pages (<= 200 rows) of an explicit allowlist of tenant tables through these
-- definer RPCs, uploads each page as a JSONL chunk under
-- organization-exports/<org>/exports/<job>/..., and records the chunk (row count,
-- SHA-256, first/last id, deterministic path) here. A manifest finalizes the job.
-- Nothing in this migration copies Auth data, token hashes, provider credentials,
-- signed URLs or Storage object bodies.
begin;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('organization-exports', 'organization-exports', false, 52428800,
  array['application/json','application/x-ndjson'])
on conflict (id) do update set public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Only the active organization's own business owner may touch its archive prefix.
create policy organization_exports_read on storage.objects for select to authenticated
  using (bucket_id = 'organization-exports'
    and (storage.foldername(name))[1] = app.fn_active_organization()::text
    and (storage.foldername(name))[2] = 'exports'
    and app.is_business_owner_member(app.fn_active_organization()));
create policy organization_exports_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'organization-exports'
    and (storage.foldername(name))[1] = app.fn_active_organization()::text
    and (storage.foldername(name))[2] = 'exports'
    and app.is_business_owner_member(app.fn_active_organization()));
create policy organization_exports_update on storage.objects for update to authenticated
  using (bucket_id = 'organization-exports'
    and (storage.foldername(name))[1] = app.fn_active_organization()::text
    and (storage.foldername(name))[2] = 'exports'
    and app.is_business_owner_member(app.fn_active_organization()))
  with check (bucket_id = 'organization-exports'
    and (storage.foldername(name))[1] = app.fn_active_organization()::text
    and (storage.foldername(name))[2] = 'exports'
    and app.is_business_owner_member(app.fn_active_organization()));

create table public.organization_export_jobs (
  id uuid primary key default app.fn_uuid_v7(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  status text not null default 'running' check (status in ('running','completed','failed','cancelled')),
  include_storage boolean not null default true,
  archive_bucket text not null default 'organization-exports' check (archive_bucket = 'organization-exports'),
  storage_prefix text not null,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  failed_reason text,
  manifest jsonb
);
create index organization_export_jobs_org_created_idx on public.organization_export_jobs (organization_id, created_at desc);
-- An interrupted run is resumed, never duplicated: at most one running job per organization.
create unique index organization_export_jobs_one_running_idx on public.organization_export_jobs (organization_id) where status = 'running';
alter table public.organization_export_jobs enable row level security;
revoke all on public.organization_export_jobs from public, anon, authenticated;

-- This is intentionally an allowlist. New tenant tables are excluded until a
-- migration explicitly reviews both their contents and their cursor semantics.
-- Every listed table has a uuid `id` cursor, an `organization_id`, and no credential,
-- token-hash or provider-secret column (reviewed against the column list on 2026-10-09).
create table app.organization_export_table_specs (
  table_name text primary key,
  cursor_column text not null default 'id' check (cursor_column = 'id'),
  sort_order integer not null unique,
  reason text not null
);
alter table app.organization_export_table_specs enable row level security;
revoke all on app.organization_export_table_specs from public, anon, authenticated;
insert into app.organization_export_table_specs (table_name, sort_order, reason) values
  ('branches', 10, 'workspace branch configuration'),
  ('organization_size_bands', 20, 'workspace size-band configuration'),
  ('customers', 30, 'customer records'),
  ('customer_addresses', 40, 'customer address records'),
  ('pets', 50, 'pet records'),
  ('service_catalog', 60, 'service configuration'),
  ('resources', 70, 'resource records'),
  ('bookings', 80, 'booking records'),
  ('booking_recurrence', 85, 'recurring booking series'),
  ('grooming_job_pets', 90, 'grooming job pet records'),
  ('grooming_job_pet_services', 100, 'grooming service lines'),
  ('packages', 110, 'package configuration'),
  ('customer_packages', 120, 'customer package records'),
  ('customer_package_ledger', 130, 'package ledger'),
  ('package_reservations', 140, 'package reservations'),
  ('membership_plans', 142, 'membership plan configuration'),
  ('customer_memberships', 145, 'customer membership records'),
  ('orders', 150, 'order records'),
  ('order_items', 155, 'order line snapshots'),
  ('invoices', 160, 'invoice records'),
  ('invoice_lines', 165, 'invoice line snapshots'),
  ('payments', 168, 'payment records; proof is an attachment reference, not the file'),
  ('refunds', 169, 'refund records'),
  ('attachments', 170, 'attachment metadata only; object bodies are not exported'),
  ('attachment_links', 180, 'attachment links'),
  ('timeline_events', 190, 'timeline events'),
  ('complaints', 200, 'complaint records'),
  ('manual_visits', 210, 'manual visit records'),
  ('visit_manual_billing', 220, 'manual visit billing records'),
  ('expenses', 230, 'expense records'),
  ('tasks', 235, 'task records'),
  ('attendance_records', 237, 'attendance records'),
  ('payroll_cycle_settings', 238, 'payroll configuration'),
  ('staff_payroll_settings', 239, 'per-staff payroll configuration'),
  ('payroll_runs', 240, 'payroll run records'),
  ('payroll_items', 241, 'payroll item records (frozen breakdowns)'),
  ('payroll_custom_rows', 242, 'payroll custom rows'),
  ('payroll_item_overrides', 243, 'payroll component overrides'),
  ('payroll_publications', 244, 'payroll publication state'),
  ('payroll_retention_events', 245, 'payroll retention ledger'),
  ('staff_compensation', 250, 'staff compensation records'),
  ('notification_templates', 260, 'message template configuration');

create table public.organization_export_table_state (
  job_id uuid not null references public.organization_export_jobs(id) on delete cascade,
  table_name text not null references app.organization_export_table_specs(table_name),
  last_id uuid,
  next_chunk_index integer not null default 0 check (next_chunk_index >= 0),
  completed boolean not null default false,
  primary key (job_id, table_name)
);
alter table public.organization_export_table_state enable row level security;
revoke all on public.organization_export_table_state from public, anon, authenticated;

create table public.organization_export_chunks (
  job_id uuid not null references public.organization_export_jobs(id) on delete cascade,
  table_name text not null references app.organization_export_table_specs(table_name),
  chunk_index integer not null check (chunk_index >= 0),
  row_count integer not null check (row_count > 0 and row_count <= 200),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  first_id uuid not null,
  last_id uuid not null,
  storage_path text not null,
  created_at timestamptz not null default now(),
  primary key (job_id, table_name, chunk_index)
);
alter table public.organization_export_chunks enable row level security;
revoke all on public.organization_export_chunks from public, anon, authenticated;

-- Internal gate: the active organization's own business owner (the Operro platform
-- owner is excluded by is_business_owner_member). Not granted to any client role.
create function app.org_export_authorized() returns boolean
language sql stable security definer set search_path = '' as $$
  select app.fn_active_organization() is not null
     and app.is_business_owner_member(app.fn_active_organization());
$$;

-- Start a job, or resume the running one (interrupted-run behavior).
create function app.org_export_start(p_include_storage boolean default true) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := app.fn_active_organization(); v_job uuid; v_prefix text; v_running public.organization_export_jobs;
begin
  if not app.org_export_authorized() then raise exception 'not_authorized' using errcode = '42501'; end if;
  perform 1 from public.organizations where id = v_org for update;
  select * into v_running from public.organization_export_jobs where organization_id = v_org and status = 'running';
  if found then
    return jsonb_build_object('job_id', v_running.id, 'resumed', true, 'archive_bucket', v_running.archive_bucket, 'storage_prefix', v_running.storage_prefix);
  end if;
  v_job := app.fn_uuid_v7();
  v_prefix := v_org::text || '/exports/' || v_job::text;
  insert into public.organization_export_jobs(id, organization_id, include_storage, storage_prefix, created_by)
  values (v_job, v_org, coalesce(p_include_storage, true), v_prefix, auth.uid());
  insert into public.organization_export_table_state(job_id, table_name)
  select v_job, table_name from app.organization_export_table_specs order by sort_order;
  return jsonb_build_object('job_id', v_job, 'resumed', false, 'archive_bucket', 'organization-exports', 'storage_prefix', v_prefix);
end $$;

create function app.org_export_list() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid := app.fn_active_organization();
begin
  if not app.org_export_authorized() then raise exception 'not_authorized' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(row_to_json(j)::jsonb order by j.created_at desc) from (
    select e.id, e.status, e.include_storage, e.created_at, e.completed_at, e.failed_reason,
           e.manifest ->> 'manifestSha256' as manifest_sha256,
           (select count(*) from public.organization_export_table_state s where s.job_id = e.id and s.completed) as tables_done,
           (select count(*) from public.organization_export_table_state s where s.job_id = e.id) as tables_total
    from public.organization_export_jobs e where e.organization_id = v_org order by e.created_at desc limit 20) j), '[]'::jsonb);
end $$;

create function app.org_export_manifest(p_job uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid := app.fn_active_organization(); v_manifest jsonb; v_status text;
begin
  if not app.org_export_authorized() then raise exception 'not_authorized' using errcode = '42501'; end if;
  select manifest, status into v_manifest, v_status from public.organization_export_jobs where id = p_job and organization_id = v_org;
  if not found then raise exception 'job_not_found' using errcode = 'P0002'; end if;
  if v_status <> 'completed' or v_manifest is null then raise exception 'job_not_completed' using errcode = '22023'; end if;
  return v_manifest;
end $$;

create function app.org_export_cancel(p_job uuid, p_reason text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := app.fn_active_organization();
begin
  if not app.org_export_authorized() then raise exception 'not_authorized' using errcode = '42501'; end if;
  update public.organization_export_jobs
     set status = 'cancelled', completed_at = now(), failed_reason = left(coalesce(nullif(trim(p_reason), ''), 'cancelled_by_owner'), 200)
   where id = p_job and organization_id = v_org and status = 'running';
  if not found then raise exception 'job_not_running' using errcode = '22023'; end if;
end $$;

create function app.org_export_next_work(p_job uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := app.fn_active_organization(); v_state record; v_job public.organization_export_jobs;
begin
  if not app.org_export_authorized() then raise exception 'not_authorized' using errcode = '42501'; end if;
  select * into v_job from public.organization_export_jobs where id=p_job and organization_id=v_org;
  if not found or v_job.status <> 'running' then raise exception 'job_not_running' using errcode='22023'; end if;
  select s.table_name, s.last_id, s.next_chunk_index into v_state
  from public.organization_export_table_state s join app.organization_export_table_specs t on t.table_name=s.table_name
  where s.job_id=p_job and not s.completed order by t.sort_order limit 1;
  if not found then return jsonb_build_object('done', true, 'archive_bucket', v_job.archive_bucket, 'storage_prefix', v_job.storage_prefix, 'include_storage', v_job.include_storage); end if;
  return jsonb_build_object('done', false, 'table_name', v_state.table_name, 'after_id', v_state.last_id,
    'chunk_index', v_state.next_chunk_index, 'archive_bucket', v_job.archive_bucket, 'storage_prefix', v_job.storage_prefix, 'include_storage', v_job.include_storage);
end $$;

-- One bounded page of one allowlisted table. The table name can only be one that this
-- job's state rows (copied from the allowlist) name, and the cursor must equal the
-- recorded one, so a client cannot skip ahead or page an arbitrary relation.
create function app.org_export_table_page(p_job uuid, p_table text, p_after_id uuid, p_limit integer default 200) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := app.fn_active_organization(); v_rows jsonb; v_state public.organization_export_table_state;
begin
  if not app.org_export_authorized() then raise exception 'not_authorized' using errcode='42501'; end if;
  if p_limit is null or p_limit < 1 or p_limit > 200 then raise exception 'invalid_limit' using errcode='22023'; end if;
  select s.* into v_state from public.organization_export_table_state s
    join public.organization_export_jobs j on j.id = s.job_id
   where s.job_id = p_job and s.table_name = p_table and not s.completed
     and j.organization_id = v_org and j.status = 'running';
  if not found or v_state.last_id is distinct from p_after_id then raise exception 'invalid_export_work' using errcode='22023'; end if;
  execute format('select coalesce(jsonb_agg(to_jsonb(export_row) order by export_row.id), ''[]''::jsonb) from (select * from public.%I where organization_id=$1 and ($2 is null or id > $2) order by id limit $3) export_row', p_table)
    into v_rows using v_org, p_after_id, p_limit;
  return v_rows;
end $$;

create function app.org_export_record_chunk(p_job uuid, p_table text, p_index integer, p_row_count integer,
  p_sha256 text, p_first_id uuid, p_last_id uuid, p_storage_path text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := app.fn_active_organization(); v_state public.organization_export_table_state; v_prefix text; v_expected text;
begin
  if not app.org_export_authorized() then raise exception 'not_authorized' using errcode='42501'; end if;
  select s.* into v_state from public.organization_export_table_state s join public.organization_export_jobs j on j.id=s.job_id
    where s.job_id=p_job and s.table_name=p_table and j.organization_id=v_org and j.status='running' for update of s;
  if not found or v_state.completed then raise exception 'invalid_export_work' using errcode='22023'; end if;
  if p_index is null or p_row_count is null or p_row_count < 1 or p_row_count > 200 or p_sha256 is null or p_sha256 !~ '^[0-9a-f]{64}$'
    or p_first_id is null or p_last_id is null or p_last_id < p_first_id then raise exception 'invalid_chunk' using errcode='22023'; end if;
  if p_index < v_state.next_chunk_index then
    -- idempotent replay of an already recorded chunk; any difference is a conflict
    if exists (select 1 from public.organization_export_chunks where job_id=p_job and table_name=p_table and chunk_index=p_index
      and row_count=p_row_count and sha256=p_sha256 and first_id=p_first_id and last_id=p_last_id and storage_path=p_storage_path) then return; end if;
    raise exception 'chunk_conflict' using errcode='22023';
  end if;
  if p_index <> v_state.next_chunk_index then raise exception 'invalid_chunk_index' using errcode='22023'; end if;
  if v_state.last_id is not null and p_first_id <= v_state.last_id then raise exception 'invalid_chunk' using errcode='22023'; end if;
  select storage_prefix into v_prefix from public.organization_export_jobs where id=p_job;
  v_expected := v_prefix || '/tables/' || p_table || '/chunk-' || lpad(p_index::text, 5, '0') || '.jsonl';
  if p_storage_path is distinct from v_expected then raise exception 'invalid_storage_path' using errcode='22023'; end if;
  insert into public.organization_export_chunks(job_id,table_name,chunk_index,row_count,sha256,first_id,last_id,storage_path)
    values(p_job,p_table,p_index,p_row_count,p_sha256,p_first_id,p_last_id,p_storage_path);
  update public.organization_export_table_state set last_id=p_last_id, next_chunk_index=next_chunk_index+1 where job_id=p_job and table_name=p_table;
end $$;

create function app.org_export_finish_table(p_job uuid, p_table text, p_after_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := app.fn_active_organization();
begin
  if not app.org_export_authorized() then raise exception 'not_authorized' using errcode='42501'; end if;
  update public.organization_export_table_state s set completed=true
  from public.organization_export_jobs j
  where s.job_id=p_job and s.table_name=p_table and s.last_id is not distinct from p_after_id
    and not s.completed and j.id=s.job_id and j.organization_id=v_org and j.status='running';
  if not found then raise exception 'invalid_export_work' using errcode='22023'; end if;
end $$;

-- Workspace configuration. Explicit columns and an explicit settings-key allowlist, so a
-- column or settings key added later (or the platform-only platform_billing block) is
-- never exported until reviewed here.
create function app.org_export_configuration() returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid := app.fn_active_organization(); v_row public.organizations;
begin
  if not app.org_export_authorized() then raise exception 'not_authorized' using errcode='42501'; end if;
  select * into v_row from public.organizations where id=v_org;
  if not found then raise exception 'not_authorized' using errcode='42501'; end if;
  return jsonb_build_object(
    'id', v_row.id, 'name', v_row.name, 'slug', v_row.slug, 'status', v_row.status, 'vertical', v_row.vertical,
    'created_at', v_row.created_at, 'updated_at', v_row.updated_at,
    'settings', coalesce((select jsonb_object_agg(k.key, k.value)
        from jsonb_each(case when jsonb_typeof(v_row.settings) = 'object' then v_row.settings else '{}'::jsonb end) k
       where k.key in ('documents','followup_retention','dashboard','currency','evidence_retention_days')), '{}'::jsonb),
    'size_band_settings', (select to_jsonb(s) from public.organization_size_band_settings s where s.organization_id = v_org),
    'dog_size_boundaries', (select to_jsonb(s) from public.organization_dog_size_boundaries s where s.organization_id = v_org),
    'pet_types', coalesce((select jsonb_agg(to_jsonb(t) order by t.key) from public.organization_pet_types t where t.organization_id = v_org), '[]'::jsonb),
    'service_band_prices', coalesce((select jsonb_agg(to_jsonb(p) order by p.service_id, p.pricing_key) from public.service_band_prices p where p.organization_id = v_org), '[]'::jsonb));
end $$;

-- Storage METADATA only (bucket, name, size, mime type, updated_at). No object body, no URL.
-- Capped so one response stays bounded; the cap is reported, never hidden.
create function app.org_export_storage_listing(p_job uuid) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid := app.fn_active_organization(); v_include boolean; v_objects jsonb; v_count integer; v_cap constant integer := 20000;
begin
  if not app.org_export_authorized() then raise exception 'not_authorized' using errcode='42501'; end if;
  select include_storage into v_include from public.organization_export_jobs where id=p_job and organization_id=v_org;
  if not found then raise exception 'job_not_found' using errcode='P0002'; end if;
  if not v_include then return jsonb_build_object('included', false, 'truncated', false, 'objects', '[]'::jsonb); end if;
  select coalesce(jsonb_agg(jsonb_build_object('bucket',o.bucket_id,'name',o.name,'size',case when (o.metadata->>'size') ~ '^[0-9]{1,15}$' then (o.metadata->>'size')::bigint else null end,'mimetype',o.metadata->>'mimetype','updated_at',o.updated_at) order by o.bucket_id,o.name),'[]'::jsonb), count(*)
  into v_objects, v_count
  from (select * from storage.objects where bucket_id in ('attachments','styling-references','onboarding-styling') and name like v_org::text || '/%'
        order by bucket_id, name limit v_cap + 1) o;
  if v_count > v_cap then v_objects := v_objects - v_cap; end if;
  return jsonb_build_object('included', true, 'truncated', v_count > v_cap, 'objects', v_objects);
end $$;

create function app.org_export_chunks(p_job uuid) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid := app.fn_active_organization();
begin
  if not app.org_export_authorized() then raise exception 'not_authorized' using errcode='42501'; end if;
  if not exists(select 1 from public.organization_export_jobs where id=p_job and organization_id=v_org) then raise exception 'job_not_found' using errcode='P0002'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('table_name',table_name,'chunk_index',chunk_index,'row_count',row_count,'sha256',sha256,'first_id',first_id,'last_id',last_id,'path',storage_path) order by table_name,chunk_index) from public.organization_export_chunks where job_id=p_job),'[]'::jsonb);
end $$;

create function app.org_export_tables(p_job uuid) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid := app.fn_active_organization();
begin
  if not app.org_export_authorized() then raise exception 'not_authorized' using errcode='42501'; end if;
  if not exists(select 1 from public.organization_export_jobs where id=p_job and organization_id=v_org) then raise exception 'job_not_found' using errcode='P0002'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('table_name',s.table_name,'sort_order',t.sort_order) order by t.sort_order)
    from public.organization_export_table_state s join app.organization_export_table_specs t on t.table_name=s.table_name where s.job_id=p_job),'[]'::jsonb);
end $$;

-- Finalize. The manifest must name this organization and agree, table by table, with the
-- chunk rows this job recorded; the web server has already re-read every uploaded file and
-- verified its hash before calling this.
create function app.org_export_complete(p_job uuid, p_manifest jsonb) returns void language plpgsql security definer set search_path = '' as $$
declare v_org uuid := app.fn_active_organization();
begin
  if not app.org_export_authorized() then raise exception 'not_authorized' using errcode='42501'; end if;
  if p_manifest is null or jsonb_typeof(p_manifest) <> 'object'
     or p_manifest ->> 'format' is distinct from 'operro-organization-export'
     or p_manifest ->> 'version' is distinct from '1'
     or p_manifest #>> '{organization,id}' is distinct from v_org::text
     or jsonb_typeof(p_manifest -> 'tables') is distinct from 'array'
     or exists(select 1 from public.organization_export_table_state where job_id=p_job and not completed) then
    raise exception 'invalid_manifest' using errcode='22023';
  end if;
  if jsonb_array_length(p_manifest -> 'tables') <> (select count(*) from public.organization_export_table_state where job_id=p_job)
     or exists (
       select 1 from public.organization_export_table_state s
       left join (select t ->> 'name' as name, case when jsonb_typeof(t -> 'rowCount') = 'number' then (t ->> 'rowCount')::bigint end as row_count
                    from jsonb_array_elements(p_manifest -> 'tables') t) m on m.name = s.table_name
       where s.job_id = p_job
         and m.row_count is distinct from (select coalesce(sum(c.row_count), 0) from public.organization_export_chunks c where c.job_id = p_job and c.table_name = s.table_name)) then
    raise exception 'invalid_manifest' using errcode='22023';
  end if;
  update public.organization_export_jobs set status='completed', completed_at=now(), manifest=p_manifest where id=p_job and organization_id=v_org and status='running';
  if not found then raise exception 'job_not_running' using errcode='22023'; end if;
end $$;

revoke all on function app.org_export_authorized(),
  app.org_export_start(boolean), app.org_export_list(), app.org_export_manifest(uuid), app.org_export_cancel(uuid,text),
  app.org_export_next_work(uuid), app.org_export_table_page(uuid,text,uuid,integer),
  app.org_export_record_chunk(uuid,text,integer,integer,text,uuid,uuid,text), app.org_export_finish_table(uuid,text,uuid),
  app.org_export_configuration(), app.org_export_storage_listing(uuid), app.org_export_chunks(uuid), app.org_export_tables(uuid),
  app.org_export_complete(uuid,jsonb) from public, anon, authenticated;
grant execute on function app.org_export_start(boolean), app.org_export_list(), app.org_export_manifest(uuid), app.org_export_cancel(uuid,text),
  app.org_export_next_work(uuid), app.org_export_table_page(uuid,text,uuid,integer),
  app.org_export_record_chunk(uuid,text,integer,integer,text,uuid,uuid,text), app.org_export_finish_table(uuid,text,uuid),
  app.org_export_configuration(), app.org_export_storage_listing(uuid), app.org_export_chunks(uuid), app.org_export_tables(uuid),
  app.org_export_complete(uuid,jsonb) to authenticated;
notify pgrst, 'reload schema';
commit;
