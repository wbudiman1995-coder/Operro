-- Stream 6 access readiness summary: counts, flags, platform-owner-only, no identity leakage, grants.
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/20261101150000_test_access_readiness.sql
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
-- Five organizations with different readiness problems (and one deleted one that must not appear).
insert into public.organizations (id, name, slug, status, deleted_at) values
  ('e7000000-0000-4000-8000-000000000001', 'Alpha Ready', 'alpha-ready-t', 'active', null),
  ('e7000000-0000-4000-8000-000000000002', 'Bravo Waiting', 'bravo-waiting-t', 'active', null),
  ('e7000000-0000-4000-8000-000000000003', 'Charlie Empty', 'charlie-empty-t', 'trial', null),
  ('e7000000-0000-4000-8000-000000000004', 'Delta Suspended', 'delta-suspended-t', 'suspended', null),
  ('e7000000-0000-4000-8000-000000000005', 'Echo Gone', 'echo-gone-t', 'active', now()),
  ('e7000000-0000-4000-8000-000000000006', 'Foxtrot Lapsed', 'foxtrot-lapsed-t', 'active', null);
insert into public.roles (id, organization_id, name) values
  ('e7000000-0000-4000-8000-000000000011', 'e7000000-0000-4000-8000-000000000001', 'Pemilik'),
  ('e7000000-0000-4000-8000-000000000012', 'e7000000-0000-4000-8000-000000000001', 'Admin'),
  ('e7000000-0000-4000-8000-000000000014', 'e7000000-0000-4000-8000-000000000004', 'Pemilik'),
  ('e7000000-0000-4000-8000-000000000016', 'e7000000-0000-4000-8000-000000000006', 'Pemilik');
insert into auth.users (id, email, raw_user_meta_data) values
  ('e7000000-0000-4000-8000-000000000021', 'owner-alpha@readiness.test', '{}'),
  ('e7000000-0000-4000-8000-000000000022', 'admin-alpha@readiness.test', '{}'),
  ('e7000000-0000-4000-8000-000000000023', 'suspended-alpha@readiness.test', '{}'),
  ('e7000000-0000-4000-8000-000000000024', 'owner-delta@readiness.test', '{}'),
  ('e7000000-0000-4000-8000-000000000025', 'wbudiman1995@gmail.com', '{}'),
  ('e7000000-0000-4000-8000-000000000026', 'lapsed-owner@readiness.test', '{}');
update public.users set status = 'active' where id::text like 'e7000000-%';
update public.users set is_platform_admin = true where id = 'e7000000-0000-4000-8000-000000000025';
insert into public.memberships (id, user_id, organization_id, role_id, status) values
  ('e7000000-0000-4000-8000-0000000000f1', 'e7000000-0000-4000-8000-000000000021', 'e7000000-0000-4000-8000-000000000001', 'e7000000-0000-4000-8000-000000000011', 'active'),
  ('e7000000-0000-4000-8000-0000000000f2', 'e7000000-0000-4000-8000-000000000022', 'e7000000-0000-4000-8000-000000000001', 'e7000000-0000-4000-8000-000000000012', 'active'),
  ('e7000000-0000-4000-8000-0000000000f3', 'e7000000-0000-4000-8000-000000000023', 'e7000000-0000-4000-8000-000000000001', 'e7000000-0000-4000-8000-000000000012', 'suspended'),
  ('e7000000-0000-4000-8000-0000000000f4', 'e7000000-0000-4000-8000-000000000024', 'e7000000-0000-4000-8000-000000000004', 'e7000000-0000-4000-8000-000000000014', 'active'),
  -- the same person is active in two organizations (a multi-organization case)
  ('e7000000-0000-4000-8000-0000000000f5', 'e7000000-0000-4000-8000-000000000021', 'e7000000-0000-4000-8000-000000000004', 'e7000000-0000-4000-8000-000000000014', 'active'),
  ('e7000000-0000-4000-8000-0000000000f6', 'e7000000-0000-4000-8000-000000000026', 'e7000000-0000-4000-8000-000000000006', 'e7000000-0000-4000-8000-000000000016', 'suspended');
