-- Stream 5 business defaults: validation, normalization, concurrency, authorization, RLS, audit, grants.
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/20261101140000_test_business_defaults.sql
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
  ('e6000000-0000-4000-8000-000000000001', 'Def A', 'def-a-test', 'active'),
  ('e6000000-0000-4000-8000-000000000002', 'Def B', 'def-b-test', 'active');
insert into public.subscriptions (organization_id, status, current_period_start, current_period_end)
  select o, 'active', now() - interval '1 day', now() + interval '1 year'
  from (values ('e6000000-0000-4000-8000-000000000001'::uuid), ('e6000000-0000-4000-8000-000000000002'::uuid)) t(o);
insert into public.organization_modules (organization_id, module_id, enabled, source)
  select o, m.id, true, 'override' from public.modules m,
  (values ('e6000000-0000-4000-8000-000000000001'::uuid), ('e6000000-0000-4000-8000-000000000002'::uuid)) t(o);
insert into public.roles (id, organization_id, name) values
  ('e6000000-0000-4000-8000-000000000011', 'e6000000-0000-4000-8000-000000000001', 'Pemilik'),
  ('e6000000-0000-4000-8000-000000000012', 'e6000000-0000-4000-8000-000000000001', 'Manager'),
  ('e6000000-0000-4000-8000-000000000013', 'e6000000-0000-4000-8000-000000000001', 'Reader'),
  ('e6000000-0000-4000-8000-000000000014', 'e6000000-0000-4000-8000-000000000002', 'Pemilik');
insert into public.role_permissions (organization_id, role_id, permission_id)
  select 'e6000000-0000-4000-8000-000000000001', 'e6000000-0000-4000-8000-000000000012', id from public.permissions where key in ('settings.manage');
insert into public.role_permissions (organization_id, role_id, permission_id)
  select 'e6000000-0000-4000-8000-000000000001', 'e6000000-0000-4000-8000-000000000013', id from public.permissions where key in ('customer.read','finance.read');
insert into auth.users (id, email, raw_user_meta_data) values
  ('e6000000-0000-4000-8000-000000000021', 'owner@def.test', '{}'),
  ('e6000000-0000-4000-8000-000000000022', 'mgr@def.test', '{}'),
  ('e6000000-0000-4000-8000-000000000023', 'reader@def.test', '{}'),
  ('e6000000-0000-4000-8000-000000000024', 'owner-b@def.test', '{}'),
  ('e6000000-0000-4000-8000-000000000025', 'outsider@def.test', '{}');
update public.users set status = 'active' where id::text like 'e6000000-%';
insert into public.memberships (id, user_id, organization_id, role_id, status) values
  ('e6000000-0000-4000-8000-0000000000f1', 'e6000000-0000-4000-8000-000000000021', 'e6000000-0000-4000-8000-000000000001', 'e6000000-0000-4000-8000-000000000011', 'active'),
  ('e6000000-0000-4000-8000-0000000000f2', 'e6000000-0000-4000-8000-000000000022', 'e6000000-0000-4000-8000-000000000001', 'e6000000-0000-4000-8000-000000000012', 'active'),
  ('e6000000-0000-4000-8000-0000000000f3', 'e6000000-0000-4000-8000-000000000023', 'e6000000-0000-4000-8000-000000000001', 'e6000000-0000-4000-8000-000000000013', 'active'),
  ('e6000000-0000-4000-8000-0000000000f4', 'e6000000-0000-4000-8000-000000000024', 'e6000000-0000-4000-8000-000000000002', 'e6000000-0000-4000-8000-000000000014', 'active');

set local role authenticated;

