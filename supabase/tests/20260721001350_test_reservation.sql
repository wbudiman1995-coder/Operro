-- =====================================================================
-- TEST — package-reservation regression (blocker 6). EXECUTED (PG 16.14).
-- Proves the 01350 reserve_package_session preserves ALL frozen-0013
-- protections and adds quantity=1 + booking-lifecycle serialization, and that
-- set_line_quantity is rejected across the full reservation lifecycle.
-- Run: apply full lineage, then psql -v ON_ERROR_STOP=1 -f this_file
-- =====================================================================
\set ON_ERROR_STOP on
create or replace function pg_temp.ok(cond boolean,label text)
returns void language plpgsql as $$
begin if cond then raise notice 'PASS: %',label; else raise exception 'FAIL: %',label; end if; end $$;
create or replace function pg_temp.act_as(u text,o text) returns void language plpgsql as $$
begin perform set_config('request.jwt.claims',json_build_object('sub',u,'active_org_id',o)::text,true); end $$;

begin;
-- fixtures
insert into public.organizations (id,name,slug,status) values ('01000000-0000-4000-8000-000000000001','R Org','r-org','active');
insert into public.branches (id,organization_id,name,is_default,status) values ('01000000-0000-4000-8000-0000000000a1','01000000-0000-4000-8000-000000000001','Main',true,'active');
insert into auth.users (id) values ('01000000-0000-4000-8000-0000000000c1') on conflict (id) do nothing;
insert into public.users (id,full_name,email,status) values ('01000000-0000-4000-8000-0000000000c1','O','o@r.test','active') on conflict (id) do update set full_name=excluded.full_name,email=excluded.email,status=excluded.status;
insert into public.roles (id,organization_id,name,is_system) values ('01000000-0000-4000-8000-0000000000e1','01000000-0000-4000-8000-000000000001','Owner',true);
insert into public.memberships (id,organization_id,user_id,role_id,status) values ('01000000-0000-4000-8000-0000000000d1','01000000-0000-4000-8000-000000000001','01000000-0000-4000-8000-0000000000c1','01000000-0000-4000-8000-0000000000e1','active');
insert into public.membership_branch_access (organization_id,membership_id,branch_id) values ('01000000-0000-4000-8000-000000000001','01000000-0000-4000-8000-0000000000d1','01000000-0000-4000-8000-0000000000a1');
insert into public.permissions (id,key,resource,action,description) values
  ('01000000-0000-4000-8000-0000000000f1','booking.read','booking','read','r'),
  ('01000000-0000-4000-8000-0000000000f2','booking.update','booking','update','u'),
  ('01000000-0000-4000-8000-0000000000f3','booking.complete','booking','complete','c'),
  ('01000000-0000-4000-8000-0000000000f4','membership.read','membership','read','m') on conflict (key) do nothing;
insert into public.role_permissions (organization_id,role_id,permission_id)
  select '01000000-0000-4000-8000-000000000001','01000000-0000-4000-8000-0000000000e1',p.id from public.permissions p
  where p.key in ('booking.read','booking.update','booking.complete','membership.read');
insert into public.organization_modules (organization_id,module_id,enabled)
  select '01000000-0000-4000-8000-000000000001',m.id,true from public.modules m where m.key in ('scheduling','membership')
  on conflict (organization_id,module_id) do update set enabled=true;
insert into public.subscriptions (organization_id,status) values ('01000000-0000-4000-8000-000000000001','active') on conflict do nothing;
insert into public.customers (id,organization_id,display_name) values
  ('01000000-0000-4000-8000-00000000c101','01000000-0000-4000-8000-000000000001','Cust1'),
  ('01000000-0000-4000-8000-00000000c102','01000000-0000-4000-8000-000000000001','Cust2');
insert into public.pets (id,organization_id,customer_id,name) values ('01000000-0000-4000-8000-00000000f101','01000000-0000-4000-8000-000000000001','01000000-0000-4000-8000-00000000c101','Pet1');
insert into public.service_catalog (id,organization_id,name,base_price,currency,duration_minutes,is_active) values
  ('01000000-0000-4000-8000-000000005001','01000000-0000-4000-8000-000000000001','Bath',100,'USD',60,true),
  ('01000000-0000-4000-8000-000000005002','01000000-0000-4000-8000-000000000001','Nails',40,'USD',20,true);
