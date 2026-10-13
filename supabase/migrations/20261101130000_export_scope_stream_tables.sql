-- Stream 4 (support): the export scope learns the tables added by the 20261101 streams.
--
-- New tenant tables stay out of the organization export archive until a migration reviews them (20261031130000). This one reviews the
-- two money-and-history tables the new streams added and keeps the third out on purpose:
--   marketing_spend_entries   immutable manual spend ledger (no secrets; uuid id; organization_id)           -> archived
--   cash_account_mappings     immutable effective-dated mappings of payments/expenses/payroll to accounts   -> archived
--   whatsapp_provider_settings provider identifiers and a consent attestation                                -> NOT archived ('sensitive')
-- Both archived tables carry an append-only trigger whose name the restore-readiness probe recognises, so the guarded restore script
-- loads them INSERT-only and verifies the trigger is still enabled afterwards. app.org_export_scope() is re-created unchanged except
-- for the extra 'sensitive' name. Nothing here restores anything.
begin;

insert into app.organization_export_table_specs (table_name, sort_order, reason) values
  ('marketing_spend_entries', 284, 'manual marketing spend ledger (immutable)'),
  ('cash_account_mappings', 286, 'cash account mappings (immutable, effective-dated)')
on conflict (table_name) do nothing;

create or replace function app.org_export_scope() returns jsonb
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
        when r.t in ('organization_bank_accounts','notifications','customer_onboarding_submissions','customer_onboarding_settings','whatsapp_contact_preferences','whatsapp_provider_settings') then 'sensitive'
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

-- Kept in step with the newest migration file by apps/web/test/health-recovery.test.ts (it fails on drift).
create or replace function app.schema_version() returns text language sql immutable set search_path = '' as $$
  select '20261101130000'::text;
$$;

notify pgrst, 'reload schema';
commit;
