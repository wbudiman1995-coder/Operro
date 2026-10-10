-- E3.4 health summary + recovery-readiness records: authorization, tenant redaction, stale/failure states, append-only drills.
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/20261029170000_test_health_recovery.sql
\set ON_ERROR_STOP on
create or replace function pg_temp.claims(p_user uuid, p_org uuid, p_platform boolean default false) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated', 'active_org_id', p_org,
    'app_metadata', json_build_object('is_platform_admin', p_platform))::text, true);
end $$;
create or replace function pg_temp.expect(p_sql text, p_state text, p_label text) returns void language plpgsql as $$
begin
  begin execute p_sql; exception when others then
    if sqlstate = p_state then raise notice 'PASS: %', p_label; return; end if;
    raise exception 'FAIL: % (expected %, got % %)', p_label, p_state, sqlstate, sqlerrm;
  end;
  raise exception 'FAIL: % (statement succeeded)', p_label;
end $$;
create or replace function pg_temp.ok(p_cond boolean, p_label text) returns void language plpgsql as $$
begin if p_cond is true then raise notice 'PASS: %', p_label; else raise exception 'FAIL: %', p_label; end if; end $$;

begin;
insert into public.organizations (id, name, slug, status) values
  ('c9f00000-0000-4000-8000-000000000001', 'Health A', 'health-a-test', 'active'),
  ('c9f00000-0000-4000-8000-000000000002', 'Health B', 'health-b-test', 'active');
insert into public.subscriptions (organization_id, status, current_period_start, current_period_end)
  select o, 'active', now() - interval '1 day', now() + interval '1 year'
  from (values ('c9f00000-0000-4000-8000-000000000001'::uuid), ('c9f00000-0000-4000-8000-000000000002'::uuid)) t(o);
insert into public.organization_modules (organization_id, module_id, enabled, source)
  select o, m.id, true, 'override' from public.modules m,
  (values ('c9f00000-0000-4000-8000-000000000001'::uuid), ('c9f00000-0000-4000-8000-000000000002'::uuid)) t(o);
insert into public.roles (id, organization_id, name) values
  ('c9f00000-0000-4000-8000-000000000011', 'c9f00000-0000-4000-8000-000000000001', 'Pemilik'),
  ('c9f00000-0000-4000-8000-000000000012', 'c9f00000-0000-4000-8000-000000000001', 'Manager'),
  ('c9f00000-0000-4000-8000-000000000013', 'c9f00000-0000-4000-8000-000000000002', 'Pemilik');
insert into public.role_permissions (organization_id, role_id, permission_id)
  select 'c9f00000-0000-4000-8000-000000000001', 'c9f00000-0000-4000-8000-000000000011', id from public.permissions where key in ('settings.manage');
insert into public.role_permissions (organization_id, role_id, permission_id)
  select 'c9f00000-0000-4000-8000-000000000001', 'c9f00000-0000-4000-8000-000000000012', id from public.permissions where key in ('settings.manage', 'reports.view');
insert into public.role_permissions (organization_id, role_id, permission_id)
  select 'c9f00000-0000-4000-8000-000000000002', 'c9f00000-0000-4000-8000-000000000013', id from public.permissions where key in ('settings.manage');
insert into auth.users (id, email, raw_user_meta_data) values
  ('c9f00000-0000-4000-8000-000000000021', 'owner-a@health.test', '{}'),
  ('c9f00000-0000-4000-8000-000000000022', 'manager-a@health.test', '{}'),
  ('c9f00000-0000-4000-8000-000000000023', 'owner-b@health.test', '{}'),
  ('c9f00000-0000-4000-8000-000000000024', 'wbudiman1995@gmail.com', '{}');
update public.users set status = 'active' where id::text like 'c9f00000-%';
update public.users set is_platform_admin = true where id = 'c9f00000-0000-4000-8000-000000000024';
insert into public.memberships (user_id, organization_id, role_id, status) values
  ('c9f00000-0000-4000-8000-000000000021', 'c9f00000-0000-4000-8000-000000000001', 'c9f00000-0000-4000-8000-000000000011', 'active'),
  ('c9f00000-0000-4000-8000-000000000022', 'c9f00000-0000-4000-8000-000000000001', 'c9f00000-0000-4000-8000-000000000012', 'active'),
  ('c9f00000-0000-4000-8000-000000000023', 'c9f00000-0000-4000-8000-000000000002', 'c9f00000-0000-4000-8000-000000000013', 'active');

