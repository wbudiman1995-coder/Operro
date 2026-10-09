\set ON_ERROR_STOP on
-- Bundle 4 (SB-06) payroll behavior under REAL database roles. Disposable
-- database only; run after every migration (GATE 7m):
--   psql <db> -v ON_ERROR_STOP=1 -f integration/size_band_payroll_smoke.sql
-- The arithmetic-level scenarios (legacy XS-XL parity, re-banding, archive,
-- immutability, snapshot export) live in supabase/tests/20261001100000_test_payroll_engine.sql;
-- this file proves the same RPC/table surface for authenticated, restricted,
-- cross-tenant and anon callers, which a superuser fixture cannot.
select set_config('request.jwt.claims','{}',false) as c \gset

create function pg_temp.u(n integer) returns uuid language sql immutable as
$$ select ('5b600000-0000-4000-8000-' || lpad(to_hex(n), 12, '0'))::uuid $$;

-- p_who: 'owner_p' | 'groomer_p' (restricted, same org) | 'owner_q' (other tenant) | 'anon'
create function pg_temp.act(p_who text, p_org uuid) returns void language plpgsql as $$
declare v_sub uuid;
begin
  execute 'reset role';
  if p_who = 'anon' then
    perform set_config('request.jwt.claims','{"role":"anon"}',true);
    execute 'set local role anon'; return;
  end if;
  v_sub := case p_who when 'owner_p' then pg_temp.u(11) when 'groomer_p' then pg_temp.u(12) when 'owner_q' then pg_temp.u(13) end;
  perform set_config('request.jwt.claims', jsonb_build_object('sub',v_sub,'role','authenticated','active_org_id',p_org)::text, true);
  execute 'set local role authenticated';
end $$;
create function pg_temp.sup() returns void language plpgsql as $$ begin execute 'reset role'; end $$;
create function pg_temp.expect(p_who text, p_org uuid, p_sql text, p_state text, p_msg text, p_label text) returns void
language plpgsql as $$
begin
  perform pg_temp.act(p_who, p_org);
  begin
    execute p_sql;
    raise exception 'ACCEPTED';
  exception when others then
    if sqlerrm = 'ACCEPTED' then raise exception 'FAIL % was accepted', p_label; end if;
    if sqlstate <> p_state or sqlerrm not like p_msg then
      raise exception 'FAIL %: expected [%] %, got [%] %', p_label, p_state, p_msg, sqlstate, sqlerrm; end if;
  end;
  perform pg_temp.sup();
  raise notice 'PASS %', p_label;
end $$;

-- ------------------------------------------------------------------ fixture
insert into public.organizations(id,name,slug,status) values
  (pg_temp.u(1),'SB6 Payroll P','sb6-payroll-p','active'),(pg_temp.u(3),'SB6 Payroll Q','sb6-payroll-q','active');
insert into public.branches(id,organization_id,name,is_default,status,timezone) values
  (pg_temp.u(2),pg_temp.u(1),'P Main',true,'active','Asia/Jakarta'),(pg_temp.u(4),pg_temp.u(3),'Q Main',true,'active','Asia/Jakarta');
insert into auth.users(id,email) values (pg_temp.u(11),'sb6-owner-p@qc.local'),(pg_temp.u(12),'sb6-groomer-p@qc.local'),(pg_temp.u(13),'sb6-owner-q@qc.local')
  on conflict (id) do nothing;
insert into public.users(id,full_name,email,status) values
  (pg_temp.u(11),'SB6 Owner P','sb6-owner-p@qc.local','active'),(pg_temp.u(12),'SB6 Groomer P','sb6-groomer-p@qc.local','active'),
  (pg_temp.u(13),'SB6 Owner Q','sb6-owner-q@qc.local','active')
  on conflict (id) do update set full_name=excluded.full_name,email=excluded.email,status=excluded.status;
