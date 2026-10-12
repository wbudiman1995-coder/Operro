-- P4: organization export - transparent scope, retention and recorded verification (parity #38).
--
-- STILL AN EXPORT ARCHIVE, NOT A BACKUP: it holds reviewed tenant tables as JSONL plus workspace configuration plus Storage
-- object METADATA (never object bodies, Auth data, token hashes, provider credentials or signed URLs). There is no restore
-- code here and none is claimed; recovery is only ever proven by a recorded disposable-project drill (docs/runbooks).
--
-- 1. Allowlist extension. Each table below was reviewed against the live catalog (uuid `id` cursor, `organization_id`, no
--    column whose name looks like a credential, token or URL secret; the export SQL test re-checks this). They are tenant
--    configuration and records created by the 20261029-20261031 workstreams that the first allowlist predates. New tenant
--    tables stay OUT of the archive until a migration lists them here; app.org_export_scope() makes the gap visible.
-- 2. app.org_export_scope(): for the business owner - every allowlisted table with its live row count, and every other
--    tenant table with a reason it is not archived (secrets / access control / operator data / bookkeeping / sensitive /
--    configuration-only / no uuid cursor / not yet reviewed) and a capped count. A deterministic fingerprint of the table
--    NAMES lets a reader tell whether two archives were produced under the same scope.
-- 3. Retention: a failed or cancelled archive older than 7 days and a completed archive older than 90 days (never the newest
--    completed one) are purge candidates. The owner removes the files through Storage (new owner-only delete policy on the
--    archive prefix) and then records it with org_export_mark_purged; the job row and manifest stay as history, but a purged
--    archive can no longer be verified or downloaded.
-- 4. Verification result: org_export_record_verification stores when the application last ran the metadata verifier on a
--    completed archive and whether it passed (recorded by the application after it ran; not an independent attestation).
begin;

-- ---------------------------------------------------------------------------------------------------------------
-- 1. Allowlist extension.
-- ---------------------------------------------------------------------------------------------------------------
insert into app.organization_export_table_specs (table_name, sort_order, reason) values
  ('branch_service_areas', 12, 'branch service-area configuration'),
  ('branch_served_city_dates', 14, 'dated served-city planning'),
  ('branch_availability_blocks', 16, 'branch closure windows'),
  ('tax_rates', 62, 'tax configuration'),
  ('resource_availability', 72, 'resource weekly availability'),
  ('commission_rules', 246, 'commission rule configuration'),
  ('commission_entries', 247, 'commission entries'),
  ('customer_next_discounts', 248, 'complimentary next-visit discount rules'),
  ('financial_ledger', 252, 'append-only financial ledger'),
  ('custom_field_definitions', 262, 'owner-defined customer/pet fields'),
  ('custom_field_values', 264, 'values of owner-defined fields'),
  ('sop_templates', 266, 'SOP templates'),
  ('whatsapp_batches', 270, 'WhatsApp draft batches'),
  ('whatsapp_drafts', 272, 'WhatsApp draft messages (recipient numbers are customer data)'),
  ('whatsapp_draft_events', 274, 'WhatsApp manual delivery log'),
  ('cash_accounts', 280, 'cash-control register accounts'),
  ('cash_movements', 282, 'cash-control register movements (immutable)')
on conflict (table_name) do nothing;

-- ---------------------------------------------------------------------------------------------------------------
-- 3. Retention columns, owner-only delete on the archive prefix, candidates, purge record.
-- ---------------------------------------------------------------------------------------------------------------
alter table public.organization_export_jobs
  add column purged_at timestamptz,
  add column purged_files integer check (purged_files is null or purged_files >= 0),
  add column verified_at timestamptz,
  add column verified_ok boolean,
  add column verified_failures integer check (verified_failures is null or verified_failures >= 0),
  add constraint chk_export_jobs_verified check ((verified_at is null) = (verified_ok is null));

create policy organization_exports_delete on storage.objects for delete to authenticated
  using (bucket_id = 'organization-exports'
    and (storage.foldername(name))[1] = app.fn_active_organization()::text
    and (storage.foldername(name))[2] = 'exports'
    and app.is_business_owner_member(app.fn_active_organization()));

-- The retention rule in one place (days).
create function app.export_archive_purgeable(p_status text, p_created_at timestamptz, p_is_newest_completed boolean, p_purged_at timestamptz)
returns boolean language sql immutable set search_path = '' as $$
  select p_purged_at is null and case
    when p_status in ('failed','cancelled') then p_created_at < now() - interval '7 days'
    when p_status = 'completed' then p_created_at < now() - interval '90 days' and not p_is_newest_completed
    else false end;
$$;

create function app.org_export_purge_candidates() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid := app.fn_active_organization();
begin
  if not app.org_export_authorized() then raise exception 'not_authorized' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', j.id, 'status', j.status, 'created_at', j.created_at, 'storage_prefix', j.storage_prefix) order by j.created_at)
    from (select e.*, (e.status = 'completed' and e.id = (select c.id from public.organization_export_jobs c
                         where c.organization_id = v_org and c.status = 'completed' and c.purged_at is null order by c.created_at desc, c.id desc limit 1)) as newest_completed
            from public.organization_export_jobs e where e.organization_id = v_org) j
    where app.export_archive_purgeable(j.status, j.created_at, j.newest_completed, j.purged_at)), '[]'::jsonb);