insert into public.bookings (id,organization_id,branch_id,customer_id,booking_type,status,starts_at,ends_at) values
  ('01000000-0000-4000-8000-00000000ba01','01000000-0000-4000-8000-000000000001','01000000-0000-4000-8000-0000000000a1','01000000-0000-4000-8000-00000000c101','grooming','confirmed',now(),now()+interval '2h');
-- packages: active (svc=Bath, 3), expired, service-specific to Nails, customer2's
insert into public.packages (id,organization_id,name,service_id,total_sessions,price,currency) values
  ('01000000-0000-4000-8000-00000000a001','01000000-0000-4000-8000-000000000001','Bath3','01000000-0000-4000-8000-000000005001',3,240,'USD');
insert into public.customer_packages (id,organization_id,customer_id,package_id,service_id,status,expires_at) values
  ('01000000-0000-4000-8000-0000000ca001','01000000-0000-4000-8000-000000000001','01000000-0000-4000-8000-00000000c101','01000000-0000-4000-8000-00000000a001','01000000-0000-4000-8000-000000005001','active',null),
  ('01000000-0000-4000-8000-0000000ca002','01000000-0000-4000-8000-000000000001','01000000-0000-4000-8000-00000000c101','01000000-0000-4000-8000-00000000a001','01000000-0000-4000-8000-000000005001','active',now()-interval '1 day'),
  ('01000000-0000-4000-8000-0000000ca003','01000000-0000-4000-8000-000000000001','01000000-0000-4000-8000-00000000c101','01000000-0000-4000-8000-00000000a001','01000000-0000-4000-8000-000000005002','active',null),
  ('01000000-0000-4000-8000-0000000ca004','01000000-0000-4000-8000-000000000001','01000000-0000-4000-8000-00000000c102','01000000-0000-4000-8000-00000000a001','01000000-0000-4000-8000-000000005001','active',null),
  ('01000000-0000-4000-8000-0000000ca005','01000000-0000-4000-8000-000000000001','01000000-0000-4000-8000-00000000c101','01000000-0000-4000-8000-00000000a001','01000000-0000-4000-8000-000000005001','active',null);
insert into public.customer_package_ledger (organization_id,customer_package_id,delta,reason) values
  ('01000000-0000-4000-8000-000000000001','01000000-0000-4000-8000-0000000ca001',3,'purchase'),
  ('01000000-0000-4000-8000-000000000001','01000000-0000-4000-8000-0000000ca002',3,'purchase'),
  ('01000000-0000-4000-8000-000000000001','01000000-0000-4000-8000-0000000ca003',3,'purchase'),
  ('01000000-0000-4000-8000-000000000001','01000000-0000-4000-8000-0000000ca004',3,'purchase'),
  ('01000000-0000-4000-8000-000000000001','01000000-0000-4000-8000-0000000ca005',3,'purchase');

do $$ begin perform pg_temp.act_as('01000000-0000-4000-8000-0000000000c1','01000000-0000-4000-8000-000000000001'); end $$;

-- helper: create a NEW pet row (unique id), add it to the booking, add a line of
-- the given quantity, return the line id. Each call uses a distinct pet so the
-- one-active-pet-per-booking rule is never violated.
create sequence if not exists pg_temp.petseq;
create or replace function pg_temp.new_line(p_qty int, p_service uuid default '01000000-0000-4000-8000-000000005001')
returns uuid language plpgsql as $$
declare v_petid uuid; v_gjp uuid; v_line uuid; n int; begin
  n := nextval('pg_temp.petseq');
  v_petid := ('01000000-0000-4000-8000-' || lpad(to_hex(700000+n),12,'0'))::uuid;
  insert into public.pets (id,organization_id,customer_id,name)
    values (v_petid,'01000000-0000-4000-8000-000000000001','01000000-0000-4000-8000-00000000c101','P'||n);
  v_gjp := app.assembly_add_pet('01000000-0000-4000-8000-00000000ba01',v_petid,true);
  v_line := app.assembly_add_line(v_gjp,p_service,p_qty);
  return v_line;
end; $$;

