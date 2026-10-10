-- E1.4 evidence-retention setting (owner-only) + personal landing default.
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/20261029120000_test_settings_and_preferences.sql
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

begin;
insert into public.organizations (id, name, slug, status, settings) values
  ('c3f00000-0000-4000-8000-000000000001', 'Pref A', 'pref-a-test', 'active', '{"documents":{"tagline":"hi"},"followup_retention":{"x":1}}'),
  ('c3f00000-0000-4000-8000-000000000002', 'Pref B', 'pref-b-test', 'active', '{}');
insert into public.subscriptions (organization_id, status, current_period_start, current_period_end)
  select o, 'active', now() - interval '1 day', now() + interval '1 year'
  from (values ('c3f00000-0000-4000-8000-000000000001'::uuid), ('c3f00000-0000-4000-8000-000000000002'::uuid)) t(o);
insert into public.organization_modules (organization_id, module_id, enabled, source)
  select o, m.id, true, 'override' from public.modules m,
  (values ('c3f00000-0000-4000-8000-000000000001'::uuid), ('c3f00000-0000-4000-8000-000000000002'::uuid)) t(o);
insert into public.roles (id, organization_id, name) values
  ('c3f00000-0000-4000-8000-000000000011', 'c3f00000-0000-4000-8000-000000000001', 'Pemilik'),
  ('c3f00000-0000-4000-8000-000000000012', 'c3f00000-0000-4000-8000-000000000001', 'Manager'),
  ('c3f00000-0000-4000-8000-000000000013', 'c3f00000-0000-4000-8000-000000000001', 'Staff'),
  ('c3f00000-0000-4000-8000-000000000014', 'c3f00000-0000-4000-8000-000000000002', 'Staff');
insert into public.role_permissions (organization_id, role_id, permission_id)
  select 'c3f00000-0000-4000-8000-000000000001', 'c3f00000-0000-4000-8000-000000000011', id from public.permissions;
insert into public.role_permissions (organization_id, role_id, permission_id)
  select 'c3f00000-0000-4000-8000-000000000001', 'c3f00000-0000-4000-8000-000000000012', id from public.permissions where key in ('settings.manage','booking.read');
insert into public.role_permissions (organization_id, role_id, permission_id)
  select 'c3f00000-0000-4000-8000-000000000001', 'c3f00000-0000-4000-8000-000000000013', id from public.permissions where key in ('booking.read','finance.read');
insert into public.role_permissions (organization_id, role_id, permission_id)
  select 'c3f00000-0000-4000-8000-000000000002', 'c3f00000-0000-4000-8000-000000000014', id from public.permissions where key in ('booking.read');
insert into auth.users (id, email, raw_user_meta_data) values
  ('c3f00000-0000-4000-8000-000000000021', 'owner@pref.test', '{}'),
  ('c3f00000-0000-4000-8000-000000000022', 'manager@pref.test', '{}'),
  ('c3f00000-0000-4000-8000-000000000023', 'staff@pref.test', '{}'),
  ('c3f00000-0000-4000-8000-000000000024', 'other@pref.test', '{}');
update public.users set status = 'active' where id::text like 'c3f00000-%';
insert into public.memberships (user_id, organization_id, role_id, status) values
  ('c3f00000-0000-4000-8000-000000000021', 'c3f00000-0000-4000-8000-000000000001', 'c3f00000-0000-4000-8000-000000000011', 'active'),
  ('c3f00000-0000-4000-8000-000000000022', 'c3f00000-0000-4000-8000-000000000001', 'c3f00000-0000-4000-8000-000000000012', 'active'),
  ('c3f00000-0000-4000-8000-000000000023', 'c3f00000-0000-4000-8000-000000000001', 'c3f00000-0000-4000-8000-000000000013', 'active'),
  ('c3f00000-0000-4000-8000-000000000023', 'c3f00000-0000-4000-8000-000000000002', 'c3f00000-0000-4000-8000-000000000014', 'active'),
  ('c3f00000-0000-4000-8000-000000000024', 'c3f00000-0000-4000-8000-000000000001', 'c3f00000-0000-4000-8000-000000000013', 'active');

