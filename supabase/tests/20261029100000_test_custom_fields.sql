-- E1.2 custom fields: definition/value RPCs, RLS, tenant isolation, archive/option edge cases.
-- Apply the full migration lineage, then:
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/20261029100000_test_custom_fields.sql
\set ON_ERROR_STOP on
create or replace function pg_temp.act_as(u text, o text) returns void language plpgsql as $$
begin perform set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated', 'active_org_id', o)::text, true); end $$;
-- Runs a statement and asserts it fails with the given SQLSTATE.
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
  ('c1f00000-0000-4000-8000-000000000001', 'CF A', 'cf-a-test', 'active'),
  ('c1f00000-0000-4000-8000-000000000002', 'CF B', 'cf-b-test', 'active');
insert into public.subscriptions (organization_id, status, current_period_start, current_period_end)
  select o, 'active', now() - interval '1 day', now() + interval '1 year'
  from (values ('c1f00000-0000-4000-8000-000000000001'::uuid), ('c1f00000-0000-4000-8000-000000000002'::uuid)) t(o);
insert into public.organization_modules (organization_id, module_id, enabled, source)
  select o, m.id, true, 'override' from public.modules m,
  (values ('c1f00000-0000-4000-8000-000000000001'::uuid), ('c1f00000-0000-4000-8000-000000000002'::uuid)) t(o);

insert into public.roles (id, organization_id, name) values
  ('c1f00000-0000-4000-8000-000000000011', 'c1f00000-0000-4000-8000-000000000001', 'Pemilik'),
  ('c1f00000-0000-4000-8000-000000000012', 'c1f00000-0000-4000-8000-000000000001', 'Staff'),
  ('c1f00000-0000-4000-8000-000000000013', 'c1f00000-0000-4000-8000-000000000001', 'Reader'),
  ('c1f00000-0000-4000-8000-000000000014', 'c1f00000-0000-4000-8000-000000000001', 'Blind'),
  ('c1f00000-0000-4000-8000-000000000015', 'c1f00000-0000-4000-8000-000000000002', 'Pemilik');
insert into public.role_permissions (organization_id, role_id, permission_id)
  select 'c1f00000-0000-4000-8000-000000000001', 'c1f00000-0000-4000-8000-000000000011', id from public.permissions
  where key in ('settings.manage','customer.manage','customer.read');
insert into public.role_permissions (organization_id, role_id, permission_id)
  select 'c1f00000-0000-4000-8000-000000000001', 'c1f00000-0000-4000-8000-000000000012', id from public.permissions
  where key in ('customer.manage','customer.read');
insert into public.role_permissions (organization_id, role_id, permission_id)
  select 'c1f00000-0000-4000-8000-000000000001', 'c1f00000-0000-4000-8000-000000000013', id from public.permissions
  where key in ('customer.read');
insert into public.role_permissions (organization_id, role_id, permission_id)
  select 'c1f00000-0000-4000-8000-000000000002', 'c1f00000-0000-4000-8000-000000000015', id from public.permissions
  where key in ('settings.manage','customer.manage','customer.read');

insert into auth.users (id, email, raw_user_meta_data) values
  ('c1f00000-0000-4000-8000-000000000021', 'owner-a@cf.test', '{}'),
  ('c1f00000-0000-4000-8000-000000000022', 'staff-a@cf.test', '{}'),
  ('c1f00000-0000-4000-8000-000000000023', 'reader-a@cf.test', '{}'),
  ('c1f00000-0000-4000-8000-000000000024', 'blind-a@cf.test', '{}'),
  ('c1f00000-0000-4000-8000-000000000025', 'owner-b@cf.test', '{}');
