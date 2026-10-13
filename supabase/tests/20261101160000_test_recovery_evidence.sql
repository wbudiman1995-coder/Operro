-- Streams 7+8: restore-drill evidence verified against real exports, append-only drills, role gates, redaction, cleanup signals.
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/20261101160000_test_recovery_evidence.sql
\set ON_ERROR_STOP on
create or replace function pg_temp.act_as(u text, o text) returns void language plpgsql as $$
begin perform set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated', 'active_org_id', o)::text, true); end $$;
create or replace function pg_temp.expect(p_sql text, p_state text, p_label text) returns void language plpgsql as $$
begin
  begin execute p_sql; exception when others then
    if sqlstate = p_state then raise notice 'PASS: %', p_label; return; end if;
    raise exception 'FAIL: % (expected %, got % %)', p_label, p_state, sqlstate, sqlerrm;
  end;
  raise exception 'FAIL: % (statement succeeded)', p_label;
end $$;
create or replace function pg_temp.check(p_ok boolean, p_label text) returns void language plpgsql as $$
begin if p_ok is not true then raise exception 'FAIL: %', p_label; end if; raise notice 'PASS: %', p_label; end $$;

begin;
insert into public.organizations (id, name, slug, status) values
  ('e9000000-0000-4000-8000-000000000001', 'Rec A', 'rec-a-test', 'active'),
  ('e9000000-0000-4000-8000-000000000002', 'Rec B', 'rec-b-test', 'active');
insert into public.roles (id, organization_id, name) values
  ('e9000000-0000-4000-8000-000000000011', 'e9000000-0000-4000-8000-000000000001', 'Pemilik'),
  ('e9000000-0000-4000-8000-000000000012', 'e9000000-0000-4000-8000-000000000001', 'Admin'),
  ('e9000000-0000-4000-8000-000000000013', 'e9000000-0000-4000-8000-000000000002', 'Pemilik');
insert into auth.users (id, email, raw_user_meta_data) values
  ('e9000000-0000-4000-8000-000000000021', 'owner-a@rec.test', '{}'),
  ('e9000000-0000-4000-8000-000000000022', 'admin-a@rec.test', '{}'),
  ('e9000000-0000-4000-8000-000000000023', 'owner-b@rec.test', '{}'),
  ('e9000000-0000-4000-8000-000000000024', 'wbudiman1995@gmail.com', '{}');
update public.users set status = 'active' where id::text like 'e9000000-%';
update public.users set is_platform_admin = true where id = 'e9000000-0000-4000-8000-000000000024';
insert into public.memberships (user_id, organization_id, role_id, status) values
  ('e9000000-0000-4000-8000-000000000021', 'e9000000-0000-4000-8000-000000000001', 'e9000000-0000-4000-8000-000000000011', 'active'),
  ('e9000000-0000-4000-8000-000000000022', 'e9000000-0000-4000-8000-000000000001', 'e9000000-0000-4000-8000-000000000012', 'active'),
  ('e9000000-0000-4000-8000-000000000023', 'e9000000-0000-4000-8000-000000000002', 'e9000000-0000-4000-8000-000000000013', 'active');
-- Completed exports with known manifest hashes (one running, one failed: neither counts as evidence).
insert into public.organization_export_jobs(id, organization_id, status, storage_prefix, created_by, created_at, completed_at, manifest) values
  ('e9000000-0000-4000-8000-0000000000a1', 'e9000000-0000-4000-8000-000000000001', 'completed', 'a/1', 'e9000000-0000-4000-8000-000000000021', now() - interval '3 days', now() - interval '3 days', jsonb_build_object('manifestSha256', repeat('a', 64))),
  ('e9000000-0000-4000-8000-0000000000a2', 'e9000000-0000-4000-8000-000000000002', 'completed', 'b/1', 'e9000000-0000-4000-8000-000000000023', now() - interval '2 days', now() - interval '2 days', jsonb_build_object('manifestSha256', repeat('b', 64))),
  ('e9000000-0000-4000-8000-0000000000a3', 'e9000000-0000-4000-8000-000000000001', 'failed', 'a/3', 'e9000000-0000-4000-8000-000000000021', now() - interval '1 day', now() - interval '1 day', jsonb_build_object('manifestSha256', repeat('c', 64)));

