-- E1.3 pet coat profile + derived visit count.
-- Apply the full migration lineage, then:
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/20261029110000_test_pet_coat_profile.sql
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
  ('c2f00000-0000-4000-8000-000000000001', 'Coat A', 'coat-a-test', 'active'),
  ('c2f00000-0000-4000-8000-000000000002', 'Coat B', 'coat-b-test', 'active');
insert into public.subscriptions (organization_id, status, current_period_start, current_period_end)
  select o, 'active', now() - interval '1 day', now() + interval '1 year'
  from (values ('c2f00000-0000-4000-8000-000000000001'::uuid), ('c2f00000-0000-4000-8000-000000000002'::uuid)) t(o);
insert into public.organization_modules (organization_id, module_id, enabled, source)
  select o, m.id, true, 'override' from public.modules m,
  (values ('c2f00000-0000-4000-8000-000000000001'::uuid), ('c2f00000-0000-4000-8000-000000000002'::uuid)) t(o);
insert into public.branches (id, organization_id, name, is_default, status) values
  ('c2f00000-0000-4000-8000-0000000000e1', 'c2f00000-0000-4000-8000-000000000001', 'Main A', true, 'active'),
  ('c2f00000-0000-4000-8000-0000000000e2', 'c2f00000-0000-4000-8000-000000000002', 'Main B', true, 'active');

insert into public.roles (id, organization_id, name) values
  ('c2f00000-0000-4000-8000-000000000011', 'c2f00000-0000-4000-8000-000000000001', 'Pemilik'),
  ('c2f00000-0000-4000-8000-000000000012', 'c2f00000-0000-4000-8000-000000000001', 'Reader'),
  ('c2f00000-0000-4000-8000-000000000013', 'c2f00000-0000-4000-8000-000000000001', 'Blind'),
  ('c2f00000-0000-4000-8000-000000000014', 'c2f00000-0000-4000-8000-000000000002', 'Pemilik');
insert into public.role_permissions (organization_id, role_id, permission_id)
  select 'c2f00000-0000-4000-8000-000000000001', 'c2f00000-0000-4000-8000-000000000011', id from public.permissions where key in ('customer.manage','customer.read');
insert into public.role_permissions (organization_id, role_id, permission_id)
  select 'c2f00000-0000-4000-8000-000000000001', 'c2f00000-0000-4000-8000-000000000012', id from public.permissions where key in ('customer.read');
insert into public.role_permissions (organization_id, role_id, permission_id)
  select 'c2f00000-0000-4000-8000-000000000002', 'c2f00000-0000-4000-8000-000000000014', id from public.permissions where key in ('customer.manage','customer.read');
insert into auth.users (id, email, raw_user_meta_data) values
  ('c2f00000-0000-4000-8000-000000000021', 'owner-a@coat.test', '{}'),
  ('c2f00000-0000-4000-8000-000000000022', 'reader-a@coat.test', '{}'),
  ('c2f00000-0000-4000-8000-000000000023', 'blind-a@coat.test', '{}'),
  ('c2f00000-0000-4000-8000-000000000024', 'owner-b@coat.test', '{}');
update public.users set status = 'active' where id::text like 'c2f00000-%';
insert into public.memberships (user_id, organization_id, role_id, status) values
  ('c2f00000-0000-4000-8000-000000000021', 'c2f00000-0000-4000-8000-000000000001', 'c2f00000-0000-4000-8000-000000000011', 'active'),
  ('c2f00000-0000-4000-8000-000000000022', 'c2f00000-0000-4000-8000-000000000001', 'c2f00000-0000-4000-8000-000000000012', 'active'),
  ('c2f00000-0000-4000-8000-000000000023', 'c2f00000-0000-4000-8000-000000000001', 'c2f00000-0000-4000-8000-000000000013', 'active'),
  ('c2f00000-0000-4000-8000-000000000024', 'c2f00000-0000-4000-8000-000000000002', 'c2f00000-0000-4000-8000-000000000014', 'active');

insert into public.customers (id, organization_id, display_name) values
  ('c2f00000-0000-4000-8000-0000000000a1', 'c2f00000-0000-4000-8000-000000000001', 'Cust A'),
  ('c2f00000-0000-4000-8000-0000000000b1', 'c2f00000-0000-4000-8000-000000000002', 'Cust B');