insert into public.roles(id,organization_id,name,is_system) values
  (pg_temp.u(21),pg_temp.u(1),'Owner',true),(pg_temp.u(22),pg_temp.u(1),'Groomer',true),(pg_temp.u(23),pg_temp.u(3),'Owner',true);
insert into public.memberships(id,organization_id,user_id,role_id,status) values
  (pg_temp.u(31),pg_temp.u(1),pg_temp.u(11),pg_temp.u(21),'active'),(pg_temp.u(32),pg_temp.u(1),pg_temp.u(12),pg_temp.u(22),'active'),
  (pg_temp.u(33),pg_temp.u(3),pg_temp.u(13),pg_temp.u(23),'active');
insert into public.membership_branch_access(organization_id,membership_id,branch_id) values
  (pg_temp.u(1),pg_temp.u(31),pg_temp.u(2)),(pg_temp.u(1),pg_temp.u(32),pg_temp.u(2)),(pg_temp.u(3),pg_temp.u(33),pg_temp.u(4));
insert into public.permissions(key,resource,action,description) values
  ('booking.read','booking','read','r'),('booking.update','booking','update','u'),('booking.complete','booking','complete','c'),
  ('branches.all','branches','all','a'),('service.manage','service','manage','s'),('resource.manage','resource','manage','r'),
  ('payroll.read','payroll','read','pr'),('payroll.manage','payroll','manage','pm'),('payroll.approve','payroll','approve','pa'),
  ('invoice.issue','invoice','issue','ii') on conflict (key) do nothing;
insert into public.role_permissions(organization_id,role_id,permission_id)
select v.org,v.role,p.id from (values (pg_temp.u(1),pg_temp.u(21)),(pg_temp.u(3),pg_temp.u(23))) v(org,role)
cross join public.permissions p where p.key in ('booking.read','booking.update','booking.complete','branches.all','service.manage','resource.manage','payroll.read','payroll.manage','payroll.approve','invoice.issue');
insert into public.role_permissions(organization_id,role_id,permission_id)
select pg_temp.u(1),pg_temp.u(22),p.id from public.permissions p where p.key in ('booking.read','booking.complete');
insert into public.organization_modules(organization_id,module_id,enabled)
select o.id,m.id,true from (values (pg_temp.u(1)),(pg_temp.u(3))) o(id) cross join public.modules m
where m.key in ('scheduling','payroll','finance') on conflict (organization_id,module_id) do update set enabled=true;
insert into public.subscriptions(organization_id,status) values (pg_temp.u(1),'active'),(pg_temp.u(3),'active') on conflict do nothing;
insert into public.resources(id,organization_id,branch_id,kind,name,capacity,status,membership_id,hired_at) values
  (pg_temp.u(41),pg_temp.u(1),pg_temp.u(2),'staff','SB6 Groomer',1,'active',pg_temp.u(32),'2020-01-01');
insert into public.staff_compensation(organization_id,membership_id,pay_type,base_amount,currency,effective_from,is_active)
values (pg_temp.u(1),pg_temp.u(32),'salary',1000000,'IDR','2025-01-01',true);
insert into public.service_catalog(id,organization_id,name,base_price,currency,duration_minutes,is_active,payroll_role)
values (pg_temp.u(61),pg_temp.u(1),'SB6 Basic',100000,'IDR',90,true,'basic_grooming');
insert into public.customers(id,organization_id,display_name) values (pg_temp.u(51),pg_temp.u(1),'SB6 Customer');
-- flat default 20000, no matrix yet; the second organization starts with its own empty settings
insert into public.payroll_cycle_settings(organization_id,per_pet_amount_default) values (pg_temp.u(1),20000),(pg_temp.u(3),20000);
-- Supabase grants table privileges to the API roles through default privileges and relies on RLS for isolation;
-- a bare PostgreSQL gate database has no such defaults, so the fixture states the grants this smoke exercises.
grant select, insert, update, delete on public.payroll_cycle_settings, public.staff_payroll_settings to authenticated;
grant select on public.payroll_runs, public.payroll_items, public.pets to authenticated;
grant select on public.payroll_cycle_settings, public.staff_payroll_settings, public.payroll_items to anon;
-- dynamic mode is a platform decision (set_size_band_mode); the fixture flips it directly
update public.organization_size_band_settings set mode='dynamic',layout_version=layout_version+1 where organization_id=pg_temp.u(1);