set local role authenticated;
-- ===== Organization setting: owner-only, validated, sibling-preserving =====
select pg_temp.act_as('c3f00000-0000-4000-8000-000000000021', 'c3f00000-0000-4000-8000-000000000001');
do $$
declare v jsonb;
begin
  perform app.set_evidence_retention_days(90);
  select settings into v from public.organizations where id = 'c3f00000-0000-4000-8000-000000000001';
  if v ->> 'evidence_retention_days' <> '90' or v #>> '{documents,tagline}' <> 'hi' or v #>> '{followup_retention,x}' <> '1' then
    raise exception 'FAIL setting not stored/siblings lost: %', v; end if;
  perform app.set_evidence_retention_days(30);
  perform app.set_evidence_retention_days(1825);
  perform pg_temp.expect('select app.set_evidence_retention_days(29)', '22023', 'below minimum rejected');
  perform pg_temp.expect('select app.set_evidence_retention_days(1826)', '22023', 'above maximum rejected');
  perform pg_temp.expect('select app.set_evidence_retention_days(null)', '22023', 'null rejected');
  raise notice 'PASS: owner writes validated value, preserves sibling settings';
end $$;
select pg_temp.act_as('c3f00000-0000-4000-8000-000000000022', 'c3f00000-0000-4000-8000-000000000001');
do $$ begin
  perform pg_temp.expect('select app.set_evidence_retention_days(120)', '42501', 'settings.manage manager (not owner) cannot write');
end $$;
select pg_temp.act_as('c3f00000-0000-4000-8000-000000000023', 'c3f00000-0000-4000-8000-000000000002');
do $$ begin
  perform pg_temp.expect('select app.set_evidence_retention_days(120)', '42501', 'staff in another business cannot write');
end $$;
-- Forged organization claim by a non-member.
select pg_temp.act_as('c3f00000-0000-4000-8000-000000000024', 'c3f00000-0000-4000-8000-000000000002');
do $$ begin
  perform pg_temp.expect('select app.set_evidence_retention_days(120)', '42501', 'forged org claim by non-member refused');
  perform pg_temp.expect('select app.set_my_landing_page(''dashboard'')', '42501', 'non-member cannot set a preference');
end $$;

-- Malformed stored settings are repaired rather than crashing.
reset role;
update public.organizations set settings = '"oops"'::jsonb where id = 'c3f00000-0000-4000-8000-000000000002';
-- owner of B does not exist; use platform-style fixture: make staff@B an owner temporarily
update public.roles set name = 'Pemilik' where id = 'c3f00000-0000-4000-8000-000000000014';
set local role authenticated;
select pg_temp.act_as('c3f00000-0000-4000-8000-000000000023', 'c3f00000-0000-4000-8000-000000000002');
do $$ begin
  perform app.set_evidence_retention_days(45);
  if (select settings ->> 'evidence_retention_days' from public.organizations where id = 'c3f00000-0000-4000-8000-000000000002') <> '45' then
    raise exception 'FAIL malformed settings not normalised'; end if;
  raise notice 'PASS: malformed scalar settings normalised';
end $$;
reset role;
update public.roles set name = 'Staff' where id = 'c3f00000-0000-4000-8000-000000000014';
set local role authenticated;