-- p1: repeats + noise; p2: empty history; p3: archived with history; p4: only a cancelled booking; p5: org B.
insert into public.pets (id, organization_id, customer_id, name, species, weight_kg) values
  ('c2f00000-0000-4000-8000-0000000000c1', 'c2f00000-0000-4000-8000-000000000001', 'c2f00000-0000-4000-8000-0000000000a1', 'Repeat', 'dog', 7),
  ('c2f00000-0000-4000-8000-0000000000c2', 'c2f00000-0000-4000-8000-000000000001', 'c2f00000-0000-4000-8000-0000000000a1', 'Empty', 'cat', null),
  ('c2f00000-0000-4000-8000-0000000000c3', 'c2f00000-0000-4000-8000-000000000001', 'c2f00000-0000-4000-8000-0000000000a1', 'Archived', 'dog', 12),
  ('c2f00000-0000-4000-8000-0000000000c4', 'c2f00000-0000-4000-8000-000000000001', 'c2f00000-0000-4000-8000-0000000000a1', 'Cancelled', 'dog', 9),
  ('c2f00000-0000-4000-8000-0000000000c5', 'c2f00000-0000-4000-8000-000000000002', 'c2f00000-0000-4000-8000-0000000000b1', 'OrgB', 'dog', 9);

create function pg_temp.booking(p_id text, p_org text, p_branch text, p_cust text, p_status text, p_at timestamptz, p_pets text[], p_gjp_status text default 'complete')
returns void language plpgsql as $$
declare v_pet text;
begin
  insert into public.bookings (id, organization_id, branch_id, customer_id, booking_type, status, starts_at, ends_at)
  values (p_id::uuid, p_org::uuid, p_branch::uuid, p_cust::uuid, 'grooming', p_status, p_at, p_at + interval '1 hour');
  if p_pets is not null then
    insert into public.grooming_jobs (booking_id, organization_id) values (p_id::uuid, p_org::uuid);
    foreach v_pet in array p_pets loop
      insert into public.grooming_job_pets (organization_id, grooming_job_id, pet_id, status) values (p_org::uuid, p_id::uuid, v_pet::uuid, p_gjp_status);
    end loop;
  end if;
end $$;

do $$
declare
  a text := 'c2f00000-0000-4000-8000-000000000001'; br text := 'c2f00000-0000-4000-8000-0000000000e1'; cu text := 'c2f00000-0000-4000-8000-0000000000a1';
  p1 text := 'c2f00000-0000-4000-8000-0000000000c1'; p3 text := 'c2f00000-0000-4000-8000-0000000000c3'; p4 text := 'c2f00000-0000-4000-8000-0000000000c4';