end $$;

create function app.org_export_mark_purged(p_job uuid, p_files integer) returns void
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := app.fn_active_organization(); v_job public.organization_export_jobs; v_newest uuid;
begin
  if not app.org_export_authorized() then raise exception 'not_authorized' using errcode = '42501'; end if;
  if p_job is null or p_files is null or p_files < 0 then raise exception 'invalid_purge' using errcode = '22023'; end if;
  perform 1 from public.organizations where id = v_org for update;
  select * into v_job from public.organization_export_jobs where id = p_job and organization_id = v_org for update;
  if not found then raise exception 'job_not_found' using errcode = 'P0002'; end if;
  if v_job.purged_at is not null then return; end if;
  select c.id into v_newest from public.organization_export_jobs c
   where c.organization_id = v_org and c.status = 'completed' and c.purged_at is null order by c.created_at desc, c.id desc limit 1;
  if not app.export_archive_purgeable(v_job.status, v_job.created_at, v_job.id = v_newest, null) then
    raise exception 'not_purgeable' using errcode = '22023'; end if;
  update public.organization_export_jobs set purged_at = now(), purged_files = p_files where id = p_job;
end $$;

-- A purged archive cannot be verified or downloaded any more.
create or replace function app.org_export_manifest(p_job uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid := app.fn_active_organization(); v_manifest jsonb; v_status text; v_purged timestamptz;
begin
  if not app.org_export_authorized() then raise exception 'not_authorized' using errcode = '42501'; end if;
  select manifest, status, purged_at into v_manifest, v_status, v_purged from public.organization_export_jobs where id = p_job and organization_id = v_org;
  if not found then raise exception 'job_not_found' using errcode = 'P0002'; end if;
  if v_purged is not null then raise exception 'job_purged' using errcode = '22023'; end if;
  if v_status <> 'completed' or v_manifest is null then raise exception 'job_not_completed' using errcode = '22023'; end if;
  return v_manifest;
end $$;

create or replace function app.org_export_list() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid := app.fn_active_organization();
begin
  if not app.org_export_authorized() then raise exception 'not_authorized' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(row_to_json(j)::jsonb order by j.created_at desc) from (
    select e.id, e.status, e.include_storage, e.created_at, e.completed_at, e.failed_reason,
           e.manifest ->> 'manifestSha256' as manifest_sha256,
           e.purged_at, e.purged_files, e.verified_at, e.verified_ok, e.verified_failures,
           (select count(*) from public.organization_export_table_state s where s.job_id = e.id and s.completed) as tables_done,
           (select count(*) from public.organization_export_table_state s where s.job_id = e.id) as tables_total
    from public.organization_export_jobs e where e.organization_id = v_org order by e.created_at desc limit 20) j), '[]'::jsonb);
end $$;

-- 4. Recorded verification of a completed, not purged archive.
create function app.org_export_record_verification(p_job uuid, p_ok boolean, p_failure_count integer) returns void
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := app.fn_active_organization();
begin
  if not app.org_export_authorized() then raise exception 'not_authorized' using errcode = '42501'; end if;
  if p_job is null or p_ok is null or p_failure_count is null or p_failure_count < 0 or (p_ok and p_failure_count <> 0) then
    raise exception 'invalid_verification' using errcode = '22023'; end if;
  update public.organization_export_jobs
     set verified_at = now(), verified_ok = p_ok, verified_failures = p_failure_count
   where id = p_job and organization_id = v_org and status = 'completed' and purged_at is null;
  if not found then raise exception 'job_not_completed' using errcode = '22023'; end if;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- 2. Scope report.
