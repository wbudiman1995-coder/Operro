-- =====================================================================
-- TEST — 20260721001350 grooming assembly operations. EXECUTED (PG 16.14).
-- Covers correction items 1,2,3,4,8 (item 7 concurrency is a separate 2-session
-- harness; item 5/6 are app-tier). Owner + authenticated-role paths.
-- Run: apply 0001..0013 + 01350, then psql -v ON_ERROR_STOP=1 -f this_file
-- =====================================================================
\set ON_ERROR_STOP on
create or replace function pg_temp.ok(cond boolean,label text)
returns void language plpgsql as $$
begin if cond then raise notice 'PASS: %',label; else raise exception 'FAIL: %',label; end if; end $$;
create or replace function pg_temp.act_as(u text,o text) returns void language plpgsql as $$
begin perform set_config('request.jwt.claims',json_build_object('sub',u,'active_org_id',o)::text,true); end $$;

begin;

-- fixtures: org, branch, owner(branches.all via role), TWO customers + their pets,
-- an active + an inactive + a soft-deleted service, a groomer resource, a booking
-- for customer 1, and a package for reservation tests.
insert into public.organizations (id,name,slug,status) values
  ('0f000000-0000-4000-8000-000000000001','A2 Org','a2-org','active');
insert into public.branches (id,organization_id,name,is_default,status) values
  ('0f000000-0000-4000-8000-0000000000a1','0f000000-0000-4000-8000-000000000001','Main',true,'active');
insert into auth.users (id) values ('0f000000-0000-4000-8000-0000000000c1') on conflict (id) do nothing;
insert into public.users (id,full_name,email,status) values
  ('0f000000-0000-4000-8000-0000000000c1','Owner','o@a2.test','active') on conflict (id) do update set full_name=excluded.full_name,email=excluded.email,status=excluded.status;
insert into public.roles (id,organization_id,name,is_system) values
  ('0f000000-0000-4000-8000-0000000000e1','0f000000-0000-4000-8000-000000000001','Owner',true);
insert into public.memberships (id,organization_id,user_id,role_id,status) values
  ('0f000000-0000-4000-8000-0000000000d1','0f000000-0000-4000-8000-000000000001','0f000000-0000-4000-8000-0000000000c1','0f000000-0000-4000-8000-0000000000e1','active');
insert into public.membership_branch_access (organization_id,membership_id,branch_id) values
  ('0f000000-0000-4000-8000-000000000001','0f000000-0000-4000-8000-0000000000d1','0f000000-0000-4000-8000-0000000000a1');
insert into public.permissions (id,key,resource,action,description) values
  ('0f000000-0000-4000-8000-0000000000f8','booking.read','booking','read','r'),
  ('0f000000-0000-4000-8000-0000000000f9','booking.update','booking','update','u'),
  ('0f000000-0000-4000-8000-0000000000fa','branches.all','branches','all','a'),
  ('0f000000-0000-4000-8000-0000000000fb','membership.read','membership','read','m')
  on conflict (key) do nothing;
insert into public.role_permissions (organization_id,role_id,permission_id)
  select '0f000000-0000-4000-8000-000000000001','0f000000-0000-4000-8000-0000000000e1',p.id
  from public.permissions p where p.key in ('booking.read','booking.update','branches.all','membership.read');
insert into public.organization_modules (organization_id,module_id,enabled)
  select '0f000000-0000-4000-8000-000000000001',m.id,true from public.modules m where m.key in ('scheduling','membership')
  on conflict (organization_id,module_id) do update set enabled=true;
insert into public.subscriptions (organization_id,status) values ('0f000000-0000-4000-8000-000000000001','active') on conflict do nothing;
-- two customers
insert into public.customers (id,organization_id,display_name) values
  ('0f000000-0000-4000-8000-00000000c101','0f000000-0000-4000-8000-000000000001','Cust1'),
  ('0f000000-0000-4000-8000-00000000c102','0f000000-0000-4000-8000-000000000001','Cust2');