-- ------------------------------------------- real owner adds a sixth band (XXL)
begin;
select pg_temp.act('owner_p', pg_temp.u(1));
do $$ declare v_layout jsonb; begin
  select jsonb_agg(jsonb_build_object('id',id,'label',label,
           'upper_kg',case when band_key='extra_large' then 35 else upper_kg end,
           'upper_inclusive',case when band_key='extra_large' then true else upper_inclusive end) order by sort_order)
         || '[{"label":"XXL","upper_kg":null,"upper_inclusive":false}]'::jsonb into v_layout
  from public.organization_size_bands where organization_id=pg_temp.u(1) and band_kind='dog_weight' and status='active';
  perform app.save_size_bands(pg_temp.u(1),(select layout_version from public.organization_size_band_settings where organization_id=pg_temp.u(1)),v_layout);
  if not exists (select 1 from public.organization_size_bands where organization_id=pg_temp.u(1) and band_key='xxl' and status='active') then
    raise exception 'FAIL fixture: XXL band was not created'; end if;
end $$;
commit;

-- ------------------------------------------- completed, invoiced work (fixture)
select set_config('request.jwt.claims',jsonb_build_object('sub',pg_temp.u(11),'role','authenticated','active_org_id',pg_temp.u(1))::text,false) as c \gset
insert into public.pets(id,organization_id,customer_id,name,species,weight_kg) values
  (pg_temp.u(71),pg_temp.u(1),pg_temp.u(51),'SB6 XS 3kg','dog',3),(pg_temp.u(72),pg_temp.u(1),pg_temp.u(51),'SB6 S 9kg','dog',9),
  (pg_temp.u(73),pg_temp.u(1),pg_temp.u(51),'SB6 XXL 40kg','dog',40);
insert into public.bookings(id,organization_id,branch_id,customer_id,booking_type,status,starts_at,ends_at,fulfillment_mode)
values (pg_temp.u(81),pg_temp.u(1),pg_temp.u(2),pg_temp.u(51),'grooming','confirmed','2026-04-01 09:00:00+07','2026-04-01 15:00:00+07','in_store');
do $$ declare v_gjp uuid; n integer; begin
  foreach n in array array[71,72,73] loop
    v_gjp := app.assembly_add_pet(pg_temp.u(81), pg_temp.u(n), true);
    perform app.assembly_add_line(v_gjp, pg_temp.u(61), 1);
    perform app.assembly_assign_pet_resource(v_gjp, pg_temp.u(41));
    update public.grooming_job_pets set status='complete' where id=v_gjp;
  end loop;
  perform app.complete_booking(pg_temp.u(81));
  perform app.issue_invoice_for_booking(pg_temp.u(81), p_document_type := 'invoice');
  if (select size from public.pets where id=pg_temp.u(73)) <> 'xxl' then raise exception 'FAIL fixture: 40 kg dog is not xxl'; end if;
end $$;
select set_config('request.jwt.claims','{}',false) as c \gset