-- invitations: alpha has one of each kind, bravo is waiting on a valid owner invitation, foxtrot's owner invitation lapsed
insert into public.platform_access_invitations (id, organization_id, email, role_name, token_hash, status, expires_at, created_by, accepted_at, accepted_by) values
  ('e7000000-0000-4000-8000-0000000000a1', 'e7000000-0000-4000-8000-000000000001', 'valid@readiness.test',   'Groomer', 'token-hash-secret-1', 'pending',  now() + interval '3 days', 'e7000000-0000-4000-8000-000000000025', null, null),
  ('e7000000-0000-4000-8000-0000000000a2', 'e7000000-0000-4000-8000-000000000001', 'expired@readiness.test', 'Groomer', 'token-hash-secret-2', 'pending',  now() - interval '1 day',  'e7000000-0000-4000-8000-000000000025', null, null),
  ('e7000000-0000-4000-8000-0000000000a3', 'e7000000-0000-4000-8000-000000000001', 'used@readiness.test',    'Admin',   'token-hash-secret-3', 'accepted', now() + interval '3 days', 'e7000000-0000-4000-8000-000000000025', now(), 'e7000000-0000-4000-8000-000000000022'),
  ('e7000000-0000-4000-8000-0000000000a4', 'e7000000-0000-4000-8000-000000000001', 'revoked@readiness.test', 'Admin',   'token-hash-secret-4', 'revoked',  now() + interval '3 days', 'e7000000-0000-4000-8000-000000000025', null, null),
  ('e7000000-0000-4000-8000-0000000000a5', 'e7000000-0000-4000-8000-000000000002', 'owner-wait@readiness.test', 'Pemilik', 'token-hash-secret-5', 'pending', now() + interval '5 days', 'e7000000-0000-4000-8000-000000000025', null, null),
  ('e7000000-0000-4000-8000-0000000000a6', 'e7000000-0000-4000-8000-000000000006', 'owner-lapsed@readiness.test', 'Pemilik', 'token-hash-secret-6', 'pending', now() - interval '2 days', 'e7000000-0000-4000-8000-000000000025', null, null),
  ('e7000000-0000-4000-8000-0000000000a7', 'e7000000-0000-4000-8000-000000000005', 'gone@readiness.test', 'Pemilik', 'token-hash-secret-7', 'pending', now() + interval '5 days', 'e7000000-0000-4000-8000-000000000025', null, null);

-- ===== The hosted-staging post-condition script (docs/runbooks/staging_access_checks.sql) flags exactly what is wrong here =============
-- psql runs the file client-side (so this works from the repository root, in CI and in a container alike) and keeps the result.
\set qc `cat docs/runbooks/staging_access_checks.sql`
create temp table qc_result as :qc
do $$
declare r record;
begin
  perform pg_temp.check((select count(*) from qc_result) >= 10, 'the script returns its checks');
  perform pg_temp.check((select ok from qc_result where check_name = 'invitation tokens stored as sha-256 hashes only') is false, 'it flags tokens that are not sha-256 hashes (the fixture uses readable placeholders)');
  perform pg_temp.check((select ok from qc_result where check_name = 'every invitation expires exactly seven days after it was issued') is false, 'it flags invitations that do not live seven days');
  perform pg_temp.check((select ok from qc_result where check_name = 'every trial or active workspace has an active owner or a waiting owner invitation') is false, 'it flags workspaces nobody can enter (Charlie and Foxtrot) but not Bravo, whose owner invitation is waiting');
  perform pg_temp.check((select ok from qc_result where check_name = 'at most one pending invitation per address and organization') is true, 'it passes the checks that hold');
  perform pg_temp.check((select ok from qc_result where check_name = 'accepted invitations match an active-or-suspended membership with the invited role') is true, 'an accepted invitation with its membership passes');
  perform pg_temp.check((select ok from qc_result where check_name = 'no Admin role holds roles.manage or users.manage') is true and (select ok from qc_result where check_name = 'no pending invitation for a suspended workspace') is true, 'Admin permissions and suspended-workspace checks pass');
  perform pg_temp.check((select detail from qc_result where check_name = 'information: people active in more than one organization')::int >= 1, 'the multi-organization person is reported');
  perform pg_temp.check(not exists (select 1 from qc_result where detail ~* '@|token-hash-secret'), 'the script reveals no e-mail address or token');
  perform pg_temp.check((select ok from qc_result order by (ok is not distinct from false) desc, check_name limit 1) is false, 'findings sort first');
end $$;

set local role authenticated;

