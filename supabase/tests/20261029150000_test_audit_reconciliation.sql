-- E2.4 audit viewer + read-only reconciliation.
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/20261029150000_test_audit_reconciliation.sql
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
insert into public.organizations (id, name, slug, status) values
  ('c6f00000-0000-4000-8000-000000000001', 'Rec A', 'rec-a-test', 'active'),
  ('c6f00000-0000-4000-8000-000000000002', 'Rec B', 'rec-b-test', 'active');
insert into public.subscriptions (organization_id, status, current_period_start, current_period_end)
  select o, 'active', now() - interval '1 day', now() + interval '1 year'
  from (values ('c6f00000-0000-4000-8000-000000000001'::uuid), ('c6f00000-0000-4000-8000-000000000002'::uuid)) t(o);
insert into public.organization_modules (organization_id, module_id, enabled, source)
  select o, m.id, true, 'override' from public.modules m,
  (values ('c6f00000-0000-4000-8000-000000000001'::uuid), ('c6f00000-0000-4000-8000-000000000002'::uuid)) t(o);
insert into public.branches (id, organization_id, name, is_default, status, timezone) values
  ('c6f00000-0000-4000-8000-0000000000e1', 'c6f00000-0000-4000-8000-000000000001', 'North', true, 'active', 'Asia/Jakarta'),
  ('c6f00000-0000-4000-8000-0000000000e3', 'c6f00000-0000-4000-8000-000000000001', 'South', false, 'active', 'Asia/Jakarta'),
  ('c6f00000-0000-4000-8000-0000000000e2', 'c6f00000-0000-4000-8000-000000000002', 'Main B', true, 'active', 'Asia/Jakarta');
insert into public.roles (id, organization_id, name) values
  ('c6f00000-0000-4000-8000-000000000011', 'c6f00000-0000-4000-8000-000000000001', 'Pemilik'),
  ('c6f00000-0000-4000-8000-000000000012', 'c6f00000-0000-4000-8000-000000000001', 'ReportsNorth'),
  ('c6f00000-0000-4000-8000-000000000013', 'c6f00000-0000-4000-8000-000000000001', 'NoReports'),
  ('c6f00000-0000-4000-8000-000000000014', 'c6f00000-0000-4000-8000-000000000001', 'Groomer'),
  ('c6f00000-0000-4000-8000-000000000015', 'c6f00000-0000-4000-8000-000000000002', 'Pemilik');
insert into public.role_permissions (organization_id, role_id, permission_id)
  select 'c6f00000-0000-4000-8000-000000000001', 'c6f00000-0000-4000-8000-000000000011', id from public.permissions
   where key in ('reports.view','finance.read','customer.read','customer.manage','booking.read','payroll.read','membership.read','settings.manage','roles.manage','branches.all','order.read');
-- North-only reader: reports + finance + customer + booking, but NOT payroll/roles/settings and only the North branch.
insert into public.role_permissions (organization_id, role_id, permission_id)
  select 'c6f00000-0000-4000-8000-000000000001', 'c6f00000-0000-4000-8000-000000000012', id from public.permissions
   where key in ('reports.view','finance.read','customer.read','booking.read');
insert into public.role_permissions (organization_id, role_id, permission_id)
  select 'c6f00000-0000-4000-8000-000000000001', 'c6f00000-0000-4000-8000-000000000013', id from public.permissions where key in ('finance.read','customer.read');
insert into public.role_permissions (organization_id, role_id, permission_id)
  select 'c6f00000-0000-4000-8000-000000000001', 'c6f00000-0000-4000-8000-000000000014', id from public.permissions where key in ('booking.read');
insert into public.role_permissions (organization_id, role_id, permission_id)
  select 'c6f00000-0000-4000-8000-000000000002', 'c6f00000-0000-4000-8000-000000000015', id from public.permissions
   where key in ('reports.view','finance.read','customer.read','booking.read','payroll.read','branches.all','order.read');
insert into auth.users (id, email, raw_user_meta_data) values
  ('c6f00000-0000-4000-8000-000000000021', 'owner-a@rec.test', '{}'),
  ('c6f00000-0000-4000-8000-000000000022', 'north@rec.test', '{}'),
  ('c6f00000-0000-4000-8000-000000000023', 'noreports@rec.test', '{}'),
  ('c6f00000-0000-4000-8000-000000000024', 'owner-b@rec.test', '{}'),
  ('c6f00000-0000-4000-8000-000000000025', 'groomer@rec.test', '{}');
update public.users set status = 'active', full_name = case id::text when 'c6f00000-0000-4000-8000-000000000021' then 'Owner Ayu' else full_name end where id::text like 'c6f00000-%';
insert into public.memberships (id, user_id, organization_id, role_id, status) values
  ('c6f00000-0000-4000-8000-0000000000f1', 'c6f00000-0000-4000-8000-000000000021', 'c6f00000-0000-4000-8000-000000000001', 'c6f00000-0000-4000-8000-000000000011', 'active'),
  ('c6f00000-0000-4000-8000-0000000000f2', 'c6f00000-0000-4000-8000-000000000022', 'c6f00000-0000-4000-8000-000000000001', 'c6f00000-0000-4000-8000-000000000012', 'active'),
  ('c6f00000-0000-4000-8000-0000000000f3', 'c6f00000-0000-4000-8000-000000000023', 'c6f00000-0000-4000-8000-000000000001', 'c6f00000-0000-4000-8000-000000000013', 'active'),
  ('c6f00000-0000-4000-8000-0000000000f4', 'c6f00000-0000-4000-8000-000000000024', 'c6f00000-0000-4000-8000-000000000002', 'c6f00000-0000-4000-8000-000000000015', 'active'),
  ('c6f00000-0000-4000-8000-0000000000f5', 'c6f00000-0000-4000-8000-000000000025', 'c6f00000-0000-4000-8000-000000000001', 'c6f00000-0000-4000-8000-000000000014', 'active');