-- --------------------------------------- authenticated owner: settings + payroll
begin;
select pg_temp.act('owner_p', pg_temp.u(1));
do $$ declare v_run uuid; v_b jsonb; r record; begin
  -- settings are written directly under RLS exactly as payroll-actions.ts does (upsert)
  insert into public.payroll_cycle_settings(organization_id,per_pet_amount_default,per_pet_size_matrix_default)
  values (pg_temp.u(1),20000,'{"extra_small":11000,"xxl":22000}'::jsonb)
  on conflict (organization_id) do update set per_pet_size_matrix_default=excluded.per_pet_size_matrix_default,per_pet_amount_default=excluded.per_pet_amount_default;
  insert into public.staff_payroll_settings(organization_id,membership_id,per_pet_size_matrix)
  values (pg_temp.u(1),pg_temp.u(32),null)
  on conflict (organization_id,membership_id) do update set per_pet_size_matrix=excluded.per_pet_size_matrix;
  raise notice 'PASS authenticated owner saved a matrix with the tenant''s sixth-band key (org and staff upserts)';

  v_run := app.recompute_payroll_run('2026-03-26','2026-04-26',null);
  select breakdown into v_b from public.payroll_items where organization_id=pg_temp.u(1) and payroll_run_id=v_run and membership_id=pg_temp.u(32);
  -- XS 3kg -> 11000 (matrix), S 9kg -> 20000 (no entry: flat), XXL 40kg -> 22000 (matrix)
  if (v_b->>'perDog')::numeric <> 53000 then raise exception 'FAIL dynamic matrix payroll: %', v_b; end if;
  if (select string_agg((e->>'key')||'='||(e->>'label'), ',' order by o) from jsonb_array_elements(v_b->'perDogDetail') with ordinality t(e,o)) <> 'extra_small=XS,small=S,xxl=XXL' then
    raise exception 'FAIL perDogDetail: %', v_b->'perDogDetail'; end if;
  raise notice 'PASS authenticated recompute pays the dynamic band rates (11000 + flat 20000 + 22000 = 53000) with tenant labels';

  select count(*) filter (where pet_size is not null and pet_size_label is not null) n, count(*) total into r
  from app.payroll_export_detail_rows(pg_temp.u(1),'2026-03-26','2026-04-26');
  if r.total <> 3 or r.n <> 3 then raise exception 'FAIL export detail rows: %', r; end if;
  if not exists (select 1 from app.payroll_export_detail_rows(pg_temp.u(1),'2026-03-26','2026-04-26') x
                 where x.pet_name='SB6 XXL 40kg' and x.pet_size='xxl' and x.pet_size_label='XXL' and x.service_size_key='xxl' and x.service_size_label='XXL') then
    raise exception 'FAIL export detail XXL row'; end if;
  raise notice 'PASS authenticated owner reads export detail with the resolved key/label and the booking-line snapshot';
end $$;

-- approve + pay, then change the layout and re-band: the paid run is frozen
create function pg_temp.fp(p_run uuid) returns text language sql stable as $$
  select (select r.status||'|'||r.total_gross||'|'||r.total_net||'|'||r.revision from public.payroll_runs r where r.id=p_run)
    ||'|'||coalesce((select md5(string_agg(i.id::text||i.gross_pay||i.net_pay||i.breakdown::text,'~' order by i.id)) from public.payroll_items i where i.payroll_run_id=p_run),'-') $$;
do $$ declare v_run uuid := (select id from public.payroll_runs where organization_id=pg_temp.u(1) and period_start='2026-03-26'); v_fp text; v_layout jsonb; begin
  perform app.approve_payroll_run(v_run);
  perform app.pay_payroll_run(v_run);
  if (select status from public.payroll_runs where id=v_run) <> 'paid' then raise exception 'FAIL fixture run not paid'; end if;
  v_fp := pg_temp.fp(v_run);
  -- rename XXL, widen XL to 45 kg: the 40 kg dog is re-banded from xxl to extra_large
  select jsonb_agg(jsonb_build_object('id',id,'label',case when band_key='xxl' then 'XXL Besar' else label end,
           'upper_kg',case when band_key='extra_large' then 45 else upper_kg end,
           'upper_inclusive',case when band_key='extra_large' then true else upper_inclusive end) order by sort_order) into v_layout
  from public.organization_size_bands where organization_id=pg_temp.u(1) and band_kind='dog_weight' and status='active';
  perform app.save_size_bands(pg_temp.u(1),(select layout_version from public.organization_size_band_settings where organization_id=pg_temp.u(1)),v_layout);
  if (select size from public.pets where id=pg_temp.u(73)) <> 'extra_large' then raise exception 'FAIL fixture: dog was not re-banded'; end if;
  if pg_temp.fp(v_run) <> v_fp then raise exception 'FAIL paid run changed after re-band and rename'; end if;
  if not exists (select 1 from app.payroll_export_detail_rows(pg_temp.u(1),'2026-03-26','2026-04-26') x
                 where x.pet_name='SB6 XXL 40kg' and x.pet_size='extra_large' and x.service_size_key='xxl' and x.service_size_label='XXL') then
    raise exception 'FAIL export detail after re-band'; end if;
  raise notice 'PASS paid run is byte-identical after the owner renamed a band and re-banded a dog; export detail shows the live size beside the untouched line snapshot';