begin
  -- p1: three completed visits (one multi-pet), one cancelled, one no-show, one confirmed (future), one in progress, one draft.
  perform pg_temp.booking('c2f00000-0000-4000-8000-00000000b001', a, br, cu, 'completed', '2026-01-10 09:00+07', array[p1]);
  perform pg_temp.booking('c2f00000-0000-4000-8000-00000000b002', a, br, cu, 'completed', '2026-02-10 09:00+07', array[p1, p3]);
  perform pg_temp.booking('c2f00000-0000-4000-8000-00000000b003', a, br, cu, 'completed', '2026-03-10 09:00+07', array[p1]);
  perform pg_temp.booking('c2f00000-0000-4000-8000-00000000b004', a, br, cu, 'canceled', '2026-04-10 09:00+07', array[p1]);
  perform pg_temp.booking('c2f00000-0000-4000-8000-00000000b005', a, br, cu, 'no_show', '2026-05-10 09:00+07', array[p1]);
  perform pg_temp.booking('c2f00000-0000-4000-8000-00000000b006', a, br, cu, 'confirmed', '2026-12-10 09:00+07', array[p1]);
  perform pg_temp.booking('c2f00000-0000-4000-8000-00000000b007', a, br, cu, 'in_progress', '2026-06-10 09:00+07', array[p1]);
  perform pg_temp.booking('c2f00000-0000-4000-8000-00000000b008', a, br, cu, 'draft', '2026-07-10 09:00+07', array[p1]);
  -- A completed booking where p1's own job line was skipped, and one whose line was soft-deleted: neither counts.
  perform pg_temp.booking('c2f00000-0000-4000-8000-00000000b009', a, br, cu, 'completed', '2026-08-10 09:00+07', array[p1], 'skipped');
  perform pg_temp.booking('c2f00000-0000-4000-8000-00000000b00a', a, br, cu, 'completed', '2026-09-10 09:00+07', array[p1]);
  update public.grooming_job_pets set deleted_at = now() where grooming_job_id = 'c2f00000-0000-4000-8000-00000000b00a'::uuid;
  -- A completed booking that was soft-deleted does not count.
  perform pg_temp.booking('c2f00000-0000-4000-8000-00000000b00b', a, br, cu, 'completed', '2026-09-20 09:00+07', array[p1]);
  update public.bookings set deleted_at = now() where id = 'c2f00000-0000-4000-8000-00000000b00b';
  -- p4 has only a cancelled booking.
  perform pg_temp.booking('c2f00000-0000-4000-8000-00000000b00d', a, br, cu, 'canceled', '2026-02-01 09:00+07', array[p4]);
  -- Manual (off-books) visits: p1 has 2 (one soft-deleted).
  insert into public.manual_visits (id, organization_id, branch_id, customer_id, pet_id, visit_at, description) values
    ('c2f00000-0000-4000-8000-00000000d001', a::uuid, br::uuid, cu::uuid, p1::uuid, '2026-10-05 10:00+07', 'walk-in'),
    ('c2f00000-0000-4000-8000-00000000d002', a::uuid, br::uuid, cu::uuid, p1::uuid, '2026-10-06 10:00+07', 'deleted');
  update public.manual_visits set deleted_at = now() where id = 'c2f00000-0000-4000-8000-00000000d002';
  -- Archive p3 after history exists.
  update public.pets set status = 'archived' where id = p3::uuid;
  -- Org B work for the isolation check.
  perform pg_temp.booking('c2f00000-0000-4000-8000-00000000b0b1', 'c2f00000-0000-4000-8000-000000000002', 'c2f00000-0000-4000-8000-0000000000e2',
    'c2f00000-0000-4000-8000-0000000000b1', 'completed', '2026-03-01 09:00+07', array['c2f00000-0000-4000-8000-0000000000c5']);
end $$;

-- Snapshot guard: derived reads must not touch booking/job-line data.
create temporary table before_hash as
  select md5(coalesce((select string_agg(to_jsonb(b)::text, '~' order by b.id::text) from public.bookings b), '') ||
             coalesce((select string_agg(to_jsonb(g)::text, '~' order by g.id::text) from public.grooming_job_pets g), '')) as h;
grant select on before_hash to authenticated;

set local role authenticated;
select pg_temp.act_as('c2f00000-0000-4000-8000-000000000021', 'c2f00000-0000-4000-8000-000000000001');

