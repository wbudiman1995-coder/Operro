\set ON_ERROR_STOP on
-- Customer 360 pet edit behavior. Runs after the size-band management and
-- adapter smokes, reusing their isolated tenant/role/pet fixtures.

create function pg_temp.u(n integer) returns uuid language sql immutable as
$$ select ('5e000000-0000-4000-8000-' || lpad(to_hex(n), 12, '0'))::uuid $$;

insert into public.organization_pet_types(organization_id,key,label,is_active)
values(pg_temp.u(11),'rabbit','Kelinci',true)
on conflict (organization_id,key) do update set label=excluded.label,is_active=true;

-- Add a real frozen payroll snapshot so the no-rewrite assertion covers all
-- three historical surfaces named by this slice.
insert into public.payroll_runs(id,organization_id,branch_id,period_start,period_end,status,currency,total_gross,total_net)
values(pg_temp.u(190),pg_temp.u(11),pg_temp.u(20),'2099-01-01','2099-01-07','approved','IDR',123000,123000);
insert into public.payroll_items(id,organization_id,payroll_run_id,membership_id,base_pay,gross_pay,net_pay,breakdown)
select pg_temp.u(191),pg_temp.u(11),pg_temp.u(190),m.id,123000,123000,123000,
       '{"perDog":123000,"perDogDetail":[{"key":"extra_large","label":"XL","count":1,"rate":123000}]}'::jsonb
from public.memberships m where m.organization_id=pg_temp.u(11) and m.user_id=pg_temp.u(31);

create function pg_temp.snapshot_hash() returns text language sql stable as $$
  select md5(
    coalesce((select string_agg(to_jsonb(g)::text,'~' order by g.id::text) from public.grooming_job_pet_services g where g.organization_id=pg_temp.u(11)),'') || '|' ||
    coalesce((select string_agg(to_jsonb(c)::text,'~' order by c.id::text) from public.customer_packages c where c.organization_id=pg_temp.u(11)),'') || '|' ||
    coalesce((select string_agg(to_jsonb(i)::text,'~' order by i.id::text) from public.payroll_items i where i.organization_id=pg_temp.u(11)),'')
  )
$$;
create temporary table customer_pet_history_before as select pg_temp.snapshot_hash() as hash;

-- Owner success: even a valid but deliberately wrong manual band cannot win
-- over measured weight. The existing trigger resolves 3 kg to XS.
begin;
set local role authenticated;
select set_config('request.jwt.claims',jsonb_build_object('sub',pg_temp.u(31),'role','authenticated','active_org_id',pg_temp.u(11))::text,true);
do $$
declare v_expected timestamptz; v_row record;
begin
  select updated_at into v_expected from public.pets where id=pg_temp.u(92);
  select * into v_row from app.update_customer_pet(
    pg_temp.u(92),pg_temp.u(60),v_expected,'W3 edited','dog','Mix','female',date '2021-02-03',3,'large','Brown','Calm','Owner success');
  if v_row.stored_size <> 'extra_small' or v_row.size_label <> 'XS'
     or (select size from public.pets where id=pg_temp.u(92)) <> 'extra_small' then
    raise exception 'FAIL measured weight did not override manual size: %',row_to_json(v_row); end if;

  -- Once weight is removed, an active manual key is accepted.
  select * into v_row from app.update_customer_pet(
    pg_temp.u(92),pg_temp.u(60),v_row.updated_at,'W3 edited','dog','Mix','female',date '2021-02-03',null,'medium','Brown','Calm','Manual success');
  if v_row.stored_size <> 'medium' then raise exception 'FAIL manual band was not stored: %',row_to_json(v_row); end if;

  -- Tenant-defined active species is valid and the authoritative trigger clears dog size.
  select updated_at into v_expected from public.pets where id=pg_temp.u(96);
  select * into v_row from app.update_customer_pet(
    pg_temp.u(96),pg_temp.u(60),v_expected,'Bunny','rabbit','Lop','unknown',null,2,null,'White','Calm','Custom species');
  if v_row.stored_size is not null or (select species from public.pets where id=pg_temp.u(96)) <> 'rabbit' then
    raise exception 'FAIL custom species edit/size clearing: %',row_to_json(v_row); end if;
  raise notice 'PASS owner pet edits, custom species, manual size, and weight-authoritative sizing';