end $$;
commit;

-- ------------------------------------------------ refusal of invalid matrix keys
select pg_temp.expect('owner_p',pg_temp.u(1),$q$update public.payroll_cycle_settings set per_pet_size_matrix_default='{"giant":1}' where organization_id='5b600000-0000-4000-8000-000000000001'$q$,
  '22023','payroll_size_key_invalid:giant','unknown matrix key refused for an authenticated owner');
select pg_temp.expect('owner_p',pg_temp.u(1),$q$update public.staff_payroll_settings set per_pet_size_matrix='{"cat":1}' where organization_id='5b600000-0000-4000-8000-000000000001'$q$,
  '22023','payroll_size_key_invalid:cat','the cat band is not a payroll size key');
begin;
select pg_temp.act('owner_p', pg_temp.u(1));
do $$ declare v_xxl uuid := (select id from public.organization_size_bands where organization_id=pg_temp.u(1) and band_key='xxl'); begin
  -- archive XXL (top band): XL becomes the open band; the stored matrix keeps its xxl entry
  perform app.archive_size_band(pg_temp.u(1),(select layout_version from public.organization_size_band_settings where organization_id=pg_temp.u(1)),v_xxl);
  update public.payroll_cycle_settings set per_pet_size_matrix_default=per_pet_size_matrix_default where organization_id=pg_temp.u(1);
  raise notice 'PASS a matrix holding an archived key can still be re-saved unchanged';
end $$;
commit;
select pg_temp.expect('owner_p',pg_temp.u(1),$q$update public.payroll_cycle_settings set per_pet_size_matrix_default=per_pet_size_matrix_default||'{"xxl":99999}' where organization_id='5b600000-0000-4000-8000-000000000001'$q$,
  '22023','payroll_size_key_invalid:xxl','a changed rate for an archived key is refused (stale form)');

-- --------------------------------------------- restricted role, same organization
select pg_temp.expect('groomer_p',pg_temp.u(1),$q$select * from app.payroll_export_detail_rows('5b600000-0000-4000-8000-000000000001','2026-03-26','2026-04-26')$q$,
  '42501','not_authorized','restricted role is denied the export detail');
select pg_temp.expect('groomer_p',pg_temp.u(1),$q$select app.recompute_payroll_run('2026-05-26','2026-06-26',null)$q$,
  '42501','%','restricted role is denied recompute');
select pg_temp.expect('groomer_p',pg_temp.u(1),$q$insert into public.staff_payroll_settings(organization_id,membership_id,per_pet_size_matrix) values ('5b600000-0000-4000-8000-000000000001','5b600000-0000-4000-8000-00000000001f','{"extra_small":1}')$q$,
  '42501','%row-level security%','restricted role cannot write staff payroll settings (RLS)');
select pg_temp.expect('groomer_p',pg_temp.u(1),$q$select app.compute_payroll_item('5b600000-0000-4000-8000-000000000001','5b600000-0000-4000-8000-000000000020','2026-03-26','2026-04-26')$q$,
  '42501','permission denied%','the internal calculation function is not client-callable');
select pg_temp.expect('owner_p',pg_temp.u(1),$q$select * from app.payroll_eligible_pets('5b600000-0000-4000-8000-000000000001','2026-03-26','2026-04-26')$q$,
  '42501','permission denied%','even the owner cannot call the internal eligibility function directly');
