-- Platform-owner WhatsApp setup toggle: no credential, sender or webhook is introduced.
\set ON_ERROR_STOP on
create or replace function pg_temp.act_as(u text) returns void language plpgsql as $$
begin perform set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, true); end $$;
create or replace function pg_temp.check(p_ok boolean, p_label text) returns void language plpgsql as $$
begin if p_ok is not true then raise exception 'FAIL: %', p_label; end if; raise notice 'PASS: %', p_label; end $$;
create or replace function pg_temp.expect(p_sql text, p_state text, p_label text) returns void language plpgsql as $$
begin begin execute p_sql; exception when others then if sqlstate = p_state then raise notice 'PASS: %', p_label; return; end if; raise exception 'FAIL: %', p_label; end; raise exception 'FAIL: %', p_label; end $$;

begin;
insert into auth.users (id, email, raw_user_meta_data) values
  ('e6000000-0000-4000-8000-000000000001', 'wbudiman1995@gmail.com', '{}'),
  ('e6000000-0000-4000-8000-000000000002', 'not-platform@example.test', '{}');
update public.users set status = 'active', is_platform_admin = true where id = 'e6000000-0000-4000-8000-000000000001';
update public.users set status = 'active', is_platform_admin = false where id = 'e6000000-0000-4000-8000-000000000002';

set local role authenticated;
select pg_temp.act_as('e6000000-0000-4000-8000-000000000002');
select pg_temp.expect($q$select app.set_whatsapp_provider_platform_gate(true)$q$, '42501', 'a non-platform user cannot change the provider setup gate');
select pg_temp.expect($q$select * from app.whatsapp_provider_platform_gate()$q$, '42501', 'a non-platform user cannot read the provider setup gate');

select pg_temp.act_as('e6000000-0000-4000-8000-000000000001');
do $$
declare g record;
begin
  select * into g from app.whatsapp_provider_platform_gate();
  perform pg_temp.check(g.enabled is false, 'the provider setup gate starts closed');
  perform pg_temp.check(app.set_whatsapp_provider_platform_gate(true), 'the platform owner can open provider setup');
  perform pg_temp.check(app.whatsapp_provider_available() is true, 'opening the gate makes organization setup available');
  perform pg_temp.check((select note from app.whatsapp_provider_platform_gate()) like '%does not send messages%', 'the saved note explains that this is not a sender');
  perform pg_temp.check(app.set_whatsapp_provider_platform_gate(false) is false, 'the platform owner can close provider setup again immediately');
  perform pg_temp.check(app.whatsapp_provider_available() is false, 'closing the gate takes effect immediately');
end $$;
reset role;
do $$
declare f text; cfg text[]; sec boolean;
begin
  foreach f in array array['whatsapp_provider_platform_gate','set_whatsapp_provider_platform_gate'] loop
    select p.prosecdef, p.proconfig into sec, cfg from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'app' and p.proname = f;
    perform pg_temp.check(sec and cfg && array['search_path=""', 'search_path='], f || ' is SECURITY DEFINER with empty search_path');
    perform pg_temp.check(not has_function_privilege('anon', 'app.' || f || case when f = 'set_whatsapp_provider_platform_gate' then '(boolean)' else '()' end, 'execute'), f || ' is not executable by anon');
  end loop;
  perform pg_temp.check(app.schema_version() >= '20261101170000', 'schema version includes the platform toggle');
end $$;
rollback;