-- Org A signals: one failed export (recent), one stale running export, one old completed export, a partial cleanup run,
-- a running cleanup whose lease lapsed, 2 pending cleanup objects, and a capacity request pending for 20 days.
insert into public.organization_export_jobs (id, organization_id, status, storage_prefix, created_by, created_at, completed_at, failed_reason) values
  ('c9f00000-0000-4000-8000-0000000000e1', 'c9f00000-0000-4000-8000-000000000001', 'failed', 'a/exports/1', 'c9f00000-0000-4000-8000-000000000021', now() - interval '3 days', null, 'RAW PROVIDER ERROR: must never be surfaced'),
  ('c9f00000-0000-4000-8000-0000000000e2', 'c9f00000-0000-4000-8000-000000000001', 'completed', 'a/exports/2', 'c9f00000-0000-4000-8000-000000000021', now() - interval '40 days', now() - interval '40 days', null),
  ('c9f00000-0000-4000-8000-0000000000e3', 'c9f00000-0000-4000-8000-000000000002', 'failed', 'b/exports/1', 'c9f00000-0000-4000-8000-000000000023', now() - interval '1 day', null, 'other tenant failure'),
  ('c9f00000-0000-4000-8000-0000000000e4', 'c9f00000-0000-4000-8000-000000000002', 'failed', 'b/exports/2', 'c9f00000-0000-4000-8000-000000000023', now() - interval '2 days', null, 'other tenant failure 2');
insert into public.organization_export_jobs (id, organization_id, status, storage_prefix, created_by, created_at) values
  ('c9f00000-0000-4000-8000-0000000000e5', 'c9f00000-0000-4000-8000-000000000001', 'running', 'a/exports/3', 'c9f00000-0000-4000-8000-000000000021', now() - interval '5 hours');
insert into public.storage_cleanup_runs (id, organization_id, mode, status, lease_expires_at, started_at) values
  ('c9f00000-0000-4000-8000-0000000000c1', 'c9f00000-0000-4000-8000-000000000001', 'apply', 'partial', null, now() - interval '2 days'),
  ('c9f00000-0000-4000-8000-0000000000c2', 'c9f00000-0000-4000-8000-000000000001', 'apply', 'running', now() - interval '1 hour', now() - interval '3 hours'),
  ('c9f00000-0000-4000-8000-0000000000c3', 'c9f00000-0000-4000-8000-000000000002', 'apply', 'failed', null, now() - interval '1 day');
insert into public.storage_cleanup_items (organization_id, run_id, attachment_id, storage_bucket, storage_path, reason, state) values
  ('c9f00000-0000-4000-8000-000000000001', 'c9f00000-0000-4000-8000-0000000000c1', gen_random_uuid(), 'styling-references', 'c9f00000-0000-4000-8000-000000000001/a.jpg', 'styling_reference_expired', 'failed'),
  ('c9f00000-0000-4000-8000-000000000001', 'c9f00000-0000-4000-8000-0000000000c1', gen_random_uuid(), 'styling-references', 'c9f00000-0000-4000-8000-000000000001/b.jpg', 'styling_reference_expired', 'abandoned'),
  ('c9f00000-0000-4000-8000-000000000001', 'c9f00000-0000-4000-8000-0000000000c1', gen_random_uuid(), 'styling-references', 'c9f00000-0000-4000-8000-000000000001/c.jpg', 'styling_reference_expired', 'deleted');
insert into public.storage_upgrade_requests (organization_id, requested_gb, status, created_by, created_at) values
  ('c9f00000-0000-4000-8000-000000000001', 5, 'requested', 'c9f00000-0000-4000-8000-000000000021', now() - interval '20 days'),
  ('c9f00000-0000-4000-8000-000000000002', 10, 'contacted', 'c9f00000-0000-4000-8000-000000000023', now() - interval '1 day');

grant select on all tables in schema public to authenticated;
set local role authenticated;