-- ===== Personal default =====
select pg_temp.act_as('c3f00000-0000-4000-8000-000000000023', 'c3f00000-0000-4000-8000-000000000001');
do $$
begin
  if app.my_landing_page() <> 'dashboard' then raise exception 'FAIL default landing is not dashboard'; end if;
  perform app.set_my_landing_page('finance');
  if app.my_landing_page() <> 'finance' then raise exception 'FAIL saved landing not returned'; end if;
  perform app.set_my_landing_page('schedule');
  perform pg_temp.expect('select app.set_my_landing_page(''customers'')', '42501', 'cannot choose a page the role cannot open');
  perform pg_temp.expect('select app.set_my_landing_page(''/etc/passwd'')', '22023', 'arbitrary route rejected');
  perform pg_temp.expect('select app.set_my_landing_page(''https://evil.example'')', '22023', 'external URL rejected');
  perform pg_temp.expect('select app.set_my_landing_page('''')', '22023', 'empty string rejected (null clears)');
  perform app.set_my_landing_page('finance');
  raise notice 'PASS: valid choices stored; invalid/unpermitted refused';
end $$;

-- Same person, other business, no finance.read: saved value is not honoured there (tenant-specific fail-safe).
select pg_temp.act_as('c3f00000-0000-4000-8000-000000000023', 'c3f00000-0000-4000-8000-000000000002');
do $$ begin
  if app.my_landing_page() <> 'dashboard' then raise exception 'FAIL landing honoured in a business without the capability'; end if;
  raise notice 'PASS: saved landing falls back in a business that lacks the capability';
end $$;

-- Isolation between users: another user sees nothing and cannot change it.
select pg_temp.act_as('c3f00000-0000-4000-8000-000000000024', 'c3f00000-0000-4000-8000-000000000001');
do $$ begin
  if (select count(*) from public.user_preferences) <> 0 then raise exception 'FAIL user sees another user''s preference'; end if;
  if app.my_landing_page() <> 'dashboard' then raise exception 'FAIL other user inherits preference'; end if;
  perform pg_temp.expect('update public.user_preferences set landing_page = ''dashboard''', '42501', 'direct table update denied');
  perform pg_temp.expect('insert into public.user_preferences(user_id, landing_page) values (''c3f00000-0000-4000-8000-000000000023'', ''finance'')', '42501', 'direct insert denied');
  perform app.set_my_landing_page('schedule');
end $$;
select pg_temp.act_as('c3f00000-0000-4000-8000-000000000023', 'c3f00000-0000-4000-8000-000000000001');
do $$ begin
  if app.my_landing_page() <> 'finance' then raise exception 'FAIL one user''s write changed another user''s preference'; end if;
  if (select count(*) from public.user_preferences) <> 1 then raise exception 'FAIL own-row visibility'; end if;
  raise notice 'PASS: preferences are isolated per user';
end $$;

-- Revoked access: remove finance.read from the role -> falls back immediately; suspended membership -> falls back.
reset role;
delete from public.role_permissions where role_id = 'c3f00000-0000-4000-8000-000000000013'
  and permission_id = (select id from public.permissions where key = 'finance.read');
set local role authenticated;
select pg_temp.act_as('c3f00000-0000-4000-8000-000000000023', 'c3f00000-0000-4000-8000-000000000001');
do $$ begin
  if app.my_landing_page() <> 'dashboard' then raise exception 'FAIL revoked capability still honoured'; end if;
  perform pg_temp.expect('select app.set_my_landing_page(''finance'')', '42501', 'cannot re-pick a revoked page');
  perform app.set_my_landing_page(null);
  raise notice 'PASS: revoked capability falls back to dashboard; null clears';
end $$;
reset role;
update public.user_preferences set landing_page = 'schedule' where user_id = 'c3f00000-0000-4000-8000-000000000023';
update public.memberships set status = 'suspended' where user_id = 'c3f00000-0000-4000-8000-000000000023' and organization_id = 'c3f00000-0000-4000-8000-000000000001';
set local role authenticated;
select pg_temp.act_as('c3f00000-0000-4000-8000-000000000023', 'c3f00000-0000-4000-8000-000000000001');
do $$ begin
  if app.my_landing_page() <> 'dashboard' then raise exception 'FAIL suspended membership still honoured'; end if;
  raise notice 'PASS: suspended membership falls back';
end $$;

-- Malformed stored value cannot exist (constraint), and the grants are tight.
reset role;
do $$ begin
  begin
    insert into public.user_preferences(user_id, landing_page) values ('c3f00000-0000-4000-8000-000000000021', 'javascript:alert(1)');
    raise exception 'FAIL malformed value stored';
  exception when check_violation then raise notice 'PASS: malformed stored value impossible'; end;
  if has_function_privilege('anon', 'app.my_landing_page()', 'execute') or has_function_privilege('public', 'app.set_my_landing_page(text)', 'execute')
     or has_function_privilege('anon', 'app.set_evidence_retention_days(integer)', 'execute')
     or has_function_privilege('authenticated', 'app.landing_page_allowed(text)', 'execute')
     or has_table_privilege('authenticated', 'public.user_preferences', 'insert') or has_table_privilege('anon', 'public.user_preferences', 'select') then
    raise exception 'FAIL grants'; end if;
  raise notice 'PASS: grants';
end $$;
rollback;
