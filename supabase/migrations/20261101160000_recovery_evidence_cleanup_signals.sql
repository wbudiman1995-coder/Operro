-- Streams 7 and 8: verifiable restore-drill evidence and record-backed cleanup signals (parity #43, #44).
--
-- STREAM 8, drill evidence. A recovery drill is a human-attested fact: only a person can say a restore was done. This adds what the
-- database CAN check, so the record is verifiable where it is verifiable and honest where it is not:
--   * drill_kind            provider_backup | export_archive_dry_run | guarded_archive_restore | other
--   * archive_manifest_sha256, restore_report_sha256   the hashes printed by apps/web/scripts/restore-org-export.ts and the verifier
--   * evidence_matches_export   set BY THE DATABASE to true only when a completed organization export on this platform has exactly that
--                           manifest hash. It proves the archive existed, not that a restore happened.
-- Rules enforced here: archive-based drills (they exercise no provider backup, Storage, Auth or secrets) can never be recorded as
-- 'passed' (only a provider-backup drill can); an archive drill must carry the manifest hash (and a guarded restore also the report
-- hash); a provider-backup drill carries neither; hashes are 64 lower-case hex characters. The platform owner records drills as before,
-- the table stays append-only, and no credential-like text is accepted. app.recovery_status() reports how many drills carry matching
-- evidence and, to the platform owner, the kind and hashes of the latest drill. Nothing reads Supabase backup or point-in-time status
-- and no drill is ever marked passed automatically.
--
-- STREAM 7, cleanup signals. No unattended runner exists and none is added (docs/runbooks/UNATTENDED_CLEANUP.md specifies the model).
-- The owner-facing operator path gets record-backed signals instead: when a cleanup last completed, when a preview last ran, and how many
-- candidates the latest preview found that no later apply run has acted on. health_summary() is re-created with those three fields.
begin;

alter table public.recovery_drills
  add column drill_kind text check (drill_kind in ('provider_backup','export_archive_dry_run','guarded_archive_restore','other')),
  add column archive_manifest_sha256 text check (archive_manifest_sha256 ~ '^[0-9a-f]{64}$'),
  add column restore_report_sha256 text check (restore_report_sha256 ~ '^[0-9a-f]{64}$'),
  add column evidence_matches_export boolean,
  add constraint chk_recovery_drill_evidence check (
    (coalesce(drill_kind, '') in ('export_archive_dry_run','guarded_archive_restore')) = (archive_manifest_sha256 is not null)
    and (coalesce(drill_kind, '') = 'guarded_archive_restore') = (restore_report_sha256 is not null)
    and (evidence_matches_export is null) = (archive_manifest_sha256 is null)
    and (coalesce(drill_kind, '') not in ('export_archive_dry_run','guarded_archive_restore') or outcome <> 'passed'));

create function app.record_recovery_drill_with_evidence(
  p_drill_date date, p_outcome text, p_restored_to text, p_rpo_minutes integer, p_rto_minutes integer, p_notes text, p_evidence_ref text,
  p_kind text, p_manifest_sha text, p_report_sha text
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
  v_notes text := nullif(btrim(coalesce(p_notes, '')), '');
  v_ref text := nullif(btrim(coalesce(p_evidence_ref, '')), '');
  v_manifest text := nullif(btrim(coalesce(p_manifest_sha, '')), '');
  v_report text := nullif(btrim(coalesce(p_report_sha, '')), '');
  v_archive boolean := p_kind in ('export_archive_dry_run','guarded_archive_restore');
  v_matches boolean;
begin
  if not app.is_operro_owner() then raise exception 'not_authorized' using errcode = '42501'; end if;
  if p_drill_date is null or p_drill_date > current_date or p_outcome not in ('passed','failed','partial')
     or p_restored_to not in ('disposable_project','staging_project','other')
     or p_kind is null or p_kind not in ('provider_backup','export_archive_dry_run','guarded_archive_restore','other')
     or (p_rpo_minutes is not null and p_rpo_minutes not between 0 and 525600) or (p_rto_minutes is not null and p_rto_minutes not between 0 and 525600)
     or length(coalesce(v_notes, '')) > 500 or length(coalesce(v_ref, '')) > 300 then
    raise exception 'invalid_drill' using errcode = '22023'; end if;
  if v_archive and p_outcome = 'passed' then raise exception 'archive_drill_cannot_pass' using errcode = '22023'; end if;
  if (v_archive <> (v_manifest is not null)) or ((p_kind = 'guarded_archive_restore') <> (v_report is not null))
     or (v_manifest is not null and v_manifest !~ '^[0-9a-f]{64}$') or (v_report is not null and v_report !~ '^[0-9a-f]{64}$') then
    raise exception 'invalid_drill_evidence' using errcode = '22023'; end if;
  if coalesce(v_notes, '') || ' ' || coalesce(v_ref, '') ~* '(eyJ[A-Za-z0-9_-]{10,}|sb_secret|service_role|sk_(live|test)_|password\s*[=:]|postgres(ql)?://[^ ]*:[^ ]*@|apikey\s*[=:]|bearer\s+[A-Za-z0-9._-]{12,})' then
    raise exception 'credential_like_text' using errcode = '22023'; end if;
  if v_manifest is not null then
    v_matches := exists (select 1 from public.organization_export_jobs j where j.status = 'completed' and j.manifest ->> 'manifestSha256' = v_manifest);
  end if;
  insert into public.recovery_drills(drill_date, outcome, restored_to, rpo_minutes, rto_minutes, notes, evidence_ref, recorded_by,
                                     drill_kind, archive_manifest_sha256, restore_report_sha256, evidence_matches_export)
  values (p_drill_date, p_outcome, p_restored_to, p_rpo_minutes, p_rto_minutes, v_notes, v_ref, app.fn_current_user_id(),
          p_kind, v_manifest, v_report, v_matches)
  returning id into v_id;
  return v_id;
end $$;

-- Recovery status for any business owner (minimal) or the platform owner (full). No tenant data is involved.
create or replace function app.recovery_status() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid := app.fn_active_organization(); v_full boolean := app.is_operro_owner(); v_last public.recovery_drills; v_total integer; v_passed public.recovery_drills; v_matching integer;
begin
  if not v_full and (v_org is null or not app.has_membership() or not app.is_business_owner_member(v_org)) then
    raise exception 'not_authorized' using errcode = '42501'; end if;
  select * into v_last from public.recovery_drills order by drill_date desc, recorded_at desc limit 1;
  select * into v_passed from public.recovery_drills where outcome = 'passed' order by drill_date desc, recorded_at desc limit 1;
  select count(*) into v_total from public.recovery_drills;
  select count(*) into v_matching from public.recovery_drills where evidence_matches_export is true;
  return jsonb_build_object(
    'drills_recorded', v_total,
    'drills_with_matching_evidence', v_matching,
    'last_drill_date', v_last.drill_date, 'last_outcome', v_last.outcome,
    'last_passed_date', v_passed.drill_date,
    'detail', case when v_full and v_last.id is not null then jsonb_build_object(
      'restored_to', v_last.restored_to, 'rpo_minutes', v_last.rpo_minutes, 'rto_minutes', v_last.rto_minutes,
      'notes', v_last.notes, 'evidence_ref', v_last.evidence_ref, 'recorded_at', v_last.recorded_at,
      'kind', v_last.drill_kind, 'archive_manifest_sha256', v_last.archive_manifest_sha256, 'restore_report_sha256', v_last.restore_report_sha256,
      'evidence_matches_export', v_last.evidence_matches_export) end);
end $$;

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
        'schedule_consent', coalesce((select s.enabled from public.storage_cleanup_schedules s where s.organization_id = v_org), false),
        'last_completed_apply_at', max(finished_at) filter (where mode = 'apply' and status = 'completed'),
        'last_dry_run_at', max(started_at) filter (where mode = 'dry_run'),
        -- candidates the latest preview found that no later apply run has acted on: a preview alone removes nothing
        'unapplied_preview_candidates', coalesce((
            select case when exists (select 1 from public.storage_cleanup_runs a where a.organization_id = v_org and a.mode = 'apply' and a.started_at >= d.started_at)
                        then 0 else d.candidate_count end
              from (select r.started_at, r.candidate_count from public.storage_cleanup_runs r
                     where r.organization_id = v_org and r.mode = 'dry_run' order by r.started_at desc limit 1) d), 0))
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

revoke all on function app.record_recovery_drill_with_evidence(date, text, text, integer, integer, text, text, text, text, text) from public, anon, authenticated;
grant execute on function app.record_recovery_drill_with_evidence(date, text, text, integer, integer, text, text, text, text, text) to authenticated;

-- Kept in step with the newest migration file by apps/web/test/health-recovery.test.ts (it fails on drift).
create or replace function app.schema_version() returns text language sql immutable set search_path = '' as $$
  select '20261101160000'::text;
$$;

notify pgrst, 'reload schema';
commit;