-- ===== Business owner A: own-tenant signals only, counts not raw detail =====
select pg_temp.claims('c9f00000-0000-4000-8000-000000000021', 'c9f00000-0000-4000-8000-000000000001');
do $$
declare h jsonb;
begin
  h := app.health_summary();
  perform pg_temp.ok(h ->> 'schema_version' = app.schema_version() and app.schema_version() ~ '^[0-9]{14}$', 'schema version reported');
  perform pg_temp.ok((h #>> '{exports,failed_30d}')::int = 1 and (h #>> '{exports,stale_running}')::int = 1, 'failed and stale-running exports are counted for this tenant only');
  perform pg_temp.ok(h #>> '{exports,last_completed_at}' is not null, 'last completed export is reported');
  perform pg_temp.ok((h #>> '{cleanup,problem_runs_30d}')::int = 1 and (h #>> '{cleanup,stale_running}')::int = 1 and (h #>> '{cleanup,pending_objects}')::int = 2, 'partial cleanup run, lapsed lease and pending objects are surfaced');
  perform pg_temp.ok((h #>> '{capacity_requests,pending}')::int = 1 and (h #>> '{capacity_requests,stale_pending}')::int = 1, 'pending and stale capacity requests are surfaced');
  perform pg_temp.ok(not (h ? 'platform'), 'a business owner receives no platform-wide section');
  perform pg_temp.ok(h::text not ilike '%RAW PROVIDER ERROR%' and h::text not ilike '%other tenant%', 'raw failure text and other tenants never appear');
  perform pg_temp.ok(h::text !~* '(storage_path|token|secret|password|service_role|price|harga|bytes)', 'no credential, path, billing or size field is exposed');
end $$;

-- ===== Authorization =====
select pg_temp.claims('c9f00000-0000-4000-8000-000000000022', 'c9f00000-0000-4000-8000-000000000001');
do $$ begin
  perform pg_temp.expect($q$select app.health_summary()$q$, '42501', 'a non-owner manager (even with settings.manage and reports.view) cannot read health');
  perform pg_temp.expect($q$select app.recovery_status()$q$, '42501', 'a non-owner manager cannot read recovery status');
end $$;
select pg_temp.claims('c9f00000-0000-4000-8000-000000000023', 'c9f00000-0000-4000-8000-000000000001');
do $$ begin perform pg_temp.expect($q$select app.health_summary()$q$, '42501', 'forged organization claim refused'); end $$;
select pg_temp.claims('c9f00000-0000-4000-8000-000000000023', 'c9f00000-0000-4000-8000-000000000002');
do $$ declare h jsonb; begin
  h := app.health_summary();
  perform pg_temp.ok((h #>> '{exports,failed_30d}')::int = 2 and (h #>> '{cleanup,problem_runs_30d}')::int = 1 and (h #>> '{capacity_requests,pending}')::int = 1, 'tenant B sees only tenant B counts');
  perform pg_temp.ok((h #>> '{exports,stale_running}')::int = 0, 'tenant B has no stale running export (tenant A''s does not leak)');
end $$;
-- anon cannot call anything
reset role;
do $$ begin
  if has_function_privilege('anon', 'app.health_summary()', 'execute') or has_function_privilege('anon', 'app.recovery_status()', 'execute')
     or has_function_privilege('anon', 'app.record_recovery_drill(date,text,text,integer,integer,text,text)', 'execute')
     or has_function_privilege('public', 'app.health_summary()', 'execute') or has_table_privilege('anon', 'public.recovery_drills', 'select')
     or has_table_privilege('authenticated', 'public.recovery_drills', 'insert') or has_function_privilege('authenticated', 'app.tg_recovery_drills_append_only()', 'execute') then
    raise exception 'FAIL grants'; end if;
  raise notice 'PASS: grants';
end $$;
set local role authenticated;

-- ===== Recovery drills =====
select pg_temp.claims('c9f00000-0000-4000-8000-000000000021', 'c9f00000-0000-4000-8000-000000000001');
do $$ declare s jsonb; begin
  s := app.recovery_status();
  perform pg_temp.ok((s ->> 'drills_recorded')::int = 0 and s -> 'last_drill_date' = 'null'::jsonb and s -> 'last_passed_date' = 'null'::jsonb, 'with no drill on record the status says so (recovery is not proven)');
  perform pg_temp.expect($q$select app.record_recovery_drill(current_date, 'passed', 'disposable_project', 30, 120, 'ok', 'ticket-1')$q$, '42501', 'a business owner cannot record a platform restore drill');
end $$;
select pg_temp.claims('c9f00000-0000-4000-8000-000000000024', 'c9f00000-0000-4000-8000-000000000001', true);
do $$
declare v_id uuid; s jsonb;
begin
  perform pg_temp.expect($q$select app.record_recovery_drill(current_date + 1, 'passed', 'disposable_project', 1, 1, null, null)$q$, '22023', 'a drill dated in the future is rejected');
  perform pg_temp.expect($q$select app.record_recovery_drill(current_date, 'proven', 'disposable_project', 1, 1, null, null)$q$, '22023', 'unknown outcome rejected');
  perform pg_temp.expect($q$select app.record_recovery_drill(current_date, 'passed', 'production', 1, 1, null, null)$q$, '22023', 'a drill may not claim to have restored over production');
  perform pg_temp.expect($q$select app.record_recovery_drill(current_date, 'passed', 'disposable_project', -1, 1, null, null)$q$, '22023', 'negative RPO rejected');
  perform pg_temp.expect($q$select app.record_recovery_drill(current_date, 'passed', 'disposable_project', 1, 1, 'restored with postgresql://admin:hunter2@db.example/postgres', null)$q$, '22023', 'a connection string in notes is refused');
  perform pg_temp.expect($q$select app.record_recovery_drill(current_date, 'passed', 'disposable_project', 1, 1, null, 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc')$q$, '22023', 'a bearer token in the evidence reference is refused');
  perform pg_temp.expect($q$select app.record_recovery_drill(current_date, 'passed', 'disposable_project', 1, 1, 'password: abc', null)$q$, '22023', 'a password in notes is refused');
  v_id := app.record_recovery_drill(current_date - 3, 'failed', 'disposable_project', null, null, 'restore timed out', 'runbook step 4');
  v_id := app.record_recovery_drill(current_date - 1, 'passed', 'disposable_project', 15, 90, 'full restore to a disposable project', 'drill notes doc');
  s := app.recovery_status();
  perform pg_temp.ok((s ->> 'drills_recorded')::int = 2 and s ->> 'last_outcome' = 'passed' and s #>> '{detail,evidence_ref}' = 'drill notes doc' and (s #>> '{detail,rto_minutes}')::int = 90, 'platform owner sees full detail of the latest drill');
  perform pg_temp.ok((select count(*) from public.recovery_drills) = 2, 'platform owner reads the drill history');
end $$;
select pg_temp.claims('c9f00000-0000-4000-8000-000000000021', 'c9f00000-0000-4000-8000-000000000001');
do $$ declare s jsonb; begin
  s := app.recovery_status();
  perform pg_temp.ok(s ->> 'last_outcome' = 'passed' and s ->> 'last_passed_date' is not null, 'business owner sees the date and outcome of the last drill');
  perform pg_temp.ok(s -> 'detail' = 'null'::jsonb and s::text !~* '(drill notes|disposable|runbook|restore timed)', 'but none of the platform notes, evidence or targets (tenant redaction)');
  perform pg_temp.ok((select count(*) from public.recovery_drills) = 0, 'and a business owner cannot read the drill rows directly even though two exist');
end $$;

-- Drills are append-only for everyone, including the table owner.
reset role;
do $$ begin
  begin update public.recovery_drills set outcome = 'passed'; raise exception 'FAIL update allowed';
  exception when restrict_violation then raise notice 'PASS: drills cannot be edited'; end;
  begin delete from public.recovery_drills; raise exception 'FAIL delete allowed';
  exception when restrict_violation then raise notice 'PASS: drills cannot be deleted'; end;
end $$;

-- Platform owner: extra platform-wide counts, still counts only.
set local role authenticated;
select pg_temp.claims('c9f00000-0000-4000-8000-000000000024', 'c9f00000-0000-4000-8000-000000000001', true);
do $$ declare h jsonb; begin
  h := app.health_summary();
  perform pg_temp.ok((h #>> '{platform,pending_capacity_requests}')::int = 2 and (h #>> '{platform,failed_exports_30d}')::int = 3 and (h #>> '{platform,problem_cleanup_runs_30d}')::int = 2, 'platform owner gets platform-wide counts');
  perform pg_temp.ok(h::text !~* '(other tenant|RAW PROVIDER|health-b|Health B)', 'platform counts carry no tenant names or raw text');
end $$;
rollback;