do $$ begin
  perform pg_temp.sup();
  if (select per_pet_size_matrix_default from public.payroll_cycle_settings where organization_id=pg_temp.u(1)) <> '{"extra_small":11000,"xxl":22000}'::jsonb then
    raise exception 'FAIL restricted/refused attempts changed the stored matrix'; end if;
end $$;

-- --------------------------------------------------------------- other tenant
select pg_temp.expect('owner_q',pg_temp.u(3),$q$select * from app.payroll_export_detail_rows('5b600000-0000-4000-8000-000000000001','2026-03-26','2026-04-26')$q$,
  '42501','not_authorized','another tenant''s owner cannot read this organization''s export detail');
select pg_temp.expect('owner_q',pg_temp.u(3),$q$insert into public.payroll_cycle_settings(organization_id,per_pet_size_matrix_default) values ('5b600000-0000-4000-8000-000000000001','{"extra_small":1}') on conflict (organization_id) do update set per_pet_size_matrix_default=excluded.per_pet_size_matrix_default$q$,
  '42501','%','another tenant cannot write this organization''s payroll settings');
select pg_temp.expect('owner_q',pg_temp.u(3),$q$update public.payroll_cycle_settings set per_pet_size_matrix_default='{"xxl":1}' where organization_id='5b600000-0000-4000-8000-000000000003'$q$,
  '22023','payroll_size_key_invalid:xxl','this organization''s custom key does not exist for the other tenant');
begin;
select pg_temp.act('owner_q', pg_temp.u(3));
do $$ declare n integer; begin
  update public.payroll_cycle_settings set per_pet_size_matrix_default='{"extra_small":7000}' where organization_id=pg_temp.u(3);
  update public.payroll_cycle_settings set per_pet_size_matrix_default='{"extra_small":1}' where organization_id=pg_temp.u(1);
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL another tenant updated % rows of this organization''s settings', n; end if;
  if (select count(*) from public.organization_size_bands where organization_id=pg_temp.u(1)) <> 0 then
    raise exception 'FAIL another tenant can read this organization''s bands'; end if;
  raise notice 'PASS other tenant accepts its own legacy key, cannot touch or read this organization''s settings or bands';
end $$;
commit;
do $$ begin
  perform pg_temp.sup();
  if (select per_pet_size_matrix_default from public.payroll_cycle_settings where organization_id=pg_temp.u(1)) <> '{"extra_small":11000,"xxl":22000}'::jsonb then
    raise exception 'FAIL cross-tenant attempts changed this organization''s matrix'; end if;
end $$;

-- ------------------------------------------------------------------------ anon
select pg_temp.expect('anon',pg_temp.u(1),$q$select * from app.payroll_export_detail_rows('5b600000-0000-4000-8000-000000000001','2026-03-26','2026-04-26')$q$,
  '42501','permission denied%','anon cannot call the export RPC');
select pg_temp.expect('anon',pg_temp.u(1),$q$select app.recompute_payroll_run('2026-05-26','2026-06-26',null)$q$,
  '42501','permission denied%','anon cannot recompute payroll');
select pg_temp.expect('anon',pg_temp.u(1),$q$select app.compute_payroll_item('5b600000-0000-4000-8000-000000000001','5b600000-0000-4000-8000-000000000020','2026-03-26','2026-04-26')$q$,
  '42501','permission denied%','anon cannot call the internal calculation');
begin;
select pg_temp.act('anon', pg_temp.u(1));
do $$ begin
  if (select count(*) from public.payroll_cycle_settings) + (select count(*) from public.staff_payroll_settings) + (select count(*) from public.payroll_items) <> 0 then
    raise exception 'FAIL anon can see payroll rows'; end if;
  raise notice 'PASS anon sees no payroll settings, staff settings or items';
end $$;
commit;
select 'SB-06 payroll smoke: ALL PASS' as result;