-- ===== Owner =================================================================================================================
select pg_temp.act_as('e6000000-0000-4000-8000-000000000021', 'e6000000-0000-4000-8000-000000000001');
do $$
declare v integer; d record;
begin
  perform pg_temp.check((select count(*) from public.organization_business_defaults) = 0, 'a new organization has no defaults row (the application falls back to today''s behavior)');
  v := app.set_business_defaults(array['Instagram', '  Teman   dekat ', '', 'Google'], 7, 0);
  perform pg_temp.check(v = 1, 'the first write returns version 1');
  select * into d from public.organization_business_defaults;
  perform pg_temp.check(d.source_labels = array['Instagram', 'Teman dekat', 'Google'], 'labels are trimmed, spaces collapsed, empty ones dropped, order kept');
  perform pg_temp.check(d.invoice_due_days = 7, 'the due period is stored');
  perform pg_temp.check(d.id is not null and d.version = 1, 'the row has a uuid id (for the archive) and a version');
  perform pg_temp.expect($q$select app.set_business_defaults(array['x'], 7, 0)$q$, '40001', 'a stale version is refused (someone else saved)');
  v := app.set_business_defaults(array['Instagram', 'Google'], null, 1);
  perform pg_temp.check(v = 2 and (select invoice_due_days from public.organization_business_defaults) is null, 'a later write bumps the version; null due days means the studio default');
  v := app.set_business_defaults(array[]::text[], 0, 2);
  perform pg_temp.check(v = 3 and (select invoice_due_days from public.organization_business_defaults) = 0 and cardinality((select source_labels from public.organization_business_defaults)) = 0, 'zero days (due the same day) and an empty label list are valid');
  v := app.set_business_defaults(array['A'], 365, 3);
  perform pg_temp.check(v = 4, '365 days is the upper bound and one-character labels are allowed');
  perform pg_temp.expect($q$select app.set_business_defaults(array['A'], 366, 4)$q$, '22023', 'more than 365 days is refused');
  perform pg_temp.expect($q$select app.set_business_defaults(array['A'], -1, 4)$q$, '22023', 'negative days are refused');
  perform pg_temp.expect($q$select app.set_business_defaults(array['Instagram', 'instagram '], 7, 4)$q$, '22023', 'labels that differ only by case or spacing are duplicates');
  perform pg_temp.expect($q$select app.set_business_defaults(array['A  b', 'a b'], 7, 4)$q$, '22023', 'also after collapsing spaces');
  perform pg_temp.expect($q$select app.set_business_defaults((select array_agg('L' || g) from generate_series(1, 21) g), 7, 4)$q$, '22023', 'more than 20 labels are refused');
  perform pg_temp.expect($q$select app.set_business_defaults(array[repeat('x', 41)], 7, 4)$q$, '22023', 'a label longer than 40 characters is refused');
  perform pg_temp.expect($q$select app.set_business_defaults(array[E'bad\x01'], 7, 4)$q$, '22023', 'a control character in a label is refused');
  perform pg_temp.expect($q$select app.set_business_defaults(null, 7, 4)$q$, '22023', 'a null list is refused');
  perform pg_temp.expect($q$select app.set_business_defaults(array['A'], 7, null)$q$, '22023', 'a null expected version is refused');
  perform pg_temp.expect($q$select app.set_business_defaults(array['A'], 7, -1)$q$, '22023', 'a negative expected version is refused');
  perform pg_temp.check((select version from public.organization_business_defaults) = 4, 'every refused write left the stored version alone');
  perform pg_temp.expect($q$insert into public.organization_business_defaults(organization_id) values ('e6000000-0000-4000-8000-000000000001')$q$, '42501', 'clients cannot write the table directly');
  perform pg_temp.expect($q$update public.organization_business_defaults set invoice_due_days = 1$q$, '42501', 'nor update it');
  perform pg_temp.expect($q$delete from public.organization_business_defaults$q$, '42501', 'nor delete it');
end $$;

-- ===== Others ================================================================================================================
select pg_temp.act_as('e6000000-0000-4000-8000-000000000022', 'e6000000-0000-4000-8000-000000000001');
do $$ declare v integer; begin
  perform pg_temp.check((select count(*) from public.organization_business_defaults) = 1, 'a member sees the defaults (forms pre-fill from them)');
  v := app.set_business_defaults(array['Instagram', 'Teman'], 14, 4);
  perform pg_temp.check(v = 5, 'a manager with settings.manage may change them');