insert into public.membership_branch_access (organization_id, membership_id, branch_id) values
  ('c6f00000-0000-4000-8000-000000000001', 'c6f00000-0000-4000-8000-0000000000f2', 'c6f00000-0000-4000-8000-0000000000e1'),
  ('c6f00000-0000-4000-8000-000000000001', 'c6f00000-0000-4000-8000-0000000000f5', 'c6f00000-0000-4000-8000-0000000000e1');

insert into public.customers (id, organization_id, display_name) values
  ('c6f00000-0000-4000-8000-0000000000a1', 'c6f00000-0000-4000-8000-000000000001', 'Cust A'),
  ('c6f00000-0000-4000-8000-0000000000b1', 'c6f00000-0000-4000-8000-000000000002', 'Cust B');
insert into public.pets (id, organization_id, customer_id, name) values
  ('c6f00000-0000-4000-8000-0000000000c1', 'c6f00000-0000-4000-8000-000000000001', 'c6f00000-0000-4000-8000-0000000000a1', 'Pet 1');
insert into public.service_catalog (id, organization_id, name, base_price, currency, duration_minutes, is_active, payroll_role) values
  ('c6f00000-0000-4000-8000-000000005001', 'c6f00000-0000-4000-8000-000000000001', 'Basic', 100000, 'IDR', 60, true, 'basic_grooming');

-- ===== Audit rows via the real triggers (actor = owner A) =====
select set_config('request.jwt.claims', json_build_object('sub','c6f00000-0000-4000-8000-000000000021','role','authenticated','active_org_id','c6f00000-0000-4000-8000-000000000001')::text, true);
update public.customers set display_name = 'Cust A renamed', notes = 'n1' where id = 'c6f00000-0000-4000-8000-0000000000a1';
update public.customers set notes = 'n2' where id = 'c6f00000-0000-4000-8000-0000000000a1';
insert into public.customer_onboarding_links (id, organization_id, token_hash, status) values
  ('c6f00000-0000-4000-8000-0000000000c9', 'c6f00000-0000-4000-8000-000000000001', 'SECRET-TOKEN-HASH-VALUE', 'active');
insert into public.tax_rates (id, organization_id, name, rate_percent, metadata) values
  ('c6f00000-0000-4000-8000-0000000000ca', 'c6f00000-0000-4000-8000-000000000001', 'Nested audit redaction', 10,
   '{"integrations":{"api_key":"NESTED-API-KEY-MUST-NOT-LEAK","safe_label":"retained"},"array":[{"token":"NESTED-ARRAY-TOKEN","safe":"retained"}]}'::jsonb);
insert into public.bookings (id, organization_id, branch_id, customer_id, booking_type, status, starts_at, ends_at) values
  ('c6f00000-0000-4000-8000-0000000000d1', 'c6f00000-0000-4000-8000-000000000001', 'c6f00000-0000-4000-8000-0000000000e1', 'c6f00000-0000-4000-8000-0000000000a1', 'grooming', 'confirmed', now() + interval '30 days', now() + interval '30 days 1 hour'),
  ('c6f00000-0000-4000-8000-0000000000d2', 'c6f00000-0000-4000-8000-000000000001', 'c6f00000-0000-4000-8000-0000000000e3', 'c6f00000-0000-4000-8000-0000000000a1', 'grooming', 'confirmed', now() + interval '31 days', now() + interval '31 days 1 hour');
update public.roles set name = 'Pemilik 2' where id = 'c6f00000-0000-4000-8000-000000000011';
update public.roles set name = 'Pemilik' where id = 'c6f00000-0000-4000-8000-000000000011';
select set_config('request.jwt.claims', '', true);

-- The internal redaction helpers are not client-callable, so evaluate the shape probe as the table owner first.
create temporary table redact_probe as
  select app.audit_redact('{"a":[{"s":"1"},{"api_key":"K1"},{"s":"3"}],"deep":{"x":{"y":[{"ok":true,"Password":"P"},[{"TOKEN":"T"}]]}},"list":["p","q"],"n":null,"num":2,"secret":"top"}'::jsonb) as v;