-- pets: p1 owned by cust1, p2 owned by cust2
insert into public.pets (id,organization_id,customer_id,name) values
  ('0f000000-0000-4000-8000-00000000f101','0f000000-0000-4000-8000-000000000001','0f000000-0000-4000-8000-00000000c101','Pet1'),
  ('0f000000-0000-4000-8000-00000000f102','0f000000-0000-4000-8000-000000000001','0f000000-0000-4000-8000-00000000c102','Pet2'),
  ('0f000000-0000-4000-8000-00000000f103','0f000000-0000-4000-8000-000000000001','0f000000-0000-4000-8000-00000000c101','Pet3');
-- services: active(dur=90), inactive, soft-deleted
insert into public.service_catalog (id,organization_id,name,base_price,currency,duration_minutes,is_active) values
  ('0f000000-0000-4000-8000-00000000501a','0f000000-0000-4000-8000-000000000001','Bath',100,'USD',90,true),
  ('0f000000-0000-4000-8000-00000000501b','0f000000-0000-4000-8000-000000000001','Inactive',100,'USD',30,false);
insert into public.service_catalog (id,organization_id,name,base_price,currency,duration_minutes,is_active,deleted_at) values
  ('0f000000-0000-4000-8000-00000000501c','0f000000-0000-4000-8000-000000000001','Deleted',100,'USD',30,true,now());
-- groomer resources: active + retired
insert into public.branches (id,organization_id,name,is_default,status) values
  ('0f000000-0000-4000-8000-0000000000b2','0f000000-0000-4000-8000-000000000001','BranchB',false,'active');
insert into public.resources (id,organization_id,branch_id,kind,name,capacity,status,membership_id) values
  ('0f000000-0000-4000-8000-0000000e5001','0f000000-0000-4000-8000-000000000001','0f000000-0000-4000-8000-0000000000a1','staff','Groomer',1,'active','0f000000-0000-4000-8000-0000000000d1'),
  ('0f000000-0000-4000-8000-0000000e5002','0f000000-0000-4000-8000-000000000001','0f000000-0000-4000-8000-0000000000a1','staff','Retired',1,'retired',null),
  ('0f000000-0000-4000-8000-0000000e5003','0f000000-0000-4000-8000-000000000001','0f000000-0000-4000-8000-0000000000b2','staff','OtherBranch',1,'active',null);
-- booking for customer 1
insert into public.bookings (id,organization_id,branch_id,customer_id,booking_type,status,starts_at,ends_at) values
  ('0f000000-0000-4000-8000-00000000ba01','0f000000-0000-4000-8000-000000000001','0f000000-0000-4000-8000-0000000000a1','0f000000-0000-4000-8000-00000000c101','grooming','confirmed',now(),now()+interval '2h');
-- package (3 sessions) for reservation tests
insert into public.packages (id,organization_id,name,service_id,total_sessions,price,currency) values
  ('0f000000-0000-4000-8000-00000000a001','0f000000-0000-4000-8000-000000000001','3pk','0f000000-0000-4000-8000-00000000501a',3,240,'USD');
insert into public.customer_packages (id,organization_id,customer_id,package_id,service_id,status) values
  ('0f000000-0000-4000-8000-00000000ca01','0f000000-0000-4000-8000-000000000001','0f000000-0000-4000-8000-00000000c101','0f000000-0000-4000-8000-00000000a001','0f000000-0000-4000-8000-00000000501a','active');
insert into public.customer_package_ledger (organization_id,customer_package_id,delta,reason) values
  ('0f000000-0000-4000-8000-000000000001','0f000000-0000-4000-8000-00000000ca01',3,'purchase');

do $$ begin perform pg_temp.act_as('0f000000-0000-4000-8000-0000000000c1','0f000000-0000-4000-8000-000000000001'); end $$;