end $$;
select pg_temp.act_as('e6000000-0000-4000-8000-000000000023', 'e6000000-0000-4000-8000-000000000001');
do $$ begin
  perform pg_temp.check((select invoice_due_days from public.organization_business_defaults) = 14, 'a read-only member reads the defaults');
  perform pg_temp.expect($q$select app.set_business_defaults(array['Hacked'], 1, 5)$q$, '42501', 'but cannot change them');
end $$;
select pg_temp.act_as('e6000000-0000-4000-8000-000000000025', 'e6000000-0000-4000-8000-000000000001');
do $$ begin
  perform pg_temp.check((select count(*) from public.organization_business_defaults) = 0, 'a user with no membership in the organization sees nothing');
  perform pg_temp.expect($q$select app.set_business_defaults(array['Hacked'], 1, 5)$q$, '42501', 'and cannot write');
end $$;
select pg_temp.act_as('e6000000-0000-4000-8000-000000000024', 'e6000000-0000-4000-8000-000000000002');
do $$ begin
  perform pg_temp.check((select count(*) from public.organization_business_defaults) = 0, 'tenant B sees none of tenant A''s defaults');
  perform pg_temp.check(app.set_business_defaults(array['Sendiri'], 3, 0) = 1, 'tenant B writes its own row at version 0');
end $$;
select pg_temp.act_as('e6000000-0000-4000-8000-000000000021', 'e6000000-0000-4000-8000-000000000002');
do $$ begin
  perform pg_temp.expect($q$select app.set_business_defaults(array['Forged'], 1, 0)$q$, '42501', 'forged active organization refused');
end $$;
select pg_temp.act_as('e6000000-0000-4000-8000-000000000021', 'e6000000-0000-4000-8000-000000000001');
do $$ begin
  perform pg_temp.check((select source_labels from public.organization_business_defaults) = array['Instagram', 'Teman'], 'tenant A''s row was not touched by tenant B');
end $$;

-- ===== Audit / grants ========================================================================================================
reset role;
do $$
declare v_def boolean; v_cfg text[];
begin
  perform pg_temp.check((select count(*) from app.audit_log where entity_table = 'organization_business_defaults' and organization_id = 'e6000000-0000-4000-8000-000000000001') >= 5, 'every change of tenant A''s defaults is audited');
  select p.prosecdef, p.proconfig into v_def, v_cfg from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'app' and p.proname = 'set_business_defaults';
  perform pg_temp.check(v_def and v_cfg && array['search_path=""', 'search_path='], 'set_business_defaults is SECURITY DEFINER with an empty search_path');
  perform pg_temp.check(not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
     where n.nspname = 'app' and p.proname in ('set_business_defaults','valid_source_labels') and (a.grantee = 0 or a.grantee = 'anon'::regrole)), 'anon and PUBLIC cannot execute the writer or the validator');
  perform pg_temp.check(has_function_privilege('authenticated', 'app.set_business_defaults(text[], integer, integer)', 'execute'), 'authenticated may call the writer');
  perform pg_temp.check(not has_function_privilege('authenticated', 'app.valid_source_labels(text[])', 'execute'), 'the validator is internal');
  perform pg_temp.check(not has_table_privilege('authenticated', 'public.organization_business_defaults', 'insert') and not has_table_privilege('authenticated', 'public.organization_business_defaults', 'update')
    and not has_table_privilege('anon', 'public.organization_business_defaults', 'select'), 'clients hold SELECT only; anon nothing');
  perform pg_temp.check((select relrowsecurity from pg_class where oid = 'public.organization_business_defaults'::regclass), 'RLS is enabled');
  perform pg_temp.expect($q$update public.organization_business_defaults set source_labels = array['A', 'a']$q$, '23514', 'the table itself refuses duplicate labels even for its owner');
  perform pg_temp.expect($q$update public.organization_business_defaults set invoice_due_days = 999$q$, '23514', 'and an out-of-range due period');
  perform pg_temp.check(exists (select 1 from app.organization_export_table_specs where table_name = 'organization_business_defaults'), 'the defaults are part of the organization archive');
  perform pg_temp.check(app.schema_version() >= '20261101140000', 'schema version moved to (or past) this migration');
end $$;
rollback;