-- R1 quantity<>1 rejected
do $$ declare l uuid; begin
  -- one pet can hold multiple lines; add a qty=2 line on a fresh pet
  l := pg_temp.new_line(2);
  begin perform app.reserve_package_session(l,'01000000-0000-4000-8000-0000000ca001');
    perform pg_temp.ok(false,'R1 qty<>1 should be rejected');
  exception when check_violation then perform pg_temp.ok(sqlerrm like '%package_requires_unit_quantity%','R1 qty<>1 rejected (package_requires_unit_quantity)'); end;
end $$;

-- R2 qty=1 accepted
do $$ declare l uuid; r uuid; begin
  l := pg_temp.new_line(1);
  r := app.reserve_package_session(l,'01000000-0000-4000-8000-0000000ca001');
  perform pg_temp.ok(r is not null,'R2 qty=1 accepted');
end $$;

-- R3 expired package rejected
do $$ declare l uuid; begin
  l := pg_temp.new_line(1);
  begin perform app.reserve_package_session(l,'01000000-0000-4000-8000-0000000ca002');
    perform pg_temp.ok(false,'R3 expired package should be rejected');
  exception when check_violation then perform pg_temp.ok(sqlerrm like '%package_expired%','R3 expired package rejected (package_expired)'); end;
end $$;

-- R4 service mismatch rejected (package is for Nails, line is Bath)
do $$ declare l uuid; begin
  l := pg_temp.new_line(1);  -- bath line
  begin perform app.reserve_package_session(l,'01000000-0000-4000-8000-0000000ca003');
    perform pg_temp.ok(false,'R4 service mismatch should be rejected');
  exception when check_violation then perform pg_temp.ok(sqlerrm like '%package_not_applicable_to_service%','R4 service mismatch rejected'); end;
end $$;

-- R5 customer mismatch rejected (package belongs to cust2, booking is cust1)
do $$ declare l uuid; begin
  l := pg_temp.new_line(1);
  begin perform app.reserve_package_session(l,'01000000-0000-4000-8000-0000000ca004');
    perform pg_temp.ok(false,'R5 customer mismatch should be rejected');
  exception when check_violation then perform pg_temp.ok(sqlerrm like '%package_customer_mismatch%','R5 customer mismatch rejected'); end;
end $$;

-- R6 package not found rejected
do $$ declare l uuid; begin
  l := pg_temp.new_line(1);
  begin perform app.reserve_package_session(l,'01000000-0000-4000-8000-0000000cffff');
    perform pg_temp.ok(false,'R6 missing package should be rejected');
  exception when no_data_found then perform pg_temp.ok(sqlerrm like '%package_not_found%','R6 missing package rejected (package_not_found)'); end;
end $$;

-- R7 stale-hold expiration before availability calc (blocker 3). Fully subscribe
-- a 3-session package with THREE reserved rows, then age ALL of them to
-- expired-by-time while their stored status stays 'reserved'. Before expiration
-- processing availability is 0 (three active holds). A new reserve must first
-- run expire_package_reservations (flipping the 3 to 'expired'), see 3 free, and
-- succeed. This FAILS if the expire call is removed from reserve_package_session
-- (the package would still read 0 available and raise no_sessions_available).
do $$
declare l1 uuid; l2 uuid; l3 uuid; l_new uuid; v_before int; v_after int;
        v_expired int; v_new_status text; r_new uuid;