update public.users set status = 'active' where id::text like 'c1f00000-%';
insert into public.memberships (user_id, organization_id, role_id, status) values
  ('c1f00000-0000-4000-8000-000000000021', 'c1f00000-0000-4000-8000-000000000001', 'c1f00000-0000-4000-8000-000000000011', 'active'),
  ('c1f00000-0000-4000-8000-000000000022', 'c1f00000-0000-4000-8000-000000000001', 'c1f00000-0000-4000-8000-000000000012', 'active'),
  ('c1f00000-0000-4000-8000-000000000023', 'c1f00000-0000-4000-8000-000000000001', 'c1f00000-0000-4000-8000-000000000013', 'active'),
  ('c1f00000-0000-4000-8000-000000000024', 'c1f00000-0000-4000-8000-000000000001', 'c1f00000-0000-4000-8000-000000000014', 'active'),
  ('c1f00000-0000-4000-8000-000000000025', 'c1f00000-0000-4000-8000-000000000002', 'c1f00000-0000-4000-8000-000000000015', 'active');

insert into public.customers (id, organization_id, display_name) values
  ('c1f00000-0000-4000-8000-0000000000a1', 'c1f00000-0000-4000-8000-000000000001', 'Cust A'),
  ('c1f00000-0000-4000-8000-0000000000a2', 'c1f00000-0000-4000-8000-000000000001', 'Cust A old (no values)'),
  ('c1f00000-0000-4000-8000-0000000000b1', 'c1f00000-0000-4000-8000-000000000002', 'Cust B');
insert into public.pets (id, organization_id, customer_id, name) values
  ('c1f00000-0000-4000-8000-0000000000c1', 'c1f00000-0000-4000-8000-000000000001', 'c1f00000-0000-4000-8000-0000000000a1', 'Pet A'),
  ('c1f00000-0000-4000-8000-0000000000c2', 'c1f00000-0000-4000-8000-000000000002', 'c1f00000-0000-4000-8000-0000000000b1', 'Pet B');

set local role authenticated;
select pg_temp.act_as('c1f00000-0000-4000-8000-000000000021', 'c1f00000-0000-4000-8000-000000000001');

do $$
declare
  v_text uuid; v_num uuid; v_date uuid; v_bool uuid; v_sel uuid; v_pet_sel uuid;
  v_def public.custom_field_definitions; v_changed integer; v_n integer; v_upd timestamptz;
  v_cust constant uuid := 'c1f00000-0000-4000-8000-0000000000a1';
  v_old constant uuid := 'c1f00000-0000-4000-8000-0000000000a2';
  v_pet constant uuid := 'c1f00000-0000-4000-8000-0000000000c1';
