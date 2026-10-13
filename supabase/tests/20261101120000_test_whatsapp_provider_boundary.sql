-- Stream 3 WhatsApp provider boundary: disabled by default, platform gate, owner-only settings, concurrency, RLS, grants.
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/20261101120000_test_whatsapp_provider_boundary.sql
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
  ('e5000000-0000-4000-8000-000000000001', 'WA A', 'wa-a-test', 'active'),
  ('e5000000-0000-4000-8000-000000000002', 'WA B', 'wa-b-test', 'active');
insert into public.subscriptions (organization_id, status, current_period_start, current_period_end)
  select o, 'active', now() - interval '1 day', now() + interval '1 year'
  from (values ('e5000000-0000-4000-8000-000000000001'::uuid), ('e5000000-0000-4000-8000-000000000002'::uuid)) t(o);
insert into public.organization_modules (organization_id, module_id, enabled, source)
  select o, m.id, true, 'override' from public.modules m,
  (values ('e5000000-0000-4000-8000-000000000001'::uuid), ('e5000000-0000-4000-8000-000000000002'::uuid)) t(o);
insert into public.roles (id, organization_id, name) values
  ('e5000000-0000-4000-8000-000000000011', 'e5000000-0000-4000-8000-000000000001', 'Pemilik'),
  ('e5000000-0000-4000-8000-000000000012', 'e5000000-0000-4000-8000-000000000001', 'Admin'),
  ('e5000000-0000-4000-8000-000000000013', 'e5000000-0000-4000-8000-000000000002', 'Pemilik');
-- the Admin holds every permission that touches WhatsApp or settings and is still not the business owner
insert into public.role_permissions (organization_id, role_id, permission_id)
  select 'e5000000-0000-4000-8000-000000000001', 'e5000000-0000-4000-8000-000000000012', id from public.permissions
   where key in ('settings.manage','customer.read','customer.manage','finance.read','finance.manage','branches.all');
insert into auth.users (id, email, raw_user_meta_data) values
  ('e5000000-0000-4000-8000-000000000021', 'owner@wa.test', '{}'),
  ('e5000000-0000-4000-8000-000000000022', 'admin@wa.test', '{}'),
  ('e5000000-0000-4000-8000-000000000023', 'owner-b@wa.test', '{}');
update public.users set status = 'active' where id::text like 'e5000000-%';
insert into public.memberships (id, user_id, organization_id, role_id, status) values
  ('e5000000-0000-4000-8000-0000000000f1', 'e5000000-0000-4000-8000-000000000021', 'e5000000-0000-4000-8000-000000000001', 'e5000000-0000-4000-8000-000000000011', 'active'),
  ('e5000000-0000-4000-8000-0000000000f2', 'e5000000-0000-4000-8000-000000000022', 'e5000000-0000-4000-8000-000000000001', 'e5000000-0000-4000-8000-000000000012', 'active'),
  ('e5000000-0000-4000-8000-0000000000f3', 'e5000000-0000-4000-8000-000000000023', 'e5000000-0000-4000-8000-000000000002', 'e5000000-0000-4000-8000-000000000013', 'active');

-- ===== The platform gate is seeded closed and nothing in the database opens it ========================================
do $$
begin
  perform pg_temp.check((select enabled from public.platform_flags where key = 'whatsapp_provider_available') is false, 'the platform flag is seeded FALSE');
  perform pg_temp.check(app.whatsapp_provider_available() is false, 'and the provider is therefore not available');
  perform pg_temp.check(not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'app' and p.prokind = 'f' and pg_get_functiondef(p.oid) ~* 'update\s+public\.platform_flags|insert\s+into\s+public\.platform_flags'),
    'no function in the app schema can change a platform flag');
end $$;

set local role authenticated;
create temp table ids (k text primary key, v integer);
grant all on ids to authenticated;