grant select on redact_probe to authenticated;
set local role authenticated;
select pg_temp.act_as('c6f00000-0000-4000-8000-000000000021', 'c6f00000-0000-4000-8000-000000000001');
do $$
declare r record; n integer; v_first timestamptz; v_first_id uuid; v_pages integer := 0; v_seen integer := 0;
begin
  -- Updates show only changed fields (+ not the metadata fields), with the resolved actor.
  select * into r from app.search_audit_events(array['customers'], null, 'UPDATE', null, null, null, null, 10) where diff #>> '{new,notes}' = 'n2';
  if r.actor_label <> 'Owner Ayu' then raise exception 'FAIL actor not resolved: %', r.actor_label; end if;
  if r.diff #>> '{new,notes}' <> 'n2' or r.diff #>> '{old,notes}' <> 'n1' then raise exception 'FAIL changed field values: %', r.diff; end if;
  if (r.diff -> 'new') ? 'display_name' or (r.diff -> 'new') ? 'updated_at' then raise exception 'FAIL unchanged/metadata fields leaked: %', r.diff; end if;
  raise notice 'PASS: UPDATE events carry only changed fields and the resolved actor';

  -- Secret-looking keys are removed even from inserts.
  select * into r from app.search_audit_events(array['customer_onboarding_links'], null, 'INSERT', null, null, null, null, 10) limit 1;
  if r.id is null then raise exception 'FAIL onboarding link insert not visible to its owner'; end if;
  if r.diff::text ilike '%SECRET-TOKEN%' or (r.diff -> 'new') ? 'token_hash' then raise exception 'FAIL secret leaked into audit view: %', r.diff; end if;
  raise notice 'PASS: secret-looking fields are redacted';
  select * into r from app.search_audit_events(array['tax_rates'], null, 'INSERT', null, null, null, null, 10) limit 1;
  if r.id is null then raise exception 'FAIL nested audit row not visible to its owner'; end if;
  if r.diff::text ilike '%NESTED-API-KEY%' or r.diff::text ilike '%NESTED-ARRAY-TOKEN%'
     or r.diff #> '{new,metadata,integrations,api_key}' is not null
     or r.diff #> '{new,metadata,array,0,token}' is not null
     or r.diff #>> '{new,metadata,integrations,safe_label}' <> 'retained' then
    raise exception 'FAIL nested secret leaked or safe metadata lost: %', r.diff;
  end if;
  raise notice 'PASS: nested secret-looking audit fields are redacted';
  -- Array order and depth: the redacted element keeps its position; deeper nesting, scalar arrays and nulls survive.
  if (select v from redact_probe) is distinct from '{"a":[{"s":"1"},{},{"s":"3"}],"deep":{"x":{"y":[{"ok":true},[{}]]}},"list":["p","q"],"n":null,"num":2}'::jsonb then
    raise exception 'FAIL recursive redaction shape/order: %', (select v from redact_probe); end if;
  raise notice 'PASS: recursive redaction keeps array order, depth, scalars and nulls';
  if not exists (select 1 from app.search_audit_events(array['roles'], null, 'UPDATE', null, null, null, null, 10)) then raise exception 'FAIL owner cannot see access-management audit rows'; end if;

  -- Filters: action, table, actor, time window.
  select count(*) into n from app.search_audit_events(array['customers'], null, 'UPDATE', null, null, null, null, 50);
  if n <> 2 then raise exception 'FAIL action/table filter: %', n; end if;
  select count(*) into n from app.search_audit_events(null, 'c6f00000-0000-4000-8000-000000000021', null, null, null, null, null, 100);
  if n < 5 then raise exception 'FAIL actor filter: %', n; end if;
  select count(*) into n from app.search_audit_events(null, null, null, now() + interval '1 day', null, null, null, 100);
  if n <> 0 then raise exception 'FAIL time filter'; end if;
  perform pg_temp.expect($q$select * from app.search_audit_events(null, null, 'TRUNCATE', null, null, null, null, 10)$q$, '22023', 'unknown action filter rejected');
  perform pg_temp.expect($q$select * from app.search_audit_events(null, null, null, now(), now() - interval '1 day', null, null, 10)$q$, '22023', 'reversed window rejected');
  perform pg_temp.expect($q$select * from app.search_audit_events(null, null, null, null, null, now(), null, 10)$q$, '22023', 'half a cursor rejected');
  raise notice 'PASS: filters';

  -- Keyset pagination returns every row exactly once.
  select count(*) into n from app.search_audit_events(null, null, null, null, null, null, null, 100);
  v_first := null; v_first_id := null;
  loop
    select * into r from (select * from app.search_audit_events(null, null, null, null, null, v_first, v_first_id, 2)) q order by occurred_at asc, id asc limit 1;
    exit when r.id is null;
    v_pages := v_pages + 1; v_seen := v_seen + least(2, (select count(*) from app.search_audit_events(null, null, null, null, null, v_first, v_first_id, 2)));
    v_first := r.occurred_at; v_first_id := r.id;
    exit when v_pages > 200;
  end loop;
  if v_seen <> n then raise exception 'FAIL pagination saw % of % rows', v_seen, n; end if;
  raise notice 'PASS: keyset pagination covers every row';
end $$;