begin
  -- Definitions: every type, both scopes.
  v_text := app.save_custom_field_definition(null, 'customer', 'Instagram', 'text', null, 10, null);
  v_num  := app.save_custom_field_definition(null, 'customer', 'Jumlah anak', 'number', null, 20, null);
  v_date := app.save_custom_field_definition(null, 'customer', 'Tanggal ulang tahun', 'date', null, 30, null);
  v_bool := app.save_custom_field_definition(null, 'customer', 'Setuju promosi', 'boolean', null, 40, null);
  v_sel  := app.save_custom_field_definition(null, 'customer', 'Kanal', 'select', array['Instagram','Teman','Walk-in'], 50, null);
  v_pet_sel := app.save_custom_field_definition(null, 'pet', 'Alergi', 'select', array['Tidak ada','Makanan'], 10, null);
  select count(*) into v_n from public.custom_field_definitions;
  if v_n <> 6 then raise exception 'FAIL expected 6 definitions, got %', v_n; end if;
  raise notice 'PASS: all five field types, both entity scopes';

  -- Values: valid for every type; old customer without values stays empty.
  v_changed := app.set_custom_field_values('customer', v_cust, jsonb_build_object(
    v_text::text, 'owner_ig', v_num::text, '-3.5', v_date::text, '2024-02-29', v_bool::text, 'true',
    v_sel::text, (select o ->> 'key' from public.custom_field_definitions d, jsonb_array_elements(d.options) o where d.id = v_sel and o ->> 'label' = 'Teman')));
  if v_changed <> 5 then raise exception 'FAIL expected 5 changes, got %', v_changed; end if;
  if (select count(*) from public.custom_field_values where customer_id = v_old) <> 0 then
    raise exception 'FAIL old record has values'; end if;
  raise notice 'PASS: typed values stored; old record without values has none';

  -- Re-saving identical values is a no-op (no churn, no audit noise).
  v_changed := app.set_custom_field_values('customer', v_cust, jsonb_build_object(v_text::text, 'owner_ig'));
  if v_changed <> 0 then raise exception 'FAIL idempotent save changed % rows', v_changed; end if;
  raise notice 'PASS: identical save is idempotent';

  -- Invalid, formula-like and unknown inputs.
  perform pg_temp.expect(format($q$select app.set_custom_field_values('customer', %L, jsonb_build_object(%L, '=1+1'))$q$, v_cust, v_text), '22023', 'formula-like text rejected');
  perform pg_temp.expect(format($q$select app.set_custom_field_values('customer', %L, jsonb_build_object(%L, '@SUM(A1)'))$q$, v_cust, v_text), '22023', '@ text rejected');
  perform pg_temp.expect(format($q$select app.set_custom_field_values('customer', %L, jsonb_build_object(%L, '+62812'))$q$, v_cust, v_text), '22023', '+ text rejected');
  perform pg_temp.expect(format($q$select app.set_custom_field_values('customer', %L, jsonb_build_object(%L, E'a\tb'))$q$, v_cust, v_text), '22023', 'control character rejected');
  perform pg_temp.expect(format($q$select app.set_custom_field_values('customer', %L, jsonb_build_object(%L, repeat('x', 201)))$q$, v_cust, v_text), '22023', 'overlong text rejected');
  perform pg_temp.expect(format($q$select app.set_custom_field_values('customer', %L, jsonb_build_object(%L, '1e5'))$q$, v_cust, v_num), '22023', 'exponent number rejected');
  perform pg_temp.expect(format($q$select app.set_custom_field_values('customer', %L, jsonb_build_object(%L, '=A1'))$q$, v_cust, v_num), '22023', 'formula number rejected');
  perform pg_temp.expect(format($q$select app.set_custom_field_values('customer', %L, jsonb_build_object(%L, '2023-02-29'))$q$, v_cust, v_date), '22023', 'impossible date rejected');
  perform pg_temp.expect(format($q$select app.set_custom_field_values('customer', %L, jsonb_build_object(%L, 'yes'))$q$, v_cust, v_bool), '22023', 'non-boolean rejected');
  perform pg_temp.expect(format($q$select app.set_custom_field_values('customer', %L, jsonb_build_object(%L, 'o999'))$q$, v_cust, v_sel), '22023', 'unknown option rejected');
  perform pg_temp.expect(format($q$select app.set_custom_field_values('customer', %L, jsonb_build_object(%L, 'x'))$q$, v_cust, 'c1f00000-0000-4000-8000-0000000fffff'), '22023', 'unknown definition rejected');
  perform pg_temp.expect(format($q$select app.set_custom_field_values('customer', %L, '[1]'::jsonb)$q$, v_cust), '22023', 'array payload rejected');
  perform pg_temp.expect(format($q$select app.set_custom_field_values('customer', %L, jsonb_build_object(%L, 5))$q$, v_cust, v_num), '22023', 'non-string JSON value rejected');
  perform pg_temp.expect(format($q$select app.set_custom_field_values('pet', %L, jsonb_build_object(%L, 'x'))$q$, v_pet, v_text), '22023', 'customer definition on a pet rejected');
  perform pg_temp.expect(format($q$select app.set_custom_field_values('customer', %L, jsonb_build_object(%L, 'x'))$q$, 'c1f00000-0000-4000-8000-0000000fffff', v_text), 'P0002', 'unknown customer rejected');

  -- A failed value in a batch leaves the earlier valid ones unwritten (single statement atomicity).
  begin
    perform app.set_custom_field_values('customer', v_old, jsonb_build_object(v_text::text, 'will_roll_back', v_num::text, 'abc'));
  exception when sqlstate '22023' then null; end;
  if exists (select 1 from public.custom_field_values where customer_id = v_old) then
    raise exception 'FAIL a failed batch left a partial write'; end if;
  raise notice 'PASS: failed batch leaves no partial write';

  -- Changed options: renaming keeps keys of untouched labels; removed option keeps the stored value but refuses new use.
  select * into v_def from public.custom_field_definitions where id = v_sel;
  perform app.save_custom_field_definition(v_sel, null, 'Kanal', null, array['Teman','Walk-in','Iklan'], 50, v_def.updated_at);
  select * into v_def from public.custom_field_definitions where id = v_sel;
  if v_def.options::text not like '%"Iklan"%' or v_def.options::text like '%"Instagram"%' then
    raise exception 'FAIL options not replaced: %', v_def.options; end if;
  if (select o ->> 'key' from jsonb_array_elements(v_def.options) o where o ->> 'label' = 'Teman')
     is distinct from (select value_option from public.custom_field_values where definition_id = v_sel and customer_id = v_cust) then
    raise exception 'FAIL surviving option lost its key'; end if;
  if (select o ->> 'key' from jsonb_array_elements(v_def.options) o where o ->> 'label' = 'Iklan') in ('o1','o2','o3') then
    raise exception 'FAIL option key reused'; end if;
  perform pg_temp.expect(format($q$select app.set_custom_field_values('customer', %L, jsonb_build_object(%L, 'o1'))$q$, v_cust, v_sel), '22023', 'removed option key refused for new writes');
  raise notice 'PASS: option edits keep surviving keys, never reuse keys';

  -- Immutability, duplicate label, stale version, option sanity.
  perform pg_temp.expect(format($q$select app.save_custom_field_definition(%L, 'customer', 'Kanal', 'text', null, 50, %L)$q$, v_sel, v_def.updated_at), '22023', 'type cannot change');
  perform pg_temp.expect(format($q$select app.save_custom_field_definition(%L, 'customer', 'Kanal', 'select', array['A'], 50, %L)$q$, v_sel, v_def.updated_at - interval '1 second'), '40001', 'stale definition refused');
  perform pg_temp.expect($q$select app.save_custom_field_definition(null, 'customer', ' instagram ', 'text', null, 1, null)$q$, '22023', 'duplicate label (case/space) refused');
  perform pg_temp.expect($q$select app.save_custom_field_definition(null, 'customer', 'Dup opsi', 'select', array['A','a'], 1, null)$q$, '22023', 'duplicate option refused');
  perform pg_temp.expect($q$select app.save_custom_field_definition(null, 'customer', 'Tanpa opsi', 'select', array[]::text[], 1, null)$q$, '22023', 'select without options refused');
  perform pg_temp.expect($q$select app.save_custom_field_definition(null, 'customer', 'Teks berpilihan', 'text', array['A'], 1, null)$q$, '22023', 'options on non-select refused');
  perform pg_temp.expect($q$select app.save_custom_field_definition(null, 'customer', 'Bad', 'formula', null, 1, null)$q$, '22023', 'formula type refused');
  perform pg_temp.expect($q$select app.save_custom_field_definition(null, 'vehicle', 'Bad', 'text', null, 1, null)$q$, '22023', 'unknown entity refused');
  perform pg_temp.expect($q$select app.save_custom_field_definition(null, 'customer', 'Bad', 'text', null, 10000, null)$q$, '22023', 'sort order bound enforced');

  -- Archive: hidden from new writes, value preserved, restored on unarchive.
  perform app.set_custom_field_archived(v_text, true);
  perform pg_temp.expect(format($q$select app.set_custom_field_values('customer', %L, jsonb_build_object(%L, 'new'))$q$, v_cust, v_text), '22023', 'archived definition refuses writes');
  if (select value_text from public.custom_field_values where definition_id = v_text and customer_id = v_cust) <> 'owner_ig' then
    raise exception 'FAIL archive dropped stored value'; end if;
  select * into v_def from public.custom_field_definitions where id = v_text;
  perform pg_temp.expect(format($q$select app.save_custom_field_definition(%L, null, 'Edited', null, null, 1, %L)$q$, v_text, v_def.updated_at), '22023', 'archived definition cannot be edited');
  perform app.set_custom_field_archived(v_text, false);
  perform app.set_custom_field_values('customer', v_cust, jsonb_build_object(v_text::text, 'owner_ig2'));
  raise notice 'PASS: archive hides/refuses but preserves; unarchive restores';

  -- Clearing.
  perform app.set_custom_field_values('customer', v_cust, jsonb_build_object(v_text::text, '  '));
  if exists (select 1 from public.custom_field_values where definition_id = v_text and customer_id = v_cust) then
    raise exception 'FAIL blank did not clear'; end if;
  raise notice 'PASS: blank clears a value';

  -- Pet scope.
  perform app.set_custom_field_values('pet', v_pet, jsonb_build_object(v_pet_sel::text,
    (select o ->> 'key' from public.custom_field_definitions d, jsonb_array_elements(d.options) o where d.id = v_pet_sel and o ->> 'label' = 'Makanan')));
  if (select count(*) from public.custom_field_values where pet_id = v_pet) <> 1 then raise exception 'FAIL pet value'; end if;
  perform pg_temp.expect(format($q$select app.set_custom_field_values('customer', %L, jsonb_build_object(%L, 'o1'))$q$, v_cust, v_pet_sel), '22023', 'pet definition on a customer rejected');

  -- Audit rows exist via the existing mechanism.
  perform set_config('cf.audit', (select count(*)::text from public.custom_field_values), true);
  perform set_config('cf.sel', v_sel::text, true);
  perform set_config('cf.text', v_text::text, true);
  perform set_config('cf.pet_sel', v_pet_sel::text, true);