-- ---------------------------------------------------------------------------------------------------------------
create function app.org_export_scope() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_org uuid := app.fn_active_organization();
  v_included jsonb := '[]'::jsonb;
  v_uncovered jsonb := '[]'::jsonb;
  r record;
  v_n bigint;
  v_names text;
begin
  if not app.org_export_authorized() then raise exception 'not_authorized' using errcode = '42501'; end if;
  for r in select s.table_name, s.sort_order, s.reason from app.organization_export_table_specs s order by s.sort_order loop
    execute format('select count(*) from public.%I where organization_id = $1', r.table_name) into v_n using v_org;
    v_included := v_included || jsonb_build_array(jsonb_build_object('table', r.table_name, 'sort_order', r.sort_order, 'reason', r.reason, 'row_count', v_n));
  end loop;
  for r in
    select c.relname::text as t,
           exists (select 1 from pg_catalog.pg_attribute a where a.attrelid = c.oid and a.attname = 'id' and a.atttypid = 'uuid'::regtype and not a.attisdropped) as has_uuid_id
      from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r'
       and exists (select 1 from pg_catalog.pg_attribute a where a.attrelid = c.oid and a.attname = 'organization_id' and not a.attisdropped)
       and c.relname not in (select table_name from app.organization_export_table_specs)
     order by c.relname
  loop
    execute format('select count(*) from (select 1 from public.%I where organization_id = $1 limit 10001) s', r.t) into v_n using v_org;
    v_uncovered := v_uncovered || jsonb_build_array(jsonb_build_object(
      'table', r.t, 'row_count', least(v_n, 10000), 'capped', v_n > 10000,
      'class', case
        when r.t in ('customer_onboarding_links','platform_access_invitations') then 'secret'
        when r.t in ('memberships','membership_branch_access','roles','role_permissions') then 'access'
        when r.t in ('subscriptions','organization_modules','organization_features') or r.t like 'platform\_%' escape '\' then 'operator'
        when r.t in ('organization_export_jobs','storage_cleanup_runs','storage_cleanup_items','storage_cleanup_schedules','storage_upgrade_requests') then 'bookkeeping'
        when r.t in ('organization_bank_accounts','notifications','customer_onboarding_submissions','customer_onboarding_settings','whatsapp_contact_preferences') then 'sensitive'
        when r.t in ('organization_size_band_settings','organization_dog_size_boundaries','organization_pet_types','service_band_prices') then 'configuration'
        when not r.has_uuid_id then 'no_uuid_cursor'
        else 'not_reviewed' end));
  end loop;
  select string_agg(x, ',' order by x) into v_names from (
    select 'in:' || table_name as x from app.organization_export_table_specs
    union all select 'out:' || (u ->> 'table') from jsonb_array_elements(v_uncovered) u) names;
  return jsonb_build_object(
    'generated_at', now(),
    'included', v_included,
    'uncovered', v_uncovered,
    'fingerprint', encode(extensions.digest(convert_to(coalesce(v_names, ''), 'UTF8'), 'sha256'), 'hex'),
    'retention', jsonb_build_object('failed_or_cancelled_days', 7, 'completed_days', 90, 'keeps_newest_completed', true));
end $$;

revoke all on function app.export_archive_purgeable(text, timestamptz, boolean, timestamptz), app.org_export_purge_candidates(),
  app.org_export_mark_purged(uuid, integer), app.org_export_record_verification(uuid, boolean, integer), app.org_export_scope(),
  app.org_export_manifest(uuid), app.org_export_list() from public, anon, authenticated;
grant execute on function app.org_export_purge_candidates(), app.org_export_mark_purged(uuid, integer),
  app.org_export_record_verification(uuid, boolean, integer), app.org_export_scope(),
  app.org_export_manifest(uuid), app.org_export_list() to authenticated;

-- Kept in step with the newest migration file by apps/web/test/health-recovery.test.ts (it fails on drift).
create or replace function app.schema_version() returns text language sql immutable set search_path = '' as $$
  select '20261031130000'::text;
$$;

notify pgrst, 'reload schema';
commit;