do $$
declare r record; v_pet_updated timestamptz; v_row record;
begin
  -- Derived counts: repeats, cancelled/no-show/draft/future/in-progress excluded, skipped & deleted lines excluded,
  -- archived pet keeps its history, empty history is zero with no last visit.
  select * into r from app.pet_visit_stats(array['c2f00000-0000-4000-8000-0000000000c1']::uuid[]);
  if r.completed_jobs <> 3 then raise exception 'FAIL repeat pet completed_jobs=% (want 3)', r.completed_jobs; end if;
  if r.manual_visits <> 1 then raise exception 'FAIL manual_visits=% (want 1)', r.manual_visits; end if;
  if r.last_visit_at <> '2026-10-05 10:00+07'::timestamptz then raise exception 'FAIL last_visit_at=%', r.last_visit_at; end if;
  raise notice 'PASS: repeats counted once each; cancelled/no-show/draft/in-progress/future/skipped/deleted excluded';

  select * into r from app.pet_visit_stats(array['c2f00000-0000-4000-8000-0000000000c2']::uuid[]);
  if r.completed_jobs <> 0 or r.manual_visits <> 0 or r.last_visit_at is not null then raise exception 'FAIL empty history: %', r; end if;
  select * into r from app.pet_visit_stats(array['c2f00000-0000-4000-8000-0000000000c3']::uuid[]);
  if r.completed_jobs <> 1 then raise exception 'FAIL archived pet history=%', r.completed_jobs; end if;
  select * into r from app.pet_visit_stats(array['c2f00000-0000-4000-8000-0000000000c4']::uuid[]);
  if r.completed_jobs <> 0 then raise exception 'FAIL cancelled-only pet counted %', r.completed_jobs; end if;
  raise notice 'PASS: empty history, archived pet, cancelled-only pet';

  -- Batch call returns one row per owned pet; another tenant's pet is silently absent (no leak, no error).
  if (select count(*) from app.pet_visit_stats(array['c2f00000-0000-4000-8000-0000000000c1','c2f00000-0000-4000-8000-0000000000c5']::uuid[])) <> 1 then
    raise exception 'FAIL cross-tenant pet leaked into stats'; end if;
  perform pg_temp.expect($q$select * from app.pet_visit_stats(null)$q$, '22023', 'null id list rejected');
  perform pg_temp.expect($q$select * from app.pet_visit_stats((select array_agg(gen_random_uuid()) from generate_series(1,101)))$q$, '22023', 'more than 100 ids rejected');
  raise notice 'PASS: tenant scoped, bounded';

  -- A pet edit cannot change the derived count (there is nothing to write) and cannot clear the coat unless asked.
  select updated_at into v_pet_updated from public.pets where id = 'c2f00000-0000-4000-8000-0000000000c1';
  select * into v_row from app.update_customer_pet('c2f00000-0000-4000-8000-0000000000c1', 'c2f00000-0000-4000-8000-0000000000a1', v_pet_updated,
    'Repeat', 'dog', 'Poodle', 'female', null, 7, null, 'Putih', 'Tenang', 'n', 'curly', E'12 Mei: kutu di telinga');
  if (select coat_type from public.pets where id = 'c2f00000-0000-4000-8000-0000000000c1') <> 'curly' then raise exception 'FAIL coat not stored'; end if;
  if (select completed_jobs from app.pet_visit_stats(array['c2f00000-0000-4000-8000-0000000000c1']::uuid[])) <> 3 then raise exception 'FAIL count changed after edit'; end if;
  raise notice 'PASS: coat + skin history stored through the guarded RPC; count unaffected by the edit';

  -- The legacy 13-argument signature preserves the stored coat profile.
  select * into v_row from app.update_customer_pet('c2f00000-0000-4000-8000-0000000000c1', 'c2f00000-0000-4000-8000-0000000000a1', v_row.updated_at,
    'Repeat', 'dog', 'Poodle', 'female', null, 7, null, 'Putih', 'Tenang', 'legacy caller');
  if (select coat_type from public.pets where id = 'c2f00000-0000-4000-8000-0000000000c1') <> 'curly'
     or (select skin_history from public.pets where id = 'c2f00000-0000-4000-8000-0000000000c1') is null then
    raise exception 'FAIL legacy signature wiped the coat profile'; end if;
  raise notice 'PASS: legacy 13-argument caller cannot wipe the coat profile';

  -- Clearing is explicit; invalid input is rejected.
  select * into v_row from app.update_customer_pet('c2f00000-0000-4000-8000-0000000000c1', 'c2f00000-0000-4000-8000-0000000000a1', v_row.updated_at,
    'Repeat', 'dog', 'Poodle', 'female', null, 7, null, 'Putih', 'Tenang', 'n', '', '');
  if (select coat_type from public.pets where id = 'c2f00000-0000-4000-8000-0000000000c1') is not null then raise exception 'FAIL coat not cleared'; end if;
  perform pg_temp.expect(format($q$select * from app.update_customer_pet(%L, %L, %L, 'Repeat','dog',null,'female',null,7,null,null,null,null,'wavy',null)$q$,
    'c2f00000-0000-4000-8000-0000000000c1', 'c2f00000-0000-4000-8000-0000000000a1', v_row.updated_at), '22023', 'unknown coat type rejected');
  perform pg_temp.expect(format($q$select * from app.update_customer_pet(%L, %L, %L, 'Repeat','dog',null,'female',null,7,null,null,null,null,null,%L)$q$,
    'c2f00000-0000-4000-8000-0000000000c1', 'c2f00000-0000-4000-8000-0000000000a1', v_row.updated_at, repeat('x', 1001)), '22023', 'overlong skin history rejected');
  perform pg_temp.expect(format($q$select * from app.update_customer_pet(%L, %L, %L, 'Repeat','dog',null,'female',null,7,null,null,null,null,'short',null)$q$,
    'c2f00000-0000-4000-8000-0000000000c1', 'c2f00000-0000-4000-8000-0000000000a1', v_row.updated_at - interval '1 second'), '40001', 'stale version rejected');
