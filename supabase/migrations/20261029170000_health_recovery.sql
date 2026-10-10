-- E3.4 Read-only health surface + recovery-readiness records (parity #44).
--
-- Health is a SUMMARY of signals Operro already stores - nothing is probed, nothing is written, no provider API is
-- called, and no credential, raw provider log or billing estimate is involved:
--   schema version (this file defines it), failed/stale bounded maintenance jobs (organization exports and storage
--   cleanup), pending capacity requests, and stale lease/age states.
-- Recovery readiness adds one new fact only a human can supply: whether a restore drill was actually performed. Drills
-- are append-only platform records written solely by the Operro platform owner. Until one passed recently, every
-- surface says recovery is NOT proven.
begin;

-- Kept in step with the newest migration file by apps/web/test/health-recovery.test.ts (it fails on drift).
create function app.schema_version() returns text language sql immutable set search_path = '' as $$
  select '20261029170000'::text;
$$;

create table public.recovery_drills (
  id uuid primary key default app.fn_uuid_v7(),
  drill_date date not null check (drill_date between date '2020-01-01' and date '2100-12-31'),
  outcome text not null check (outcome in ('passed','failed','partial')),
  restored_to text not null check (restored_to in ('disposable_project','staging_project','other')),
  rpo_minutes integer check (rpo_minutes is null or rpo_minutes between 0 and 525600),
  rto_minutes integer check (rto_minutes is null or rto_minutes between 0 and 525600),
  notes text check (notes is null or length(notes) <= 500),
  evidence_ref text check (evidence_ref is null or length(evidence_ref) <= 300),
  recorded_by uuid not null,
  recorded_at timestamptz not null default now()
);
create index idx_recovery_drills_date on public.recovery_drills (drill_date desc, recorded_at desc);
create function app.tg_recovery_drills_append_only() returns trigger language plpgsql set search_path = '' as $$
begin raise exception 'recovery drill records are append-only' using errcode = 'restrict_violation'; end $$;
create trigger trg_recovery_drills_append_only before update or delete on public.recovery_drills
  for each row execute function app.tg_recovery_drills_append_only();
alter table public.recovery_drills enable row level security;
revoke all on public.recovery_drills from public, anon, authenticated;
grant select on public.recovery_drills to authenticated;
create policy recovery_drills_platform_read on public.recovery_drills for select to authenticated using (app.is_operro_owner());

-- Only the platform owner records a drill. Free text may not look like a credential.
create function app.record_recovery_drill(
  p_drill_date date, p_outcome text, p_restored_to text, p_rpo_minutes integer, p_rto_minutes integer, p_notes text, p_evidence_ref text
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_notes text := nullif(btrim(coalesce(p_notes, '')), ''); v_ref text := nullif(btrim(coalesce(p_evidence_ref, '')), '');
begin
  if not app.is_operro_owner() then raise exception 'not_authorized' using errcode = '42501'; end if;
  if p_drill_date is null or p_drill_date > current_date or p_outcome not in ('passed','failed','partial')
     or p_restored_to not in ('disposable_project','staging_project','other')
     or (p_rpo_minutes is not null and p_rpo_minutes not between 0 and 525600) or (p_rto_minutes is not null and p_rto_minutes not between 0 and 525600)
     or length(coalesce(v_notes, '')) > 500 or length(coalesce(v_ref, '')) > 300 then
    raise exception 'invalid_drill' using errcode = '22023'; end if;
  if coalesce(v_notes, '') || ' ' || coalesce(v_ref, '') ~* '(eyJ[A-Za-z0-9_-]{10,}|sb_secret|service_role|sk_(live|test)_|password\s*[=:]|postgres(ql)?://[^ ]*:[^ ]*@|apikey\s*[=:]|bearer\s+[A-Za-z0-9._-]{12,})' then
    raise exception 'credential_like_text' using errcode = '22023'; end if;
  insert into public.recovery_drills(drill_date, outcome, restored_to, rpo_minutes, rto_minutes, notes, evidence_ref, recorded_by)
  values (p_drill_date, p_outcome, p_restored_to, p_rpo_minutes, p_rto_minutes, v_notes, v_ref, app.fn_current_user_id())
  returning id into v_id;
  return v_id;
end $$;

-- Recovery status for any business owner (minimal) or the platform owner (full). No tenant data is involved.
create function app.recovery_status() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid := app.fn_active_organization(); v_full boolean := app.is_operro_owner(); v_last public.recovery_drills; v_total integer; v_passed public.recovery_drills;
begin
  if not v_full and (v_org is null or not app.has_membership() or not app.is_business_owner_member(v_org)) then
    raise exception 'not_authorized' using errcode = '42501'; end if;
  select * into v_last from public.recovery_drills order by drill_date desc, recorded_at desc limit 1;
  select * into v_passed from public.recovery_drills where outcome = 'passed' order by drill_date desc, recorded_at desc limit 1;
  select count(*) into v_total from public.recovery_drills;
  return jsonb_build_object(
    'drills_recorded', v_total,
    'last_drill_date', v_last.drill_date, 'last_outcome', v_last.outcome,
    'last_passed_date', v_passed.drill_date,
    'detail', case when v_full and v_last.id is not null then jsonb_build_object(
      'restored_to', v_last.restored_to, 'rpo_minutes', v_last.rpo_minutes, 'rto_minutes', v_last.rto_minutes,
      'notes', v_last.notes, 'evidence_ref', v_last.evidence_ref, 'recorded_at', v_last.recorded_at) end);
end $$;

-- Health summary for the active organization (business owner or platform owner). Counts and timestamps only.
create function app.health_summary() returns jsonb
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
        'last_failure_at', max(created_at) filter (where status = 'failed'))
      from public.organization_export_jobs where organization_id = v_org),
    'cleanup', (select jsonb_build_object(
        'problem_runs_30d', count(*) filter (where mode = 'apply' and status in ('failed','partial','abandoned') and started_at > now() - interval '30 days'),
        'stale_running', count(*) filter (where mode = 'apply' and status = 'running' and lease_expires_at < now()),
        'last_apply_status', (select r.status from public.storage_cleanup_runs r where r.organization_id = v_org and r.mode = 'apply' order by r.started_at desc limit 1),
        'last_apply_at', max(started_at) filter (where mode = 'apply'),
        'pending_objects', (select count(*) from public.storage_cleanup_items i where i.organization_id = v_org and i.state in ('marked','failed','abandoned')))
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

revoke all on function app.schema_version(), app.tg_recovery_drills_append_only(),
  app.record_recovery_drill(date, text, text, integer, integer, text, text), app.recovery_status(), app.health_summary()
  from public, anon, authenticated;
grant execute on function app.schema_version(), app.record_recovery_drill(date, text, text, integer, integer, text, text),
  app.recovery_status(), app.health_summary() to authenticated;

-- Make the new RPCs visible to PostgREST without waiting for its schema-cache refresh.
notify pgrst, 'reload schema';
commit;