-- ITEM 1: pet ownership
do $$ declare v uuid; begin
  v := app.assembly_add_pet('0f000000-0000-4000-8000-00000000ba01','0f000000-0000-4000-8000-00000000f101',true);
  perform pg_temp.ok(v is not null,'C1 add_pet accepts pet owned by booking customer');
end $$;
do $$ begin
  begin
    perform app.assembly_add_pet('0f000000-0000-4000-8000-00000000ba01','0f000000-0000-4000-8000-00000000f102',true);
    perform pg_temp.ok(false,'C2 cross-customer pet should be rejected');
  exception when check_violation then
    perform pg_temp.ok(sqlerrm like '%pet_customer_mismatch%','C2 cross-customer pet rejected pet_customer_mismatch');
  end;
end $$;

-- ITEM 3: service validation + duration snapshot
do $$ declare v_pet uuid; v_line uuid; begin
  select id into v_pet from public.grooming_job_pets where grooming_job_id='0f000000-0000-4000-8000-00000000ba01' and pet_id='0f000000-0000-4000-8000-00000000f101';
  v_line := app.assembly_add_line(v_pet,'0f000000-0000-4000-8000-00000000501a',1);
  perform pg_temp.ok((select duration_minutes from public.grooming_job_pet_services where id=v_line)=90,
    'C3 add_line snapshots catalog duration 90 (not default 60)');
end $$;
do $$ declare v_pet uuid; begin
  select id into v_pet from public.grooming_job_pets where grooming_job_id='0f000000-0000-4000-8000-00000000ba01' and pet_id='0f000000-0000-4000-8000-00000000f101';
  begin perform app.assembly_add_line(v_pet,'0f000000-0000-4000-8000-00000000501b',1);
    perform pg_temp.ok(false,'C4 inactive service should be rejected');
  exception when check_violation then perform pg_temp.ok(true,'C4 inactive service rejected'); end;
  begin perform app.assembly_add_line(v_pet,'0f000000-0000-4000-8000-00000000501c',1);
    perform pg_temp.ok(false,'C5 deleted service should be rejected');
  exception when check_violation then perform pg_temp.ok(true,'C5 soft-deleted service rejected'); end;
end $$;

-- ITEM 4: per-pet groomer assignment
do $$ declare v_pet uuid; begin
  select id into v_pet from public.grooming_job_pets where grooming_job_id='0f000000-0000-4000-8000-00000000ba01' and pet_id='0f000000-0000-4000-8000-00000000f101';
  perform app.assembly_assign_pet_resource(v_pet,'0f000000-0000-4000-8000-0000000e5001');
  perform pg_temp.ok((select assigned_resource_id from public.grooming_job_pets where id=v_pet)='0f000000-0000-4000-8000-0000000e5001',
    'C6 assign_pet_resource sets the groomer');
  -- reassign -> audit event reassigned
  perform app.assembly_assign_pet_resource(v_pet,'0f000000-0000-4000-8000-0000000e5001');
  perform pg_temp.ok((select count(*) from public.timeline_events where subject_id='0f000000-0000-4000-8000-00000000ba01' and event_type='grooming.pet_resource_reassigned')>=1,
    'C7 reassignment writes a reassigned audit event');
  begin perform app.assembly_assign_pet_resource(v_pet,'0f000000-0000-4000-8000-0000000e5002');
    perform pg_temp.ok(false,'C8 retired resource should be rejected');
  exception when check_violation then perform pg_temp.ok(true,'C8 retired/inactive resource rejected'); end;
  -- blocker 3: a resource in ANOTHER branch (active, same org) must be rejected.
  begin perform app.assembly_assign_pet_resource(v_pet,'0f000000-0000-4000-8000-0000000e5003');
    perform pg_temp.ok(false,'C8b cross-branch resource should be rejected');
  exception when check_violation then perform pg_temp.ok(sqlerrm like '%not_active_or_not_in_branch%','C8b cross-branch resource rejected (not_active_or_not_in_branch)'); end;
end $$;