end $$;

-- Audit trail (reads the private audit table as the table owner).
reset role;
do $$
begin
  if (select count(*) from app.audit_log where entity_table = 'custom_field_values'
        and organization_id = 'c1f00000-0000-4000-8000-000000000001') < 6
     or (select count(*) from app.audit_log where entity_table = 'custom_field_definitions'
        and organization_id = 'c1f00000-0000-4000-8000-000000000001') < 6 then
    raise exception 'FAIL custom field changes are not audited'; end if;
  raise notice 'PASS: definition and value changes audited through app.audit_log';
end $$;

-- Authority matrix.
set local role authenticated;
select pg_temp.act_as('c1f00000-0000-4000-8000-000000000022', 'c1f00000-0000-4000-8000-000000000001');
do $$
declare v_cust constant uuid := 'c1f00000-0000-4000-8000-0000000000a1';
begin
  perform pg_temp.expect($q$select app.save_custom_field_definition(null, 'customer', 'By staff', 'text', null, 1, null)$q$, '42501', 'customer.manage without settings.manage cannot define');
  perform pg_temp.expect(format($q$select app.set_custom_field_archived(%L, true)$q$, current_setting('cf.text')::uuid), '42501', 'staff cannot archive');
  perform app.set_custom_field_values('customer', v_cust, jsonb_build_object(current_setting('cf.text'), 'staff_ig'));
  if (select count(*) from public.custom_field_definitions) <> 6 then raise exception 'FAIL staff cannot read definitions'; end if;
  raise notice 'PASS: staff writes values, reads definitions, cannot define/archive';
