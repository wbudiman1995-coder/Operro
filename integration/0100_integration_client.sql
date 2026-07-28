-- Runs AS authenticated (via authenticator SET ROLE). One PostgREST-style
-- request per transaction. Proves the assembly RPCs work through the real role.
\set ON_ERROR_STOP on
create or replace function pg_temp.ok(cond boolean,label text)
returns void language plpgsql as $$
begin if cond then raise notice 'PASS: %',label; else raise exception 'FAIL: %',label; end if; end $$;

-- add a pet via RPC
begin;
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub','0e000000-0000-4000-8000-0000000000c1','role','authenticated',
                    'active_org_id','0e000000-0000-4000-8000-000000000001')::text,true);
select pg_temp.ok(
  app.assembly_add_pet('0e000000-0000-4000-8000-00000000ba01','0e000000-0000-4000-8000-0000000000f1',true) is not null,
  'I1 authenticated can assembly_add_pet via RPC');
commit;

-- add a line via RPC, then confirm it is visible through RLS
begin;
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub','0e000000-0000-4000-8000-0000000000c1','role','authenticated',
                    'active_org_id','0e000000-0000-4000-8000-000000000001')::text,true);
do $$
declare v_pet uuid; v_line uuid;
begin
  select id into v_pet from public.grooming_job_pets
   where grooming_job_id='0e000000-0000-4000-8000-00000000ba01' and pet_id='0e000000-0000-4000-8000-0000000000f1';
  v_line := app.assembly_add_line(v_pet,'0e000000-0000-4000-8000-000000005001',2);
  perform pg_temp.ok(v_line is not null,'I2 authenticated can assembly_add_line via RPC');
  perform pg_temp.ok(
    (select quantity from public.grooming_job_pet_services where id=v_line)=2,
    'I3 line visible via RLS with quantity 2');
end $$;
commit;

-- direct table writes STILL blocked for authenticated (0013 lockdown holds)
begin;
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub','0e000000-0000-4000-8000-0000000000c1','role','authenticated',
                    'active_org_id','0e000000-0000-4000-8000-000000000001')::text,true);
do $$
declare v_line uuid;
begin
  select gjps.id into v_line from public.grooming_job_pet_services gjps
   join public.grooming_job_pets gjp on gjp.id=gjps.grooming_job_pet_id
   where gjp.grooming_job_id='0e000000-0000-4000-8000-00000000ba01' limit 1;
  begin
    execute format('update public.grooming_job_pet_services set quantity=1 where id=%L',v_line);
    perform pg_temp.ok(false,'I4 direct quantity UPDATE should be blocked');
  exception when insufficient_privilege then
    perform pg_temp.ok(true,'I4 direct quantity UPDATE still blocked under real authenticated role');
  end;
  -- but the RPC path works:
  perform app.assembly_set_line_quantity(v_line,4);
  perform pg_temp.ok(
    (select quantity from public.grooming_job_pet_services where id=v_line)=4,
    'I5 assembly_set_line_quantity via RPC works under real role');
end $$;
commit;

-- cross-customer pet rejected through the real role
begin;
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub','0e000000-0000-4000-8000-0000000000c1','role','authenticated',
                    'active_org_id','0e000000-0000-4000-8000-000000000001')::text,true);
do $$ begin
  begin
    perform app.assembly_add_pet('0e000000-0000-4000-8000-00000000ba01','0e000000-0000-4000-8000-0000000000f2',true);
    perform pg_temp.ok(false,'I6 cross-customer pet should be rejected');
  exception when check_violation then perform pg_temp.ok(sqlerrm like '%pet_customer_mismatch%','I6 cross-customer pet rejected (pet_customer_mismatch) under real role');
  end;
end $$;
commit;

-- per-pet groomer assignment through the real role
begin;
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub','0e000000-0000-4000-8000-0000000000c1','role','authenticated',
                    'active_org_id','0e000000-0000-4000-8000-000000000001')::text,true);
do $$ declare v_pet uuid; begin
  select id into v_pet from public.grooming_job_pets
   where grooming_job_id='0e000000-0000-4000-8000-00000000ba01' and pet_id='0e000000-0000-4000-8000-0000000000f1';
  perform app.assembly_assign_pet_resource(v_pet,'0e000000-0000-4000-8000-0000000e5001');
  perform pg_temp.ok(
    (select assigned_resource_id from public.grooming_job_pets where id=v_pet)='0e000000-0000-4000-8000-0000000e5001',
    'I7 assembly_assign_pet_resource works under real authenticated role');
end $$;
commit;

-- I8/I9/I10/I11 — reserve_package_session through the REAL authenticated role
-- (item 1): proves the authenticated EXECUTE grant + role behavior, RLS
-- visibility, and correct org/line/package/status. Adds a fresh pet + qty-1
-- Bath line, reserves a session, then asserts the row and its visibility.
begin;
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub','0e000000-0000-4000-8000-0000000000c1','role','authenticated',
                    'active_org_id','0e000000-0000-4000-8000-000000000001')::text,true);
do $$
declare v_pet uuid; v_line uuid; v_res uuid; r record;
begin
  -- ResPet (owned by booking customer f0) is seeded by the owner; the client
  -- only assembles via RPCs (direct table writes are correctly blocked by RLS).
  v_pet := app.assembly_add_pet('0e000000-0000-4000-8000-00000000ba01','0e000000-0000-4000-8000-0000000000f9',true);
  v_line := app.assembly_add_line(v_pet,'0e000000-0000-4000-8000-000000005001',1);

  -- reserve via the RPC AS authenticated (proves EXECUTE grant + role behavior)
  v_res := app.reserve_package_session(v_line,'0e000000-0000-4000-8000-0000000ca001');
  perform pg_temp.ok(v_res is not null,'I8 authenticated can reserve_package_session via RPC (EXECUTE grant works)');

  -- visible through RLS as the authenticated role
  perform pg_temp.ok(
    exists (select 1 from public.package_reservations where id=v_res),
    'I9 reservation visible through RLS as authenticated');

  -- org / line / package / status all correct
  select * into r from public.package_reservations where id=v_res;
  perform pg_temp.ok(
    r.organization_id='0e000000-0000-4000-8000-000000000001'
    and r.grooming_job_pet_service_id=v_line
    and r.customer_package_id='0e000000-0000-4000-8000-0000000ca001'
    and r.status='reserved',
    'I10 reservation org/line/package/status are correct');

  -- availability decremented (3 sessions - 1 reserved = 2), via the client RPC
  perform pg_temp.ok(
    app.package_available_sessions('0e000000-0000-4000-8000-0000000ca001')=2,
    'I11 availability decremented to 2 after reservation (authenticated read RPC)');
end $$;
commit;