-- ITEM 8: package quantity semantics
do $$ declare v_pet uuid; v_line_q2 uuid; v_line_q1 uuid; v_res uuid; begin
  select id into v_pet from public.grooming_job_pets where grooming_job_id='0f000000-0000-4000-8000-00000000ba01' and pet_id='0f000000-0000-4000-8000-00000000f101';
  -- a quantity-2 line cannot be package-reserved
  v_line_q2 := app.assembly_add_line(v_pet,'0f000000-0000-4000-8000-00000000501a',2);
  begin perform app.reserve_package_session(v_line_q2,'0f000000-0000-4000-8000-00000000ca01');
    perform pg_temp.ok(false,'C9 reserving a qty<>1 line should be rejected');
  exception when check_violation then perform pg_temp.ok(sqlerrm like '%package_requires_unit_quantity%','C9 reserve rejects qty<>1 line (package_requires_unit_quantity)'); end;
  -- a quantity-1 line can be reserved; then its quantity cannot be changed
  v_line_q1 := app.assembly_add_line(v_pet,'0f000000-0000-4000-8000-00000000501a',1);
  v_res := app.reserve_package_session(v_line_q1,'0f000000-0000-4000-8000-00000000ca01');
  perform pg_temp.ok(v_res is not null,'C10 qty=1 line reserves a package session');
  begin perform app.assembly_set_line_quantity(v_line_q1,2);
    perform pg_temp.ok(false,'C11 changing qty of a reserved line should be rejected');
  exception when check_violation then perform pg_temp.ok(sqlerrm like '%line_has_package_reservation%','C11 set_qty rejects line with package reservation (any status)'); end;
end $$;

-- ITEM 2: remove_pet releases reservations + idempotent
do $$ declare v_avail_before int; v_avail_after int; v_pet uuid; begin
  select id into v_pet from public.grooming_job_pets where grooming_job_id='0f000000-0000-4000-8000-00000000ba01' and pet_id='0f000000-0000-4000-8000-00000000f101';
  v_avail_before := app.fn_package_available_sessions('0f000000-0000-4000-8000-000000000001','0f000000-0000-4000-8000-00000000ca01');
  perform pg_temp.ok(v_avail_before=2,'C12 availability is 2 (1 reserved of 3) before removal');
  perform app.assembly_remove_pet(v_pet,'test removal');
  v_avail_after := app.fn_package_available_sessions('0f000000-0000-4000-8000-000000000001','0f000000-0000-4000-8000-00000000ca01');
  perform pg_temp.ok(v_avail_after=3,'C13 remove_pet released the reservation; availability back to 3');
  perform pg_temp.ok((select status from public.package_reservations where grooming_job_pet_service_id in
      (select id from public.grooming_job_pet_services where grooming_job_pet_id=v_pet))='released',
    'C14 reservation row preserved with status released');
  -- repeated removal cannot double-release (pet already soft-deleted -> pet_not_found)
  begin perform app.assembly_remove_pet(v_pet,'again');
    perform pg_temp.ok(false,'C15 repeated removal should fail (already removed)');
  exception when no_data_found then perform pg_temp.ok(true,'C15 repeated removal cannot double-release (pet_not_found)'); end;
end $$;

-- ITEM 6: pet removal is permanent for v1 — re-adding a removed pet raises the
-- stable pet_removal_is_permanent error (not a raw 23505 unique violation).
do $$ begin
  begin
    perform app.assembly_add_pet('0f000000-0000-4000-8000-00000000ba01','0f000000-0000-4000-8000-00000000f101',true);
    perform pg_temp.ok(false,'C16 re-adding a removed pet should be rejected');
  exception
    when check_violation then perform pg_temp.ok(sqlerrm like '%pet_removal_is_permanent%','C16 re-adding a removed pet raises stable pet_removal_is_permanent');
    when unique_violation then perform pg_temp.ok(false,'C16 leaked raw unique violation instead of stable error');
  end;
end $$;

rollback;
-- END 20260721001350_test_assembly