begin
  -- three qty-1 lines, each reserving one session (package now fully held)
  l1 := pg_temp.new_line(1); perform app.reserve_package_session(l1,'01000000-0000-4000-8000-0000000ca005');
  l2 := pg_temp.new_line(1); perform app.reserve_package_session(l2,'01000000-0000-4000-8000-0000000ca005');
  l3 := pg_temp.new_line(1); perform app.reserve_package_session(l3,'01000000-0000-4000-8000-0000000ca005');
  perform pg_temp.ok(
    (select count(*) from public.package_reservations
      where customer_package_id='01000000-0000-4000-8000-0000000ca005' and status='reserved')=3,
    'R7a exactly three reserved lifecycle rows exist');

  -- age ALL three to expired-by-time, but leave stored status = 'reserved'
  update public.package_reservations set expires_at = now() - interval '1 hour'
    where customer_package_id='01000000-0000-4000-8000-0000000ca005' and status='reserved';

  -- BEFORE expiration processing: availability is 0 (three active holds counted)
  v_before := app.fn_package_available_sessions('01000000-0000-4000-8000-000000000001','01000000-0000-4000-8000-0000000ca005');
  perform pg_temp.ok(v_before = 0, 'R7b availability is 0 before expiration processing (three stale-but-reserved holds)');

  -- attempt a NEW reservation: reserve_package_session must expire the stale
  -- holds first, then find 3 free and succeed.
  l_new := pg_temp.new_line(1);
  r_new := app.reserve_package_session(l_new,'01000000-0000-4000-8000-0000000ca005');
  perform pg_temp.ok(r_new is not null, 'R7c new reservation succeeds after stale holds expired');

  -- the three stale rows are now 'expired'
  select count(*) into v_expired from public.package_reservations
    where grooming_job_pet_service_id in (l1,l2,l3) and status='expired';
  perform pg_temp.ok(v_expired = 3, 'R7d the three stale rows changed to expired');

  -- the new reservation is 'reserved'
  select status into v_new_status from public.package_reservations where id=r_new;
  perform pg_temp.ok(v_new_status = 'reserved', 'R7e the new reservation is reserved');

  -- final availability: 3 sessions - 1 active (the new) = 2
  v_after := app.fn_package_available_sessions('01000000-0000-4000-8000-000000000001','01000000-0000-4000-8000-0000000ca005');
  perform pg_temp.ok(v_after = 2, 'R7f final availability is correct (3 total - 1 active = 2)');
end $$;

-- R8 quantity change rejected across the WHOLE lifecycle (reserved/consumed/released/expired)
do $$ declare l uuid; r uuid; begin
  -- reserved
  l := pg_temp.new_line(1); r := app.reserve_package_session(l,'01000000-0000-4000-8000-0000000ca001');
  begin perform app.assembly_set_line_quantity(l,2); perform pg_temp.ok(false,'R8a should reject (reserved)');
  exception when check_violation then perform pg_temp.ok(sqlerrm like '%line_has_package_reservation%','R8a set_qty rejected while RESERVED'); end;
  -- consumed
  perform app.consume_package_reservation(r);
  begin perform app.assembly_set_line_quantity(l,2); perform pg_temp.ok(false,'R8b should reject (consumed)');
  exception when check_violation then perform pg_temp.ok(true,'R8b set_qty rejected while CONSUMED'); end;
  -- reversed (consumed -> released with reversal ledger)
  perform app.reverse_package_reservation(r);
  begin perform app.assembly_set_line_quantity(l,2); perform pg_temp.ok(false,'R8c should reject (reversed/released)');
  exception when check_violation then perform pg_temp.ok(true,'R8c set_qty rejected while REVERSED/RELEASED'); end;
end $$;
do $$ declare l uuid; r uuid; begin
  -- released (reserved -> released directly)
  l := pg_temp.new_line(1); r := app.reserve_package_session(l,'01000000-0000-4000-8000-0000000ca001');
  perform app.release_package_reservation(r);
  begin perform app.assembly_set_line_quantity(l,2); perform pg_temp.ok(false,'R8d should reject (released)');
  exception when check_violation then perform pg_temp.ok(true,'R8d set_qty rejected while RELEASED'); end;
end $$;
do $$ declare l uuid; r uuid; begin
  -- expired
  l := pg_temp.new_line(1); r := app.reserve_package_session(l,'01000000-0000-4000-8000-0000000ca001', now()-interval '1 hour');
  perform app.expire_package_reservations('01000000-0000-4000-8000-0000000ca001');
  begin perform app.assembly_set_line_quantity(l,2); perform pg_temp.ok(false,'R8e should reject (expired)');
  exception when check_violation then perform pg_temp.ok(true,'R8e set_qty rejected while EXPIRED'); end;
end $$;

-- R9 reservation cannot be added to a completed (frozen) booking
do $$ declare l uuid; begin
  l := pg_temp.new_line(1);
  update public.bookings set status='completed' where id='01000000-0000-4000-8000-00000000ba01';
  begin perform app.reserve_package_session(l,'01000000-0000-4000-8000-0000000ca001');
    perform pg_temp.ok(false,'R9 reserve on completed booking should be rejected');
  exception when check_violation then perform pg_temp.ok(sqlerrm like '%booking_not_open_for_assembly%','R9 reserve rejected on completed booking (booking_not_open_for_assembly)'); end;
  update public.bookings set status='confirmed' where id='01000000-0000-4000-8000-00000000ba01';
end $$;

rollback;
-- END 20260721001350_test_reservation