end $$;

select pg_temp.act_as('c1f00000-0000-4000-8000-000000000023', 'c1f00000-0000-4000-8000-000000000001');
do $$
begin
  if (select count(*) from public.custom_field_definitions) <> 6 or (select count(*) from public.custom_field_values) = 0 then
    raise exception 'FAIL reader cannot read'; end if;
  perform pg_temp.expect(format($q$select app.set_custom_field_values('customer', 'c1f00000-0000-4000-8000-0000000000a1', jsonb_build_object(%L, 'x'))$q$, current_setting('cf.text')), '42501', 'reader cannot write values');
  perform pg_temp.expect($q$insert into public.custom_field_definitions(organization_id, entity_type, label, field_type) values ('c1f00000-0000-4000-8000-000000000001','customer','direct','text')$q$, '42501', 'direct definition insert denied');
  perform pg_temp.expect($q$update public.custom_field_values set value_text = 'x'$q$, '42501', 'direct value update denied');
  perform pg_temp.expect($q$delete from public.custom_field_values$q$, '42501', 'direct value delete denied');
  raise notice 'PASS: reader read-only; direct DML denied';
end $$;

select pg_temp.act_as('c1f00000-0000-4000-8000-000000000024', 'c1f00000-0000-4000-8000-000000000001');
do $$
begin
  if (select count(*) from public.custom_field_definitions) <> 0 or (select count(*) from public.custom_field_values) <> 0 then
    raise exception 'FAIL role without customer.read sees custom fields'; end if;
  perform pg_temp.expect(format($q$select app.set_custom_field_values('customer', 'c1f00000-0000-4000-8000-0000000000a1', jsonb_build_object(%L, 'x'))$q$, current_setting('cf.text')), '42501', 'role without permission cannot write');
  raise notice 'PASS: role without customer.read sees nothing';