-- ===== Platform owner ===========================================================================================================
select pg_temp.act_as('e7000000-0000-4000-8000-000000000025', 'e7000000-0000-4000-8000-000000000001');
do $$
declare s jsonb; o jsonb; t jsonb;
begin
  s := app.access_readiness_summary();
  t := s -> 'totals';
  perform pg_temp.check(s ? 'generated_at' and (s ->> 'truncated')::boolean is false, 'the summary is stamped and not truncated');
  perform pg_temp.check(not exists (select 1 from jsonb_array_elements(s -> 'organizations') x where x ->> 'slug' = 'echo-gone-t'), 'a deleted organization is not listed');
  perform pg_temp.check((select min(x ->> 'name') from jsonb_array_elements(s -> 'organizations') x) = 'Alpha Ready' and (select count(*) from jsonb_array_elements(s -> 'organizations') x where x ->> 'slug' like '%-t') = 5, 'the five live test organizations are listed, ordered by name');

  select x into o from jsonb_array_elements(s -> 'organizations') x where x ->> 'slug' = 'alpha-ready-t';
  perform pg_temp.check((o ->> 'active_members')::int = 2 and (o ->> 'suspended_members')::int = 1 and (o ->> 'active_owners')::int = 1, 'alpha: two active members (one an owner) and one suspended');
  perform pg_temp.check((o ->> 'pending_invitations')::int = 1 and (o ->> 'expired_pending_invitations')::int = 1 and (o ->> 'accepted_invitations')::int = 1 and (o ->> 'revoked_invitations')::int = 1, 'alpha: one invitation of each state');
  perform pg_temp.check(o -> 'flags' = '["expired_pending_invitations"]'::jsonb, 'alpha is ready apart from an expired unclaimed invitation');

  select x into o from jsonb_array_elements(s -> 'organizations') x where x ->> 'slug' = 'bravo-waiting-t';
  perform pg_temp.check(o -> 'flags' = '["no_active_owner", "owner_invitation_pending"]'::jsonb, 'bravo: no owner yet but a valid owner invitation is waiting');
  select x into o from jsonb_array_elements(s -> 'organizations') x where x ->> 'slug' = 'charlie-empty-t';
  perform pg_temp.check(o -> 'flags' = '["no_active_owner", "no_owner_invitation"]'::jsonb, 'charlie: a trial workspace nobody can enter and nobody was invited to');
  select x into o from jsonb_array_elements(s -> 'organizations') x where x ->> 'slug' = 'delta-suspended-t';
  perform pg_temp.check(o -> 'flags' = '["suspended_workspace"]'::jsonb and (o ->> 'active_owners')::int = 2, 'delta: suspended (its owner count is still shown); no owner flag for a suspended workspace');
  select x into o from jsonb_array_elements(s -> 'organizations') x where x ->> 'slug' = 'foxtrot-lapsed-t';
  perform pg_temp.check(o -> 'flags' = '["no_active_owner", "owner_invitation_expired", "expired_pending_invitations"]'::jsonb and (o ->> 'suspended_members')::int = 1, 'foxtrot: its only owner membership is suspended and the owner invitation lapsed');

  perform pg_temp.check((t ->> 'organizations')::int >= 5 and (t ->> 'suspended_workspaces')::int >= 1, 'totals count live organizations and suspended workspaces');
  perform pg_temp.check((t ->> 'without_active_owner')::int >= 3, 'totals count trial/active workspaces without an active owner (bravo, charlie, foxtrot)');
  perform pg_temp.check((t ->> 'pending_invitations')::int >= 2 and (t ->> 'expired_pending_invitations')::int >= 2, 'totals count valid and expired pending invitations (including the deleted organization''s valid one)');
  perform pg_temp.check((t ->> 'people_in_several_organizations')::int >= 1, 'a person active in two organizations is counted once, as a multi-organization case');
end $$;

-- ===== No identity leaves the function ========================================================================================
do $$
declare txt text := app.access_readiness_summary()::text;
begin
  perform pg_temp.check(txt !~ '@', 'no e-mail address appears anywhere in the summary');
  perform pg_temp.check(txt !~* 'token|hash|secret', 'no token or hash appears');
  perform pg_temp.check(not exists (
      select 1 from jsonb_array_elements(app.access_readiness_summary() -> 'organizations') x, jsonb_object_keys(x) k
       where k not in ('organization_id','name','slug','status','active_members','suspended_members','active_owners','pending_invitations','expired_pending_invitations','accepted_invitations','revoked_invitations','flags')),
    'each organization row carries only the documented keys');
  perform pg_temp.check(txt !~ 'e7000000-0000-4000-8000-0000000000(f|2|a)', 'no membership, user or invitation id appears');
end $$;

-- ===== Everyone else is refused ===============================================================================================
select pg_temp.act_as('e7000000-0000-4000-8000-000000000021', 'e7000000-0000-4000-8000-000000000001');
do $$ begin
  perform pg_temp.expect($q$select app.access_readiness_summary()$q$, '42501', 'a business owner cannot read the platform summary');
end $$;
select pg_temp.act_as('e7000000-0000-4000-8000-000000000022', 'e7000000-0000-4000-8000-000000000001');
do $$ begin
  perform pg_temp.expect($q$select app.access_readiness_summary()$q$, '42501', 'a tenant Admin cannot either');
end $$;
select pg_temp.act_as('e7000000-0000-4000-8000-000000000099', 'e7000000-0000-4000-8000-000000000001');
do $$ begin
  perform pg_temp.expect($q$select app.access_readiness_summary()$q$, '42501', 'an unknown user is refused');
end $$;
reset role;

-- ===== Grants / structure ===========================================================================================================
do $$
declare v_def boolean; v_cfg text[];
begin
  select p.prosecdef, p.proconfig into v_def, v_cfg from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'app' and p.proname = 'access_readiness_summary';
  perform pg_temp.check(v_def and v_cfg && array['search_path=""', 'search_path='], 'access_readiness_summary is SECURITY DEFINER with an empty search_path');
  perform pg_temp.check(not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
     where n.nspname = 'app' and p.proname = 'access_readiness_summary' and (a.grantee = 0 or a.grantee = 'anon'::regrole)), 'anon and PUBLIC cannot execute it');
  perform pg_temp.check(has_function_privilege('authenticated', 'app.access_readiness_summary()', 'execute'), 'authenticated may call it (the function itself checks the platform owner)');
  perform pg_temp.check(app.schema_version() >= '20261101150000', 'schema version moved to (or past) this migration');
end $$;
rollback;