-- ===== Owner: record identifiers and consent, enabling refused ========================================================
select pg_temp.act_as('e5000000-0000-4000-8000-000000000021', 'e5000000-0000-4000-8000-000000000001');
do $$
declare s record; v integer; t1 timestamptz;
begin
  select * into s from app.whatsapp_provider_state();
  perform pg_temp.check(s.provider = 'none' and s.enabled is false and s.version = 0 and s.platform_available is false and s.consent_attested is false, 'an organization that never configured anything is off, version 0, platform gate closed');
  v := app.set_whatsapp_provider_settings('meta_cloud', ' 123456789012345 ', '9876543210', true, false, 0);
  perform pg_temp.check(v = 1, 'the first write returns version 1');
  select * into s from app.whatsapp_provider_state();
  perform pg_temp.check(s.provider = 'meta_cloud' and s.phone_number_id = '123456789012345' and s.business_account_id = '9876543210' and s.consent_attested and s.consent_attested_at is not null and s.enabled is false,
    'identifiers are trimmed and stored; the consent attestation is dated; still disabled');
  perform pg_temp.expect($q$select app.set_whatsapp_provider_settings('meta_cloud', '123456789012345', '9876543210', true, true, 1)$q$, '22023', 'enabling is refused while the platform has not made the provider available');
  perform pg_temp.check((select enabled from app.whatsapp_provider_state()) is false, 'and nothing was enabled');
  perform pg_temp.expect($q$select app.set_whatsapp_provider_settings('meta_cloud', '123456789012345', null, true, false, 0)$q$, '40001', 'a stale version is refused');
  t1 := (select consent_attested_at from app.whatsapp_provider_state());
  perform pg_sleep(0.05);
  v := app.set_whatsapp_provider_settings('meta_cloud', '123456789012345', '9876543210', true, false, 1);
  perform pg_temp.check(v = 2, 'a later write bumps the version');
  perform pg_temp.check((select consent_attested_at from app.whatsapp_provider_state()) = t1, 'consent keeps its first time when re-saved');
  v := app.set_whatsapp_provider_settings('meta_cloud', '123456789012345', '9876543210', false, false, 2);
  perform pg_temp.check((select consent_attested from app.whatsapp_provider_state()) is false and (select consent_attested_at from app.whatsapp_provider_state()) is null, 'withdrawing the attestation clears it');
  perform pg_temp.expect($q$select app.set_whatsapp_provider_settings('none', '123456789012345', null, false, false, 3)$q$, '22023', 'provider none cannot carry identifiers');
  perform pg_temp.expect($q$select app.set_whatsapp_provider_settings('twilio', null, null, false, false, 3)$q$, '22023', 'an unknown provider is refused');
  perform pg_temp.expect($q$select app.set_whatsapp_provider_settings('meta_cloud', 'EAAB-token-like-text', null, false, false, 3)$q$, '22023', 'a non-numeric identifier (anything token-like) is refused');
  perform pg_temp.expect($q$select app.set_whatsapp_provider_settings('meta_cloud', '12', null, false, false, 3)$q$, '22023', 'an identifier that is too short is refused');
  perform pg_temp.expect($q$select app.set_whatsapp_provider_settings('meta_cloud', null, null, null, false, 3)$q$, '22023', 'a null attestation is refused');
  perform pg_temp.expect($q$select app.set_whatsapp_provider_settings('none', null, null, false, false, null)$q$, '22023', 'a null expected version is refused');
  perform pg_temp.expect($q$select * from public.whatsapp_provider_settings$q$, '42501', 'the settings table is not readable by clients');
  perform pg_temp.expect($q$update public.whatsapp_provider_settings set enabled = true$q$, '42501', 'nor writable');
  perform pg_temp.expect($q$select * from public.platform_flags where key = 'x' for update$q$, '42501', 'the flag table is not writable by clients');
  perform pg_temp.check((select count(*) from public.platform_flags) = 0, 'a business owner cannot read the platform flags');
end $$;

-- ===== Everyone else ========================================================================================================
select pg_temp.act_as('e5000000-0000-4000-8000-000000000022', 'e5000000-0000-4000-8000-000000000001');
do $$ begin
  perform pg_temp.expect($q$select * from app.whatsapp_provider_state()$q$, '42501', 'an Admin with every settings permission is not the business owner: state refused');
  perform pg_temp.expect($q$select app.set_whatsapp_provider_settings('none', null, null, false, false, 2)$q$, '42501', 'and cannot write');
