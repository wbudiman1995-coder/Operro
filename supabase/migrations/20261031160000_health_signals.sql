-- P8: reliability signals tied to owner actions (parity #44).
--
-- app.health_summary() gains only signals that are real, existing records of this organization:
--   exports.completed_archives     completed archives whose files still exist (not purged)
--   exports.newest_completed_at    when the newest of them finished
--   exports.unverified_completed   completed, not-purged archives never metadata-verified, or whose last verification failed
--   exports.last_verification_ok   outcome of the most recent recorded verification (null = never verified)
--   exports.purge_candidates       archives past the retention window (app.org_export_purge_candidates rule)
--   cleanup.schedule_consent       whether the owner recorded consent for unattended cleanup (consent only: no runner exists)
-- Nothing is probed or simulated, no provider API is called, no credential, provider log, raw error text or path is returned,
-- and the platform-only section is unchanged. The function remains owner-gated and counts/timestamps only.
begin;

create or replace function app.health_summary() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_org uuid := app.fn_active_organization();
  v_platform boolean := app.is_operro_owner();
  v_result jsonb;
begin
  if v_org is null or not app.has_membership() or not app.is_business_owner_member(v_org) then
    raise exception 'not_authorized' using errcode = '42501'; end if;
  v_result := jsonb_build_object(
    'schema_version', app.schema_version(),
    'generated_at', now(),
    'exports', (select jsonb_build_object(
        'failed_30d', count(*) filter (where status = 'failed' and created_at > now() - interval '30 days'),
        'stale_running', count(*) filter (where status = 'running' and created_at < now() - interval '2 hours'),
        'last_completed_at', max(completed_at) filter (where status = 'completed'),
        'last_failure_at', max(created_at) filter (where status = 'failed'),
        'completed_archives', count(*) filter (where status = 'completed' and purged_at is null),
        'newest_completed_at', max(completed_at) filter (where status = 'completed' and purged_at is null),
        'unverified_completed', count(*) filter (where status = 'completed' and purged_at is null and verified_ok is distinct from true),
        'last_verification_ok', (select e.verified_ok from public.organization_export_jobs e
                                  where e.organization_id = v_org and e.status = 'completed' and e.purged_at is null and e.verified_at is not null
                                  order by e.verified_at desc limit 1),
        'purge_candidates', (select jsonb_array_length(app.org_export_purge_candidates())))
      from public.organization_export_jobs where organization_id = v_org),
    'cleanup', (select jsonb_build_object(
        'problem_runs_30d', count(*) filter (where mode = 'apply' and status in ('failed','partial','abandoned') and started_at > now() - interval '30 days'),
        'stale_running', count(*) filter (where mode = 'apply' and status = 'running' and lease_expires_at < now()),
        'last_apply_status', (select r.status from public.storage_cleanup_runs r where r.organization_id = v_org and r.mode = 'apply' order by r.started_at desc limit 1),
        'last_apply_at', max(started_at) filter (where mode = 'apply'),
        'pending_objects', (select count(*) from public.storage_cleanup_items i where i.organization_id = v_org and i.state in ('marked','failed','abandoned')),
        'schedule_consent', coalesce((select s.enabled from public.storage_cleanup_schedules s where s.organization_id = v_org), false))
      from public.storage_cleanup_runs where organization_id = v_org),
    'capacity_requests', (select jsonb_build_object(
        'pending', count(*) filter (where status in ('requested','contacted')),
        'oldest_pending_at', min(created_at) filter (where status in ('requested','contacted')),
        'stale_pending', count(*) filter (where status in ('requested','contacted') and created_at < now() - interval '14 days'))
      from public.storage_upgrade_requests where organization_id = v_org));
  if v_platform then
    v_result := v_result || jsonb_build_object('platform', jsonb_build_object(
      'pending_capacity_requests', (select count(*) from public.storage_upgrade_requests where status in ('requested','contacted')),
      'oldest_pending_capacity_request_at', (select min(created_at) from public.storage_upgrade_requests where status in ('requested','contacted')),
      'failed_exports_30d', (select count(*) from public.organization_export_jobs where status = 'failed' and created_at > now() - interval '30 days'),
      'problem_cleanup_runs_30d', (select count(*) from public.storage_cleanup_runs where mode = 'apply' and status in ('failed','partial','abandoned') and started_at > now() - interval '30 days')));
  end if;
  return v_result;
end $$;

revoke all on function app.health_summary() from public, anon, authenticated;
grant execute on function app.health_summary() to authenticated;

-- Kept in step with the newest migration file by apps/web/test/health-recovery.test.ts (it fails on drift).
create or replace function app.schema_version() returns text language sql immutable set search_path = '' as $$
  select '20261031160000'::text;
$$;

notify pgrst, 'reload schema';
commit;