-- Branch scope + capability filtering for a North-only reader without payroll/roles/settings rights.
select pg_temp.act_as('c6f00000-0000-4000-8000-000000000022', 'c6f00000-0000-4000-8000-000000000001');
do $$
declare n integer;
begin
  select count(*) into n from app.search_audit_events(array['bookings'], null, null, null, null, null, null, 50);
  if n <> 1 then raise exception 'FAIL branch-restricted reader sees % booking events (want North only = 1)', n; end if;
  if exists (select 1 from app.search_audit_events(null, null, null, null, null, null, null, 100) where entity_table in ('roles','role_permissions','memberships')) then
    raise exception 'FAIL reader without roles.manage saw access-management audit rows'; end if;
  if exists (select 1 from app.search_audit_events(null, null, null, null, null, null, null, 100) where entity_table like 'payroll\_%' escape '\') then
    raise exception 'FAIL reader without payroll.read saw payroll audit rows'; end if;
  raise notice 'PASS: branch-limited and capability-limited audit view';
end $$;
select pg_temp.act_as('c6f00000-0000-4000-8000-000000000023', 'c6f00000-0000-4000-8000-000000000001');
do $$ begin perform pg_temp.expect($q$select * from app.search_audit_events(null,null,null,null,null,null,null,10)$q$, '42501', 'role without reports.view refused'); end $$;
select pg_temp.act_as('c6f00000-0000-4000-8000-000000000025', 'c6f00000-0000-4000-8000-000000000001');
do $$ begin perform pg_temp.expect($q$select * from app.search_audit_events(null,null,null,null,null,null,null,10)$q$, '42501', 'groomer refused'); end $$;
select pg_temp.act_as('c6f00000-0000-4000-8000-000000000024', 'c6f00000-0000-4000-8000-000000000002');
do $$ begin
  if exists (select 1 from app.search_audit_events(null,null,null,null,null,null,null,100) where entity_id in ('c6f00000-0000-4000-8000-0000000000a1', 'c6f00000-0000-4000-8000-0000000000c9', 'c6f00000-0000-4000-8000-0000000000d1')) then
    raise exception 'FAIL org B saw org A audit rows'; end if;
  if not exists (select 1 from app.search_audit_events(array['customers'],null,null,null,null,null,null,100) where entity_id = 'c6f00000-0000-4000-8000-0000000000b1') then
    raise exception 'FAIL org B cannot see its own audit rows'; end if;
  raise notice 'PASS: tenant isolation of the audit view';
end $$;
select pg_temp.act_as('c6f00000-0000-4000-8000-000000000024', 'c6f00000-0000-4000-8000-000000000001');
do $$ begin perform pg_temp.expect($q$select * from app.search_audit_events(null,null,null,null,null,null,null,10)$q$, '42501', 'forged organization refused'); end $$;

-- ===== Reconciliation: invoices vs valid payments =====
reset role;
insert into public.invoices (id, organization_id, branch_id, customer_id, invoice_number, status, currency, subtotal, total, issued_at) values
  ('c6f00000-0000-4000-8000-0000000001a1', 'c6f00000-0000-4000-8000-000000000001', 'c6f00000-0000-4000-8000-0000000000e1', 'c6f00000-0000-4000-8000-0000000000a1', 'R-CLEAN-ISSUED',   'issued', 'IDR', 100, 100, now() - interval '1 day'),
  ('c6f00000-0000-4000-8000-0000000001a2', 'c6f00000-0000-4000-8000-000000000001', 'c6f00000-0000-4000-8000-0000000000e1', 'c6f00000-0000-4000-8000-0000000000a1', 'R-FULL-NOT-CLOSED','issued', 'IDR', 100, 100, now() - interval '2 days'),
  ('c6f00000-0000-4000-8000-0000000001a3', 'c6f00000-0000-4000-8000-000000000001', 'c6f00000-0000-4000-8000-0000000000e1', 'c6f00000-0000-4000-8000-0000000000a1', 'R-PAID-OK',       'issued', 'IDR', 100, 100, now() - interval '3 days'),
  ('c6f00000-0000-4000-8000-0000000001a4', 'c6f00000-0000-4000-8000-000000000001', 'c6f00000-0000-4000-8000-0000000000e1', 'c6f00000-0000-4000-8000-0000000000a1', 'R-PAID-NO-PAY',   'issued', 'IDR', 100, 100, now() - interval '4 days'),
  ('c6f00000-0000-4000-8000-0000000001a5', 'c6f00000-0000-4000-8000-000000000001', 'c6f00000-0000-4000-8000-0000000000e1', 'c6f00000-0000-4000-8000-0000000000a1', 'R-VOID-PAID',     'issued', 'IDR', 100, 100, now() - interval '5 days'),
  ('c6f00000-0000-4000-8000-0000000001a6', 'c6f00000-0000-4000-8000-000000000001', 'c6f00000-0000-4000-8000-0000000000e1', 'c6f00000-0000-4000-8000-0000000000a1', 'R-FOREIGN-CCY',   'issued', 'IDR', 100, 100, now() - interval '6 days'),
  ('c6f00000-0000-4000-8000-0000000001a7', 'c6f00000-0000-4000-8000-000000000001', 'c6f00000-0000-4000-8000-0000000000e1', 'c6f00000-0000-4000-8000-0000000000a1', 'R-REFUNDED',      'issued', 'IDR', 100, 100, now() - interval '7 days'),
  ('c6f00000-0000-4000-8000-0000000001a8', 'c6f00000-0000-4000-8000-000000000001', 'c6f00000-0000-4000-8000-0000000000e3', 'c6f00000-0000-4000-8000-0000000000a1', 'R-SOUTH-FULL',    'issued', 'IDR', 100, 100, now() - interval '8 days'),
  ('c6f00000-0000-4000-8000-0000000001b1', 'c6f00000-0000-4000-8000-000000000002', 'c6f00000-0000-4000-8000-0000000000e2', 'c6f00000-0000-4000-8000-0000000000b1', 'R-B-FULL',        'issued', 'IDR', 100, 100, now() - interval '1 day');
insert into public.payments (id, organization_id, branch_id, invoice_id, method, amount, currency, status, paid_at) values
  ('c6f00000-0000-4000-8000-0000000002a1', 'c6f00000-0000-4000-8000-000000000001', 'c6f00000-0000-4000-8000-0000000000e1', 'c6f00000-0000-4000-8000-0000000001a1', 'cash', 40, 'IDR', 'succeeded', now()),
  ('c6f00000-0000-4000-8000-0000000002a2', 'c6f00000-0000-4000-8000-000000000001', 'c6f00000-0000-4000-8000-0000000000e1', 'c6f00000-0000-4000-8000-0000000001a2', 'cash', 100, 'IDR', 'succeeded', now()),
  ('c6f00000-0000-4000-8000-0000000002a3', 'c6f00000-0000-4000-8000-000000000001', 'c6f00000-0000-4000-8000-0000000000e1', 'c6f00000-0000-4000-8000-0000000001a3', 'cash', 100, 'IDR', 'succeeded', now()),
  ('c6f00000-0000-4000-8000-0000000002a5', 'c6f00000-0000-4000-8000-000000000001', 'c6f00000-0000-4000-8000-0000000000e1', 'c6f00000-0000-4000-8000-0000000001a5', 'cash', 100, 'IDR', 'succeeded', now()),
  ('c6f00000-0000-4000-8000-0000000002a6', 'c6f00000-0000-4000-8000-000000000001', 'c6f00000-0000-4000-8000-0000000000e1', 'c6f00000-0000-4000-8000-0000000001a6', 'cash', 5, 'USD', 'succeeded', now()),
  ('c6f00000-0000-4000-8000-0000000002a7', 'c6f00000-0000-4000-8000-000000000001', 'c6f00000-0000-4000-8000-0000000000e1', 'c6f00000-0000-4000-8000-0000000001a7', 'cash', 100, 'IDR', 'succeeded', now()),
  ('c6f00000-0000-4000-8000-0000000002a8', 'c6f00000-0000-4000-8000-000000000001', 'c6f00000-0000-4000-8000-0000000000e3', 'c6f00000-0000-4000-8000-0000000001a8', 'cash', 100, 'IDR', 'succeeded', now()),
  -- a failed payment never counts as valid
  ('c6f00000-0000-4000-8000-0000000002a9', 'c6f00000-0000-4000-8000-000000000001', 'c6f00000-0000-4000-8000-0000000000e1', 'c6f00000-0000-4000-8000-0000000001a1', 'cash', 60, 'IDR', 'failed', now()),
  ('c6f00000-0000-4000-8000-0000000002b1', 'c6f00000-0000-4000-8000-000000000002', 'c6f00000-0000-4000-8000-0000000000e2', 'c6f00000-0000-4000-8000-0000000001b1', 'cash', 100, 'IDR', 'succeeded', now());
-- The invoice status trigger (if any) may have flipped some rows; set the intended states explicitly.
update public.invoices set status = 'paid' where id in ('c6f00000-0000-4000-8000-0000000001a3', 'c6f00000-0000-4000-8000-0000000001a4', 'c6f00000-0000-4000-8000-0000000001a7');
update public.invoices set status = 'void' where id = 'c6f00000-0000-4000-8000-0000000001a5';
update public.invoices set status = 'issued' where id in ('c6f00000-0000-4000-8000-0000000001a1', 'c6f00000-0000-4000-8000-0000000001a2', 'c6f00000-0000-4000-8000-0000000001a6', 'c6f00000-0000-4000-8000-0000000001a8', 'c6f00000-0000-4000-8000-0000000001b1');
insert into public.refunds (id, organization_id, payment_id, invoice_id, amount, status) values
  ('c6f00000-0000-4000-8000-0000000003a7', 'c6f00000-0000-4000-8000-000000000001', 'c6f00000-0000-4000-8000-0000000002a7', 'c6f00000-0000-4000-8000-0000000001a7', 60, 'succeeded');

set local role authenticated;
select pg_temp.act_as('c6f00000-0000-4000-8000-000000000021', 'c6f00000-0000-4000-8000-000000000001');
do $$
declare r record; n integer; v_issue text;
begin
  select count(*) into n from app.reconcile_invoice_payments(null, null, 100);
  if n <> 6 then raise exception 'FAIL expected 6 invoice discrepancies, got %: %', n, (select string_agg(invoice_number || ':' || issue, ', ') from app.reconcile_invoice_payments(null, null, 100)); end if;
  for r in select * from app.reconcile_invoice_payments(null, null, 100) loop
    v_issue := case r.invoice_number
      when 'R-FULL-NOT-CLOSED' then 'paid_in_full_not_closed'
      when 'R-PAID-NO-PAY' then 'closed_without_full_payment'
      when 'R-VOID-PAID' then 'void_with_payments'
      when 'R-FOREIGN-CCY' then 'currency_mismatch'
      when 'R-REFUNDED' then 'closed_without_full_payment'
      when 'R-SOUTH-FULL' then 'paid_in_full_not_closed' end;
    if v_issue is distinct from r.issue then raise exception 'FAIL % classified as % (want %)', r.invoice_number, r.issue, v_issue; end if;
  end loop;
  -- clean / partially paid / properly closed / failed-payment-only invoices are never flagged
  if exists (select 1 from app.reconcile_invoice_payments(null, null, 100) where invoice_number in ('R-CLEAN-ISSUED', 'R-PAID-OK')) then raise exception 'FAIL clean invoice flagged'; end if;
  select * into r from app.reconcile_invoice_payments(null, null, 100) where invoice_number = 'R-REFUNDED';
  if r.paid_amount <> 100 or r.refunded_amount <> 60 or r.net_paid <> 40 then raise exception 'FAIL refund netting %', row_to_json(r); end if;
  raise notice 'PASS: invoice discrepancies (void, refunded, mixed currency, branch rows, failed payments ignored)';

  -- Pagination covers each flagged invoice once.
  n := 0;
  select * into r from app.reconcile_invoice_payments(null, null, 2) order by issued_at desc, invoice_id desc offset 1 limit 1;
  select count(*) into n from app.reconcile_invoice_payments(r.issued_at, r.invoice_id, 100);
  if n <> 4 then raise exception 'FAIL keyset page after 2nd row returned %', n; end if;
  perform pg_temp.expect($q$select * from app.reconcile_invoice_payments(now(), null, 10)$q$, '22023', 'half a cursor rejected');
end $$;
select pg_temp.act_as('c6f00000-0000-4000-8000-000000000022', 'c6f00000-0000-4000-8000-000000000001');
do $$ begin
  if exists (select 1 from app.reconcile_invoice_payments(null, null, 100) where invoice_number = 'R-SOUTH-FULL') then raise exception 'FAIL branch-limited reader sees South invoice'; end if;
  if (select count(*) from app.reconcile_invoice_payments(null, null, 100)) <> 5 then raise exception 'FAIL branch-limited count'; end if;
  raise notice 'PASS: branch scope applies to invoice reconciliation';
end $$;
select pg_temp.act_as('c6f00000-0000-4000-8000-000000000025', 'c6f00000-0000-4000-8000-000000000001');
do $$ begin perform pg_temp.expect($q$select * from app.reconcile_invoice_payments(null,null,10)$q$, '42501', 'groomer without finance.read refused'); end $$;
select pg_temp.act_as('c6f00000-0000-4000-8000-000000000024', 'c6f00000-0000-4000-8000-000000000002');
do $$ begin
  if (select count(*) from app.reconcile_invoice_payments(null, null, 100)) <> 1 or (select invoice_number from app.reconcile_invoice_payments(null, null, 100)) <> 'R-B-FULL' then raise exception 'FAIL tenant B reconciliation'; end if;
  raise notice 'PASS: tenant isolation of invoice reconciliation';
end $$;

-- ===== Reconciliation: completed visits lacking a valid invoice (existing visit register RPC, unbilled filter) =====
reset role;
insert into public.bookings (id, organization_id, branch_id, customer_id, booking_type, status, starts_at, ends_at) values
  ('c6f00000-0000-4000-8000-0000000004a1', 'c6f00000-0000-4000-8000-000000000001', 'c6f00000-0000-4000-8000-0000000000e1', 'c6f00000-0000-4000-8000-0000000000a1', 'grooming', 'completed', now() - interval '10 days', now() - interval '10 days' + interval '1 hour'),
  ('c6f00000-0000-4000-8000-0000000004a2', 'c6f00000-0000-4000-8000-000000000001', 'c6f00000-0000-4000-8000-0000000000e1', 'c6f00000-0000-4000-8000-0000000000a1', 'grooming', 'completed', now() - interval '9 days', now() - interval '9 days' + interval '1 hour'),
  ('c6f00000-0000-4000-8000-0000000004a3', 'c6f00000-0000-4000-8000-000000000001', 'c6f00000-0000-4000-8000-0000000000e1', 'c6f00000-0000-4000-8000-0000000000a1', 'grooming', 'completed', now() - interval '8 days', now() - interval '8 days' + interval '1 hour'),
  ('c6f00000-0000-4000-8000-0000000004a4', 'c6f00000-0000-4000-8000-000000000001', 'c6f00000-0000-4000-8000-0000000000e1', 'c6f00000-0000-4000-8000-0000000000a1', 'grooming', 'confirmed', now() - interval '7 days', now() - interval '7 days' + interval '1 hour');
-- a1: valid invoice; a2: only a VOID invoice (still a discrepancy); a3: no invoice; a4 not completed (not in scope)
insert into public.orders (id, organization_id, branch_id, customer_id, booking_id, status) values
  ('c6f00000-0000-4000-8000-0000000005a1', 'c6f00000-0000-4000-8000-000000000001', 'c6f00000-0000-4000-8000-0000000000e1', 'c6f00000-0000-4000-8000-0000000000a1', 'c6f00000-0000-4000-8000-0000000004a1', 'confirmed'),
  ('c6f00000-0000-4000-8000-0000000005a2', 'c6f00000-0000-4000-8000-000000000001', 'c6f00000-0000-4000-8000-0000000000e1', 'c6f00000-0000-4000-8000-0000000000a1', 'c6f00000-0000-4000-8000-0000000004a2', 'confirmed');
insert into public.invoices (id, organization_id, branch_id, customer_id, order_id, invoice_number, status, currency, subtotal, total, issued_at) values
  ('c6f00000-0000-4000-8000-0000000006a1', 'c6f00000-0000-4000-8000-000000000001', 'c6f00000-0000-4000-8000-0000000000e1', 'c6f00000-0000-4000-8000-0000000000a1', 'c6f00000-0000-4000-8000-0000000005a1', 'V-OK', 'issued', 'IDR', 1, 1, now()),
  ('c6f00000-0000-4000-8000-0000000006a2', 'c6f00000-0000-4000-8000-000000000001', 'c6f00000-0000-4000-8000-0000000000e1', 'c6f00000-0000-4000-8000-0000000000a1', 'c6f00000-0000-4000-8000-0000000005a2', 'V-VOID', 'issued', 'IDR', 1, 1, now());
update public.invoices set status = 'void' where id = 'c6f00000-0000-4000-8000-0000000006a2';
set local role authenticated;
select pg_temp.act_as('c6f00000-0000-4000-8000-000000000021', 'c6f00000-0000-4000-8000-000000000001');
do $$
declare ids uuid[];
begin
  select array_agg(id order by id) into ids from app.reconcile_unbilled_visits(null, null, 100);
  if ids is distinct from array['c6f00000-0000-4000-8000-0000000004a2'::uuid, 'c6f00000-0000-4000-8000-0000000004a3'::uuid] then
    raise exception 'FAIL unbilled visits: %', ids; end if;
  raise notice 'PASS: completed visits without a valid (non-void) invoice are exactly the unbilled ones';
  if (select count(*) from app.reconcile_unbilled_visits(null, null, 1)) <> 1 then raise exception 'FAIL limit'; end if;
  if (select count(*) from app.reconcile_unbilled_visits((select visit_at from app.reconcile_unbilled_visits(null, null, 1)), (select id from app.reconcile_unbilled_visits(null, null, 1)), 100)) <> 1 then
    raise exception 'FAIL keyset after first unbilled visit'; end if;
end $$;
-- Without order.read the register would report every visit as unbilled: refuse instead.
select pg_temp.act_as('c6f00000-0000-4000-8000-000000000022', 'c6f00000-0000-4000-8000-000000000001');
do $$ begin perform pg_temp.expect($q$select * from app.reconcile_unbilled_visits(null, null, 10)$q$, '42501', 'caller who cannot read orders is refused rather than shown false positives'); end $$;
select pg_temp.act_as('c6f00000-0000-4000-8000-000000000024', 'c6f00000-0000-4000-8000-000000000002');
do $$ begin
  if (select count(*) from app.reconcile_unbilled_visits(null, null, 100)) <> 0 then raise exception 'FAIL tenant B sees tenant A unbilled visits'; end if;
  raise notice 'PASS: unbilled visit reconciliation tenant isolation';
end $$;
select pg_temp.act_as('c6f00000-0000-4000-8000-000000000021', 'c6f00000-0000-4000-8000-000000000001');

-- ===== Reconciliation: published payroll vs live source =====
reset role;
insert into public.resources (id, organization_id, branch_id, kind, name, capacity, status, membership_id, hired_at) values
  ('c6f00000-0000-4000-8000-0000000007a1', 'c6f00000-0000-4000-8000-000000000001', 'c6f00000-0000-4000-8000-0000000000e1', 'staff', 'Groomer R', 1, 'active', 'c6f00000-0000-4000-8000-0000000000f5', '2020-01-01');
insert into public.grooming_jobs (booking_id, organization_id) values
  ('c6f00000-0000-4000-8000-0000000004a1', 'c6f00000-0000-4000-8000-000000000001');
insert into public.grooming_job_pets (id, organization_id, grooming_job_id, pet_id, assigned_resource_id, status) values
  ('c6f00000-0000-4000-8000-0000000008a1', 'c6f00000-0000-4000-8000-000000000001', 'c6f00000-0000-4000-8000-0000000004a1', 'c6f00000-0000-4000-8000-0000000000c1', 'c6f00000-0000-4000-8000-0000000007a1', 'complete');
insert into public.grooming_job_pet_services (id, organization_id, grooming_job_pet_id, service_id, service_name_snapshot, unit_price_snapshot, quantity, currency)
values ('c6f00000-0000-4000-8000-0000000009a1', 'c6f00000-0000-4000-8000-000000000001', 'c6f00000-0000-4000-8000-0000000008a1', 'c6f00000-0000-4000-8000-000000005001', 'Basic', 100000, 1, 'IDR');
insert into public.payroll_cycle_settings (organization_id) values ('c6f00000-0000-4000-8000-000000000001') on conflict (organization_id) do nothing;
insert into public.staff_payroll_settings (organization_id, membership_id, per_pet_enabled, styling_enabled, botak_enabled)
values ('c6f00000-0000-4000-8000-000000000001', 'c6f00000-0000-4000-8000-0000000000f5', true, true, true);
-- Period around the booking (10 days ago) in the org zone.
insert into public.payroll_runs (id, organization_id, branch_id, period_start, period_end, status, currency) values
  ('c6f00000-0000-4000-8000-000000000a01', 'c6f00000-0000-4000-8000-000000000001', null, (now() - interval '20 days')::date, (now() - interval '2 days')::date, 'paid', 'IDR'),
  ('c6f00000-0000-4000-8000-000000000a02', 'c6f00000-0000-4000-8000-000000000001', null, (now() - interval '60 days')::date, (now() - interval '40 days')::date, 'approved', 'IDR');
alter table public.payroll_items disable trigger trg_payroll_items_block_update;
insert into public.payroll_items (id, organization_id, payroll_run_id, membership_id, gross_pay, net_pay, breakdown) values
  -- matches the live source (1 basic pet) -> clean
  ('c6f00000-0000-4000-8000-000000000b01', 'c6f00000-0000-4000-8000-000000000001', 'c6f00000-0000-4000-8000-000000000a01', 'c6f00000-0000-4000-8000-0000000000f5', 1, 1, '{"meta":{"basicCount":1,"stylingCount":0,"botakCount":0}}'),
  -- snapshot claims 3 basic pets but live source has none in that period -> source_reduced
  ('c6f00000-0000-4000-8000-000000000b02', 'c6f00000-0000-4000-8000-000000000001', 'c6f00000-0000-4000-8000-000000000a02', 'c6f00000-0000-4000-8000-0000000000f5', 1, 1, '{"meta":{"basicCount":3,"stylingCount":0,"botakCount":0}}'),
  -- legacy snapshot without counts is reported, never guessed
  ('c6f00000-0000-4000-8000-000000000b03', 'c6f00000-0000-4000-8000-000000000001', 'c6f00000-0000-4000-8000-000000000a02', 'c6f00000-0000-4000-8000-0000000000f2', 1, 1, '{}');
alter table public.payroll_items enable trigger trg_payroll_items_block_update;
insert into public.payroll_publications (organization_id, membership_id, payroll_run_id, enabled) values
  ('c6f00000-0000-4000-8000-000000000001', 'c6f00000-0000-4000-8000-0000000000f5', 'c6f00000-0000-4000-8000-000000000a01', true),
  ('c6f00000-0000-4000-8000-000000000001', 'c6f00000-0000-4000-8000-0000000000f2', 'c6f00000-0000-4000-8000-000000000a02', true);
-- (membership f5 is published for run a01 only, so item b02 below is NOT published and must not be scanned)
set local role authenticated;
select pg_temp.act_as('c6f00000-0000-4000-8000-000000000021', 'c6f00000-0000-4000-8000-000000000001');
do $$
declare r record; n integer; v_issue text;
begin
  select count(*) into n from app.reconcile_payroll_sources(null, 50) where item_id is not null;
  if n <> 1 then raise exception 'FAIL expected 1 flagged payroll item, got %: %', n, (select string_agg(item_id || ':' || issue || ':' || coalesce(live_basic::text, '-'), ', ') from app.reconcile_payroll_sources(null, 50) where item_id is not null); end if;
  select * into r from app.reconcile_payroll_sources(null, 50) where item_id is not null;
  if r.item_id <> 'c6f00000-0000-4000-8000-000000000b03' or r.issue <> 'snapshot_without_counts' then raise exception 'FAIL flagged %', row_to_json(r); end if;
  -- clean published item (b01) is not flagged; unpublished item (b02) is out of scope.
  if exists (select 1 from app.reconcile_payroll_sources(null, 50) where item_id in ('c6f00000-0000-4000-8000-000000000b01', 'c6f00000-0000-4000-8000-000000000b02')) then
    raise exception 'FAIL clean or unpublished item flagged'; end if;
  raise notice 'PASS: clean published payroll is quiet; legacy snapshot is reported without guessing; unpublished is out of scope';
end $$;

reset role;
create temporary table payroll_before as select md5(string_agg(to_jsonb(i)::text, '~' order by i.id::text)) as h from public.payroll_items i;
grant select on payroll_before to authenticated;

-- Deleted-source edge: soft-delete the job line behind the frozen snapshot. Reported, never repaired or hidden.
update public.grooming_job_pets set deleted_at = now() where id = 'c6f00000-0000-4000-8000-0000000008a1';
set local role authenticated;
select pg_temp.act_as('c6f00000-0000-4000-8000-000000000021', 'c6f00000-0000-4000-8000-000000000001');
do $$
declare r record;
begin
  select * into r from app.reconcile_payroll_sources(null, 50) where item_id = 'c6f00000-0000-4000-8000-000000000b01';
  if r.issue is distinct from 'source_reduced' or r.snapshot_basic <> 1 or r.live_basic <> 0 then raise exception 'FAIL deleted job line not detected: %', row_to_json(r); end if;
  raise notice 'PASS: deleted source edge is reported as source_reduced';
end $$;

-- Restore it, then void the source invoice instead: the frozen snapshot no longer has a valid source.
reset role;
update public.grooming_job_pets set deleted_at = null where id = 'c6f00000-0000-4000-8000-0000000008a1';
set local role authenticated;
select pg_temp.act_as('c6f00000-0000-4000-8000-000000000021', 'c6f00000-0000-4000-8000-000000000001');
do $$ begin
  if exists (select 1 from app.reconcile_payroll_sources(null, 50) where item_id = 'c6f00000-0000-4000-8000-000000000b01') then raise exception 'FAIL restored source still flagged'; end if;
end $$;
reset role;
update public.invoices set status = 'void' where id = 'c6f00000-0000-4000-8000-0000000006a1';
set local role authenticated;
select pg_temp.act_as('c6f00000-0000-4000-8000-000000000021', 'c6f00000-0000-4000-8000-000000000001');
do $$
declare r record;
begin
  select * into r from app.reconcile_payroll_sources(null, 50) where item_id = 'c6f00000-0000-4000-8000-000000000b01';
  if r.issue is distinct from 'source_reduced' or r.snapshot_basic <> 1 or r.live_basic <> 0 then raise exception 'FAIL voided source not detected: %', row_to_json(r); end if;
  raise notice 'PASS: voided invoice behind a published payroll item is reported as source_reduced';
end $$;

-- Scan paging: scanning 1 item at a time walks the whole published set and reports the continuation.
do $$
declare v_after uuid; v_calls integer := 0; v_more boolean := true; v_flagged integer := 0; v_n integer;
begin
  while v_more and v_calls < 10 loop
    v_calls := v_calls + 1;
    select x.scanned_through, x.has_more into v_after, v_more from app.reconcile_payroll_sources(v_after, 1) x limit 1;
    select count(*) into v_n from app.reconcile_payroll_sources(null, 100) where item_id is not null;
    v_flagged := v_n;
  end loop;
  if v_calls <> 2 then raise exception 'FAIL scan paging used % calls for 2 published items', v_calls; end if;
  if v_flagged <> 2 then raise exception 'FAIL full scan flagged % items (want 2: voided b01 + legacy b03)', v_flagged; end if;
  raise notice 'PASS: bounded payroll scan continues until the published set is exhausted';
end $$;

-- Authorization for the payroll scan.
select pg_temp.act_as('c6f00000-0000-4000-8000-000000000022', 'c6f00000-0000-4000-8000-000000000001');
do $$ begin perform pg_temp.expect($q$select * from app.reconcile_payroll_sources(null, 5)$q$, '42501', 'reader without payroll.read refused'); end $$;
select pg_temp.act_as('c6f00000-0000-4000-8000-000000000024', 'c6f00000-0000-4000-8000-000000000002');
do $$ begin
  if (select count(*) from app.reconcile_payroll_sources(null, 100) where item_id is not null) <> 0 then raise exception 'FAIL tenant B sees tenant A payroll items'; end if;
  raise notice 'PASS: payroll scan tenant isolation';
end $$;
select pg_temp.act_as('c6f00000-0000-4000-8000-000000000024', 'c6f00000-0000-4000-8000-000000000001');
do $$ begin perform pg_temp.expect($q$select * from app.reconcile_payroll_sources(null, 5)$q$, '42501', 'forged organization refused for payroll scan'); end $$;

-- Read-only guarantee: the reconciliation never altered payroll or invoice history, and grants are tight.
reset role;
do $$ begin
  if (select h from payroll_before) is distinct from (select md5(string_agg(to_jsonb(i)::text, '~' order by i.id::text)) from public.payroll_items i) then
    raise exception 'FAIL payroll items changed during reconciliation'; end if;
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'app'
              and p.proname in ('search_audit_events','reconcile_payroll_sources','audit_table_visible') and (not p.prosecdef or p.proconfig is null or not ('search_path=""' = any (p.proconfig)))) then
    raise exception 'FAIL definer search_path'; end if;
  if (select prosecdef from pg_proc where proname = 'reconcile_invoice_payments') then raise exception 'FAIL invoice reconciliation must be security invoker'; end if;
  if has_function_privilege('anon', 'app.search_audit_events(text[],uuid,text,timestamptz,timestamptz,timestamptz,uuid,integer)', 'execute')
     or has_function_privilege('public', 'app.reconcile_invoice_payments(timestamptz,uuid,integer)', 'execute')
     or has_function_privilege('anon', 'app.reconcile_payroll_sources(uuid,integer)', 'execute')
     or has_function_privilege('authenticated', 'app.audit_redact_value(jsonb)', 'execute')
     or has_function_privilege('anon', 'app.audit_redact_value(jsonb)', 'execute') or has_function_privilege('anon', 'app.audit_redact(jsonb)', 'execute')
     or has_function_privilege('public', 'app.audit_redact_value(jsonb)', 'execute') or has_function_privilege('public', 'app.audit_redact(jsonb)', 'execute')
     or has_function_privilege('authenticated', 'app.audit_redact(jsonb)', 'execute')
     or has_function_privilege('authenticated', 'app.audit_table_visible(text)', 'execute')
     or has_function_privilege('authenticated', 'app.audit_table_permission(text)', 'execute') then
    raise exception 'FAIL grants'; end if;
  raise notice 'PASS: payroll history untouched; grants and search_path';
end $$;
rollback;