end $$;

-- A read-only role sees the count (customer.read) but cannot edit; a role without customer.read gets nothing.
select pg_temp.act_as('c2f00000-0000-4000-8000-000000000022', 'c2f00000-0000-4000-8000-000000000001');
do $$ begin
  if (select completed_jobs from app.pet_visit_stats(array['c2f00000-0000-4000-8000-0000000000c1']::uuid[])) <> 3 then raise exception 'FAIL reader count'; end if;
  perform pg_temp.expect(format($q$select * from app.update_customer_pet(%L, %L, now(),'x','dog',null,'male',null,null,null,null,null,null,'short',null)$q$,
    'c2f00000-0000-4000-8000-0000000000c1', 'c2f00000-0000-4000-8000-0000000000a1'), '42501', 'reader cannot edit coat');
  raise notice 'PASS: reader reads counts, cannot edit';
end $$;
select pg_temp.act_as('c2f00000-0000-4000-8000-000000000023', 'c2f00000-0000-4000-8000-000000000001');
do $$ begin
  perform pg_temp.expect($q$select * from app.pet_visit_stats(array['c2f00000-0000-4000-8000-0000000000c1']::uuid[])$q$, '42501', 'role without customer.read denied');
end $$;
select pg_temp.act_as('c2f00000-0000-4000-8000-000000000024', 'c2f00000-0000-4000-8000-000000000002');
do $$ begin
  if (select count(*) from app.pet_visit_stats(array['c2f00000-0000-4000-8000-0000000000c1']::uuid[])) <> 0 then raise exception 'FAIL org B read org A pet stats'; end if;
  if (select completed_jobs from app.pet_visit_stats(array['c2f00000-0000-4000-8000-0000000000c5']::uuid[])) <> 1 then raise exception 'FAIL org B own pet'; end if;
  perform pg_temp.expect(format($q$select * from app.update_customer_pet(%L, %L, now(),'x','dog',null,'male',null,null,null,null,null,null,'short',null)$q$,
    'c2f00000-0000-4000-8000-0000000000c1', 'c2f00000-0000-4000-8000-0000000000a1'), 'P0002', 'org B cannot edit org A pet');
  raise notice 'PASS: tenant isolation for stats and edits';
end $$;

-- Immutable history untouched.
reset role;
do $$ begin
  if (select h from before_hash) is distinct from md5(coalesce((select string_agg(to_jsonb(b)::text, '~' order by b.id::text) from public.bookings b), '') ||
       coalesce((select string_agg(to_jsonb(g)::text, '~' order by g.id::text) from public.grooming_job_pets g), '')) then
    raise exception 'FAIL booking/job-line data changed'; end if;
  if exists (select 1 from pg_attribute where attrelid = 'public.pets'::regclass and attname ~ '(wash|visit).*(count|total)' and not attisdropped) then
    raise exception 'FAIL a stored counter column exists on pets'; end if;
  if has_function_privilege('anon', 'app.pet_visit_stats(uuid[])', 'execute') or has_function_privilege('public', 'app.pet_visit_stats(uuid[])', 'execute')
     or has_function_privilege('anon', 'app.update_customer_pet(uuid,uuid,timestamptz,text,text,text,text,date,numeric,text,text,text,text,text,text)', 'execute') then
    raise exception 'FAIL grants'; end if;
  raise notice 'PASS: snapshots untouched, no stored counter, anon/public have no access';
end $$;

rollback;