set local role authenticated;
create temp table ids (k text primary key, v uuid);
grant all on ids to authenticated;

-- ===== Platform owner records drills ===========================================================================================
select pg_temp.act_as('e9000000-0000-4000-8000-000000000024', 'e9000000-0000-4000-8000-000000000001');
do $$
declare s jsonb; d public.recovery_drills;
begin
  perform pg_temp.check((app.recovery_status() ->> 'drills_recorded')::int = 0 and (app.recovery_status() ->> 'drills_with_matching_evidence')::int = 0, 'no drills: nothing is proven and no evidence exists');
  insert into ids values ('backup', app.record_recovery_drill_with_evidence(current_date - 5, 'passed', 'disposable_project', 120, 45, 'Pemulihan PITR ke proyek percobaan', 'ticket-17', 'provider_backup', null, null));
  select * into d from public.recovery_drills where id = (select v from ids where k = 'backup');
  perform pg_temp.check(d.drill_kind = 'provider_backup' and d.evidence_matches_export is null and d.archive_manifest_sha256 is null, 'a provider-backup drill may pass and carries no archive evidence');
  insert into ids values ('dry', app.record_recovery_drill_with_evidence(current_date - 4, 'partial', 'disposable_project', null, null, 'kind=export-archive-dry-run', null, 'export_archive_dry_run', repeat('a', 64), null));
  select * into d from public.recovery_drills where id = (select v from ids where k = 'dry');
  perform pg_temp.check(d.evidence_matches_export is true and d.archive_manifest_sha256 = repeat('a', 64) and d.restore_report_sha256 is null, 'an archive dry run whose manifest hash is a completed export is marked as matching');
  insert into ids values ('restore', app.record_recovery_drill_with_evidence(current_date - 3, 'partial', 'disposable_project', null, 30, 'Pemulihan terpandu ke database percobaan', 'evidence-2026-10-13', 'guarded_archive_restore', repeat('b', 64), repeat('d', 64)));
  select * into d from public.recovery_drills where id = (select v from ids where k = 'restore');
  perform pg_temp.check(d.evidence_matches_export is true and d.restore_report_sha256 = repeat('d', 64), 'a guarded restore matches an export of another organization too (the platform owner sees every archive) and keeps both hashes');
  insert into ids values ('unmatched', app.record_recovery_drill_with_evidence(current_date - 2, 'failed', 'disposable_project', null, null, null, null, 'guarded_archive_restore', repeat('e', 64), repeat('f', 64)));
  select * into d from public.recovery_drills where id = (select v from ids where k = 'unmatched');
  perform pg_temp.check(d.evidence_matches_export is false, 'a hash that is not any completed export is recorded but flagged as not matching');
  insert into ids values ('failedjob', app.record_recovery_drill_with_evidence(current_date - 1, 'failed', 'staging_project', null, null, null, null, 'export_archive_dry_run', repeat('c', 64), null));
  perform pg_temp.check((select evidence_matches_export from public.recovery_drills where id = (select v from ids where k = 'failedjob')) is false, 'a failed export job is not evidence');
  s := app.recovery_status();
  perform pg_temp.check((s ->> 'drills_recorded')::int = 5 and (s ->> 'drills_with_matching_evidence')::int = 2, 'the status counts drills with matching evidence');
  perform pg_temp.check(s ->> 'last_passed_date' = (current_date - 5)::text, 'only the provider-backup drill passed');
  perform pg_temp.check(s #>> '{detail,kind}' = 'export_archive_dry_run' and s #>> '{detail,evidence_matches_export}' = 'false', 'the platform owner sees the latest drill''s kind and evidence flag');
  perform pg_temp.check(s #>> '{detail,archive_manifest_sha256}' = repeat('c', 64), 'and its manifest hash');

  perform pg_temp.expect($q$select app.record_recovery_drill_with_evidence(current_date, 'passed', 'disposable_project', null, null, null, null, 'guarded_archive_restore', repeat('a', 64), repeat('d', 64))$q$, '22023', 'a guarded restore can never be recorded as passed');
  perform pg_temp.expect($q$select app.record_recovery_drill_with_evidence(current_date, 'passed', 'disposable_project', null, null, null, null, 'export_archive_dry_run', repeat('a', 64), null)$q$, '22023', 'neither can an archive dry run');
  perform pg_temp.expect($q$select app.record_recovery_drill_with_evidence(current_date, 'partial', 'disposable_project', null, null, null, null, 'guarded_archive_restore', repeat('a', 64), null)$q$, '22023', 'a guarded restore needs its report hash');
  perform pg_temp.expect($q$select app.record_recovery_drill_with_evidence(current_date, 'partial', 'disposable_project', null, null, null, null, 'export_archive_dry_run', null, null)$q$, '22023', 'an archive drill needs the manifest hash');
  perform pg_temp.expect($q$select app.record_recovery_drill_with_evidence(current_date, 'partial', 'disposable_project', null, null, null, null, 'provider_backup', repeat('a', 64), null)$q$, '22023', 'a provider-backup drill carries no archive hash');
  perform pg_temp.expect($q$select app.record_recovery_drill_with_evidence(current_date, 'partial', 'disposable_project', null, null, null, null, 'export_archive_dry_run', repeat('A', 64), null)$q$, '22023', 'upper-case hex is refused');
  perform pg_temp.expect($q$select app.record_recovery_drill_with_evidence(current_date, 'partial', 'disposable_project', null, null, null, null, 'export_archive_dry_run', repeat('a', 63), null)$q$, '22023', 'a short hash is refused');
  perform pg_temp.expect($q$select app.record_recovery_drill_with_evidence(current_date, 'partial', 'disposable_project', null, null, null, null, 'export_archive_dry_run', 'not-a-hash', null)$q$, '22023', 'a non-hash is refused');
  perform pg_temp.expect($q$select app.record_recovery_drill_with_evidence(current_date, 'partial', 'disposable_project', null, null, null, null, 'tape_archive', null, null)$q$, '22023', 'an unknown kind is refused');
  perform pg_temp.expect($q$select app.record_recovery_drill_with_evidence(current_date, 'partial', 'disposable_project', null, null, null, null, null, null, null)$q$, '22023', 'a missing kind is refused');
  perform pg_temp.expect($q$select app.record_recovery_drill_with_evidence(current_date + 1, 'failed', 'disposable_project', null, null, null, null, 'other', null, null)$q$, '22023', 'a drill in the future is refused');
  perform pg_temp.expect($q$select app.record_recovery_drill_with_evidence(current_date, 'bogus', 'disposable_project', null, null, null, null, 'other', null, null)$q$, '22023', 'an unknown outcome is refused');
  perform pg_temp.expect($q$select app.record_recovery_drill_with_evidence(current_date, 'failed', 'disposable_project', -1, null, null, null, 'other', null, null)$q$, '22023', 'a negative RPO is refused');
  perform pg_temp.expect($q$select app.record_recovery_drill_with_evidence(current_date, 'failed', 'disposable_project', null, null, 'postgres://u:secret@host/db', null, 'other', null, null)$q$, '22023', 'a connection string in the notes is refused');
  perform pg_temp.expect($q$select app.record_recovery_drill_with_evidence(current_date, 'failed', 'disposable_project', null, null, null, 'Bearer abcdefghijklmnop1234', 'other', null, null)$q$, '22023', 'a bearer token in the evidence reference is refused');
  perform pg_temp.check((select count(*) from public.recovery_drills) = 5, 'every refused call left no row behind');

  perform pg_temp.expect($q$update public.recovery_drills set outcome = 'passed'$q$, '42501', 'authenticated cannot UPDATE a drill');
  perform pg_temp.expect($q$delete from public.recovery_drills$q$, '42501', 'nor DELETE one');
end $$;

-- ===== Everyone else ============================================================================================================
select pg_temp.act_as('e9000000-0000-4000-8000-000000000021', 'e9000000-0000-4000-8000-000000000001');
do $$
declare s jsonb;
begin
  perform pg_temp.expect($q$select app.record_recovery_drill_with_evidence(current_date, 'partial', 'disposable_project', null, null, null, null, 'other', null, null)$q$, '42501', 'a business owner cannot record a drill');
  s := app.recovery_status();
  perform pg_temp.check((s ->> 'drills_recorded')::int = 5 and (s ->> 'drills_with_matching_evidence')::int = 2, 'a business owner sees the counts');
  perform pg_temp.check(s -> 'detail' = 'null'::jsonb and not (s::text ~* '(kind|manifest|sha256|evidence_ref|notes)'), 'but no kind, hash, note or evidence reference (platform detail stays redacted)');
end $$;
select pg_temp.act_as('e9000000-0000-4000-8000-000000000022', 'e9000000-0000-4000-8000-000000000001');
do $$ begin
  perform pg_temp.expect($q$select app.record_recovery_drill_with_evidence(current_date, 'partial', 'disposable_project', null, null, null, null, 'other', null, null)$q$, '42501', 'a tenant Admin cannot record a drill');
  perform pg_temp.expect($q$select app.recovery_status()$q$, '42501', 'nor read the recovery status');
end $$;
reset role;
do $$ begin
  perform pg_temp.expect($q$update public.recovery_drills set outcome = 'passed'$q$, '23001', 'the owner of the table cannot UPDATE a drill either');
  perform pg_temp.expect($q$delete from public.recovery_drills$q$, '23001', 'nor DELETE one');
  perform pg_temp.expect($q$insert into public.recovery_drills(drill_date, outcome, restored_to, recorded_by, drill_kind, archive_manifest_sha256, restore_report_sha256, evidence_matches_export) values (current_date, 'passed', 'other', 'e9000000-0000-4000-8000-000000000024', 'guarded_archive_restore', repeat('a', 64), repeat('b', 64), true)$q$, '23514', 'even a direct insert cannot make an archive drill pass (table constraint)');
  perform pg_temp.expect($q$insert into public.recovery_drills(drill_date, outcome, restored_to, recorded_by, drill_kind, archive_manifest_sha256, evidence_matches_export) values (current_date, 'partial', 'other', 'e9000000-0000-4000-8000-000000000024', 'provider_backup', repeat('a', 64), true)$q$, '23514', 'or attach archive evidence to a provider-backup drill');
  perform pg_temp.expect($q$insert into public.recovery_drills(drill_date, outcome, restored_to, recorded_by, drill_kind, archive_manifest_sha256) values (current_date, 'partial', 'other', 'e9000000-0000-4000-8000-000000000024', 'export_archive_dry_run', repeat('a', 64))$q$, '23514', 'or leave the evidence flag unset when a hash is present');
end $$;

-- ===== Cleanup signals =========================================================================================================
insert into public.storage_cleanup_runs (id, organization_id, mode, status, candidate_count, started_at, finished_at) values
  ('e9000000-0000-4000-8000-0000000000c1', 'e9000000-0000-4000-8000-000000000001', 'dry_run', 'completed', 7, now() - interval '10 days', now() - interval '10 days'),
  ('e9000000-0000-4000-8000-0000000000c2', 'e9000000-0000-4000-8000-000000000001', 'apply', 'completed', 7, now() - interval '9 days', now() - interval '9 days'),
  ('e9000000-0000-4000-8000-0000000000c3', 'e9000000-0000-4000-8000-000000000001', 'dry_run', 'completed', 4, now() - interval '2 days', now() - interval '2 days'),
  ('e9000000-0000-4000-8000-0000000000c4', 'e9000000-0000-4000-8000-000000000002', 'dry_run', 'completed', 9, now() - interval '1 day', now() - interval '1 day');
set local role authenticated;
select pg_temp.act_as('e9000000-0000-4000-8000-000000000021', 'e9000000-0000-4000-8000-000000000001');
do $$
declare c jsonb;
begin
  c := app.health_summary() -> 'cleanup';
  perform pg_temp.check((c ->> 'unapplied_preview_candidates')::int = 4, 'the latest preview found 4 candidates and no apply has run since');
  perform pg_temp.check((c ->> 'last_dry_run_at')::timestamptz > now() - interval '3 days', 'the time of the latest preview is reported');
  perform pg_temp.check((c ->> 'last_completed_apply_at')::timestamptz between now() - interval '10 days' and now() - interval '8 days', 'and of the last completed apply');
  perform pg_temp.check(c ? 'problem_runs_30d' and c ? 'pending_objects' and c ? 'schedule_consent', 'the existing cleanup signals are all still there');
end $$;
reset role;
insert into public.storage_cleanup_runs (id, organization_id, mode, status, candidate_count, started_at, finished_at) values
  ('e9000000-0000-4000-8000-0000000000c5', 'e9000000-0000-4000-8000-000000000001', 'apply', 'completed', 4, now() - interval '1 day', now() - interval '1 day');
set local role authenticated;
select pg_temp.act_as('e9000000-0000-4000-8000-000000000021', 'e9000000-0000-4000-8000-000000000001');
do $$ begin
  perform pg_temp.check((app.health_summary() #>> '{cleanup,unapplied_preview_candidates}')::int = 0, 'once an apply has run after the preview there is nothing left to apply');
end $$;
select pg_temp.act_as('e9000000-0000-4000-8000-000000000023', 'e9000000-0000-4000-8000-000000000002');
do $$ begin
  perform pg_temp.check((app.health_summary() #>> '{cleanup,unapplied_preview_candidates}')::int = 9 and (app.health_summary() #> '{cleanup,last_completed_apply_at}') = 'null'::jsonb, 'tenant B sees only its own preview and no apply');
  perform pg_temp.check(not (app.health_summary()::text ~ 'e9000000-0000-4000-8000-0000000000c[123]'), 'and none of tenant A''s runs');
end $$;
reset role;

-- ===== Grants / structure =========================================================================================================
do $$
declare v_def boolean; v_cfg text[];
begin
  select p.prosecdef, p.proconfig into v_def, v_cfg from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'app' and p.proname = 'record_recovery_drill_with_evidence';
  perform pg_temp.check(v_def and v_cfg && array['search_path=""', 'search_path='], 'record_recovery_drill_with_evidence is SECURITY DEFINER with an empty search_path');
  perform pg_temp.check(not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
     where n.nspname = 'app' and p.proname in ('record_recovery_drill_with_evidence','recovery_status','health_summary') and (a.grantee = 0 or a.grantee = 'anon'::regrole)), 'anon and PUBLIC cannot execute the drill, status or health functions');
  perform pg_temp.check(has_function_privilege('authenticated', 'app.record_recovery_drill_with_evidence(date, text, text, integer, integer, text, text, text, text, text)', 'execute'), 'authenticated may call the recorder (the function checks the platform owner)');
  perform pg_temp.check(not has_table_privilege('authenticated', 'public.recovery_drills', 'insert') and not has_table_privilege('authenticated', 'public.recovery_drills', 'update'), 'clients cannot write drills directly');
  perform pg_temp.check(app.schema_version() >= '20261101160000', 'schema version moved to (or past) this migration');
end $$;
rollback;