end $$;
select pg_temp.act_as('e5000000-0000-4000-8000-000000000023', 'e5000000-0000-4000-8000-000000000002');
do $$
declare s record;
begin
  select * into s from app.whatsapp_provider_state();
  perform pg_temp.check(s.provider = 'none' and s.phone_number_id is null and s.version = 0, 'tenant B sees its own empty state, not tenant A''s identifiers');
  perform pg_temp.check(app.set_whatsapp_provider_settings('meta_cloud', '55555555', null, false, false, 0) = 1, 'tenant B writes its own row');
end $$;
select pg_temp.act_as('e5000000-0000-4000-8000-000000000021', 'e5000000-0000-4000-8000-000000000002');
do $$ begin
  perform pg_temp.expect($q$select * from app.whatsapp_provider_state()$q$, '42501', 'forged active organization refused');
end $$;

-- ===== Even a row marked enabled is reported disabled while the platform gate is closed ================================
reset role;
do $$
declare s record;
begin
  -- a constraint-satisfying row an operator could have written; the state function must still say disabled
  update public.whatsapp_provider_settings set enabled = true, provider = 'meta_cloud', phone_number_id = '123456789012345', consent_attested = true, consent_attested_at = now()
   where organization_id = 'e5000000-0000-4000-8000-000000000001';
  perform set_config('request.jwt.claims', json_build_object('sub', 'e5000000-0000-4000-8000-000000000021', 'role', 'authenticated', 'active_org_id', 'e5000000-0000-4000-8000-000000000001')::text, true);
  set local role authenticated;
  select * into s from app.whatsapp_provider_state();
  perform pg_temp.check(s.enabled is false, 'a stored enabled=true is reported false while the platform flag is false');
  reset role;
  perform pg_temp.expect($q$update public.whatsapp_provider_settings set enabled = true, provider = 'none' where organization_id = 'e5000000-0000-4000-8000-000000000001'$q$, '23514', 'the table constraint refuses enabled without a provider');
  perform pg_temp.expect($q$update public.whatsapp_provider_settings set enabled = true, consent_attested = false, consent_attested_at = null where organization_id = 'e5000000-0000-4000-8000-000000000001'$q$, '23514', 'or without the consent attestation');
  perform pg_temp.expect($q$update public.whatsapp_provider_settings set consent_attested = true, consent_attested_at = null where organization_id = 'e5000000-0000-4000-8000-000000000001'$q$, '23514', 'or a consent flag without its date');
end $$;

-- ===== Grants / structure ===================================================================================================
do $$
declare f text; v_def boolean; v_cfg text[];
begin
  perform pg_temp.check((select count(*) from app.audit_log where entity_table = 'whatsapp_provider_settings') >= 5, 'every settings change is audited');
  foreach f in array array['whatsapp_provider_available','set_whatsapp_provider_settings','whatsapp_provider_state'] loop
    select p.prosecdef, p.proconfig into v_def, v_cfg from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'app' and p.proname = f;
    perform pg_temp.check(v_def and v_cfg && array['search_path=""', 'search_path='], f || ' is SECURITY DEFINER with an empty search_path');
  end loop;
  perform pg_temp.check(not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
     where n.nspname = 'app' and p.proname in ('whatsapp_provider_available','set_whatsapp_provider_settings','whatsapp_provider_state')
       and (a.grantee = 0 or a.grantee = 'anon'::regrole)), 'anon and PUBLIC cannot execute any provider function');
  perform pg_temp.check(not has_function_privilege('authenticated', 'app.whatsapp_provider_available()', 'execute'), 'the platform-gate reader is internal');
  perform pg_temp.check(not has_table_privilege('authenticated', 'public.whatsapp_provider_settings', 'select') and not has_table_privilege('authenticated', 'public.whatsapp_provider_settings', 'insert')
    and not has_table_privilege('anon', 'public.platform_flags', 'select') and not has_table_privilege('authenticated', 'public.platform_flags', 'update'), 'no client privilege on the settings table; anon nothing; no client write on flags');
  perform pg_temp.check((select relrowsecurity from pg_class where oid = 'public.whatsapp_provider_settings'::regclass) and (select relrowsecurity from pg_class where oid = 'public.platform_flags'::regclass), 'RLS is enabled on both tables');
  perform pg_temp.check(app.schema_version() >= '20261101120000', 'schema version moved to (or past) this migration');
end $$;
rollback;