end $$;
commit;

do $$ begin
  if pg_temp.snapshot_hash() <> (select hash from customer_pet_history_before) then
    raise exception 'FAIL booking/package/payroll snapshots changed during pet edit'; end if;
  raise notice 'PASS pet edits leave booking, package, and payroll snapshots byte-identical';
end $$;

-- Invalid or inactive tenant vocabulary is rejected by the RPC, not trusted
-- from the form payload.
update public.organization_pet_types set is_active=false where organization_id=pg_temp.u(11) and key='rabbit';
begin;
set local role authenticated;
select set_config('request.jwt.claims',jsonb_build_object('sub',pg_temp.u(31),'role','authenticated','active_org_id',pg_temp.u(11))::text,true);
do $$ declare v_expected timestamptz; begin
  select updated_at into v_expected from public.pets where id=pg_temp.u(96);
  begin
    perform app.update_customer_pet(pg_temp.u(96),pg_temp.u(60),v_expected,'Bunny','rabbit','Lop','unknown',null,2,null,'White','Calm','Inactive');
    raise exception 'ACCEPTED';
  exception when others then
    if sqlerrm='ACCEPTED' or sqlstate<>'22023' or sqlerrm not like 'invalid_pet%' then raise exception 'FAIL inactive species: % %',sqlstate,sqlerrm; end if;
  end;
  begin
    perform app.update_customer_pet(pg_temp.u(92),pg_temp.u(60),(select updated_at from public.pets where id=pg_temp.u(92)),'Dog','dog',null,'unknown',null,null,'not_a_band',null,null,null);
    raise exception 'ACCEPTED';
  exception when others then
    if sqlerrm='ACCEPTED' or sqlstate<>'22023' or sqlerrm not like 'invalid_pet_size%' then raise exception 'FAIL invalid size key: % %',sqlstate,sqlerrm; end if;
  end;
  raise notice 'PASS inactive species and invalid size keys are rejected';
end $$;
rollback;

-- A role without customer.manage is denied before row lookup.
begin;
set local role authenticated;
select set_config('request.jwt.claims',jsonb_build_object('sub',pg_temp.u(35),'role','authenticated','active_org_id',pg_temp.u(11))::text,true);
do $$ begin
  begin
    perform app.update_customer_pet(pg_temp.u(92),pg_temp.u(60),now(),'Denied','dog',null,'unknown',null,null,'small',null,null,null);
    raise exception 'ACCEPTED';
  exception when others then
    if sqlerrm='ACCEPTED' or sqlstate<>'42501' or sqlerrm not like 'not_authorized%' then raise exception 'FAIL restricted role: % %',sqlstate,sqlerrm; end if;
  end;
  raise notice 'PASS restricted role denied';
end $$;
rollback;

-- Another tenant's owner receives not-found and learns no row contents.
begin;
set local role authenticated;
select set_config('request.jwt.claims',jsonb_build_object('sub',pg_temp.u(33),'role','authenticated','active_org_id',pg_temp.u(12))::text,true);
do $$ begin
  begin
    perform app.update_customer_pet(pg_temp.u(92),pg_temp.u(60),now(),'Cross tenant','dog',null,'unknown',null,null,'small',null,null,null);
    raise exception 'ACCEPTED';
  exception when others then
    if sqlerrm='ACCEPTED' or sqlstate<>'P0002' or sqlerrm not like 'pet_not_found%' then raise exception 'FAIL cross-tenant denial: % %',sqlstate,sqlerrm; end if;
  end;
  raise notice 'PASS cross-tenant pet edit denied';
end $$;
rollback;

-- Public and anonymous callers have no executable surface.
do $$ begin
  if has_function_privilege('anon','app.update_customer_pet(uuid,uuid,timestamptz,text,text,text,text,date,numeric,text,text,text,text)','execute')
     or has_function_privilege('public','app.update_customer_pet(uuid,uuid,timestamptz,text,text,text,text,date,numeric,text,text,text,text)','execute') then
    raise exception 'FAIL pet edit RPC exposed to anon/public'; end if;
  raise notice 'PASS pet edit RPC ACL';
end $$;