end $$;

-- Tenant isolation: org B owner.
select pg_temp.act_as('c1f00000-0000-4000-8000-000000000025', 'c1f00000-0000-4000-8000-000000000002');
do $$
declare v_b uuid;
begin
  if (select count(*) from public.custom_field_definitions) <> 0 or (select count(*) from public.custom_field_values) <> 0 then
    raise exception 'FAIL tenant B sees tenant A fields'; end if;
  perform pg_temp.expect(format($q$select app.set_custom_field_values('customer', 'c1f00000-0000-4000-8000-0000000000b1', jsonb_build_object(%L, 'x'))$q$, current_setting('cf.text')), '22023', 'tenant B cannot use tenant A definition on its own customer');
  v_b := app.save_custom_field_definition(null, 'customer', 'Instagram', 'text', null, 1, null);
  perform pg_temp.expect(format($q$select app.set_custom_field_values('customer', 'c1f00000-0000-4000-8000-0000000000a1', jsonb_build_object(%L, 'x'))$q$, v_b), 'P0002', 'tenant B cannot write tenant A customer');
  perform pg_temp.expect(format($q$select app.set_custom_field_archived(%L, true)$q$, current_setting('cf.text')), 'P0002', 'tenant B cannot archive tenant A definition');
  perform pg_temp.expect(format($q$select app.save_custom_field_definition(%L, null, 'Hijack', null, null, 1, now())$q$, current_setting('cf.text')), 'P0002', 'tenant B cannot edit tenant A definition');
  raise notice 'PASS: tenant isolation (reads, writes, archive, edit)';
end $$;

-- Forged active org claim for a non-member is refused.
select pg_temp.act_as('c1f00000-0000-4000-8000-000000000025', 'c1f00000-0000-4000-8000-000000000001');
do $$ begin
  if (select count(*) from public.custom_field_definitions) <> 0 then raise exception 'FAIL forged org claim reads rows'; end if;
  perform pg_temp.expect($q$select app.save_custom_field_definition(null, 'customer', 'Forged', 'text', null, 1, null)$q$, '42501', 'forged active organization refused');
  raise notice 'PASS: forged organization claim refused';
end $$;

-- anon / PUBLIC have no executable surface.
reset role;
do $$
declare f text;
begin
  foreach f in array array[
    'app.save_custom_field_definition(uuid,text,text,text,text[],integer,timestamptz)',
    'app.set_custom_field_archived(uuid,boolean)',
    'app.set_custom_field_values(text,uuid,jsonb)'] loop
    if has_function_privilege('anon', f, 'execute') or has_function_privilege('public', f, 'execute')
       or not has_function_privilege('authenticated', f, 'execute') then
      raise exception 'FAIL grants for %', f; end if;
  end loop;
  if has_table_privilege('anon', 'public.custom_field_values', 'select')
     or has_table_privilege('authenticated', 'public.custom_field_values', 'insert')
     or has_table_privilege('authenticated', 'public.custom_field_definitions', 'update') then
    raise exception 'FAIL table grants'; end if;
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'app' and p.proname in ('save_custom_field_definition','set_custom_field_archived','set_custom_field_values')
                and (not p.prosecdef or p.proconfig is null or not ('search_path=""' = any (p.proconfig)))) then
    raise exception 'FAIL definer/search_path'; end if;
  raise notice 'PASS: grants, definer search_path';
end $$;

rollback;
