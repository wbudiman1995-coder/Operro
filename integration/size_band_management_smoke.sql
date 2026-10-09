\set ON_ERROR_STOP on
-- Behavioral proof for SB-05 size-band management RPCs (disposable database only).
-- Run from the repository root after every migration:
--   psql <db> -v ON_ERROR_STOP=1 -f integration/size_band_management_smoke.sql
select set_config('request.jwt.claims','{}',false) as c \gset

create function pg_temp.u(n integer) returns uuid language sql immutable as
$$ select ('5e000000-0000-4000-8000-' || lpad(to_hex(n), 12, '0'))::uuid $$;

-- run p_sql as a given caller; every attempt runs in a savepoint
--   p_who: 'owner_d','owner_l','owner_o','manager_d','staff_d','helper_d','platform','anon'
--   p_org: the active organization claim
create function pg_temp.act(p_who text, p_org uuid) returns void language plpgsql as $$
declare v_sub uuid; v_claims jsonb;
begin
  execute 'reset role';
  v_sub := case p_who when 'owner_d' then pg_temp.u(31) when 'owner_l' then pg_temp.u(32) when 'owner_o' then pg_temp.u(33)
    when 'manager_d' then pg_temp.u(34) when 'staff_d' then pg_temp.u(35) when 'helper_d' then pg_temp.u(36)
    when 'platform' then (select id from public.users where lower(email)='wbudiman1995@gmail.com') end;
  if p_who = 'anon' then
    perform set_config('request.jwt.claims','{"role":"anon"}',true);
    execute 'set local role anon'; return;
  end if;
  v_claims := jsonb_build_object('sub',v_sub,'role','authenticated','active_org_id',p_org);
  if p_who = 'platform' then v_claims := v_claims || '{"app_metadata":{"is_platform_admin":true}}'::jsonb; end if;
  perform set_config('request.jwt.claims',v_claims::text,true);
  execute 'set local role authenticated';
end $$;
create function pg_temp.sup() returns void language plpgsql as $$ begin execute 'reset role'; end $$;

-- attempt must fail with the given SQLSTATE and message prefix; rolled back either way
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
      raise exception 'FAIL %: expected [%] %, got [%] % (%)', p_label, p_state, p_msg, sqlstate, sqlerrm, p_label; end if;
  end;
  perform pg_temp.sup();
end $$;

create function pg_temp.cur(p_org uuid) returns jsonb language sql stable as $$
  select jsonb_agg(jsonb_build_object('id',id,'label',label,'upper_kg',upper_kg,'upper_inclusive',upper_inclusive) order by sort_order)
  from public.organization_size_bands where organization_id=p_org and band_kind='dog_weight' and status='active' $$;
create function pg_temp.ver(p_org uuid) returns integer language sql stable as $$
  select layout_version from public.organization_size_band_settings where organization_id=p_org $$;
-- XL closes at 35 (inclusive) and a new open XXL band is appended
create function pg_temp.xxl(p_org uuid) returns jsonb language sql stable as $$
  select jsonb_set(jsonb_set(pg_temp.cur(p_org),'{4,upper_kg}','35'),'{4,upper_inclusive}','true')
         || '[{"label":"XXL","upper_kg":null,"upper_inclusive":false}]'::jsonb $$;
create function pg_temp.keys(p_org uuid) returns text language sql stable as $$
  select string_agg(band_key||'='||coalesce(trim_scale(upper_kg)::text,'open')||case when upper_inclusive then 'i' else '' end,',' order by sort_order)
  from public.organization_size_bands where organization_id=p_org and band_kind='dog_weight' and status='active' $$;

-- ---------------------------------------------------------------- fixtures
insert into public.organizations(id,name,slug,status) values
  (pg_temp.u(10),'SB2 Legacy','sb2-legacy','active'),(pg_temp.u(11),'SB2 Dynamic','sb2-dynamic','active'),
  (pg_temp.u(12),'SB2 Other','sb2-other','active'),(pg_temp.u(13),'SB2 Suspended','sb2-suspended','active');
insert into public.branches(id,organization_id,name,is_default,status)
values (pg_temp.u(20),pg_temp.u(11),'D Branch',true,'active'),(pg_temp.u(21),pg_temp.u(10),'L Branch',true,'active');
insert into auth.users(id,email) values
  (pg_temp.u(31),'sb2-owner-d@qc.local'),(pg_temp.u(32),'sb2-owner-l@qc.local'),(pg_temp.u(33),'sb2-owner-o@qc.local'),
  (pg_temp.u(34),'sb2-manager-d@qc.local'),(pg_temp.u(35),'sb2-staff-d@qc.local'),(pg_temp.u(36),'sb2-helper-d@qc.local');
do $$ declare v_id uuid; begin
  select id into v_id from public.users where lower(email)='wbudiman1995@gmail.com';
  if v_id is null then
    v_id := pg_temp.u(30);
    insert into auth.users(id,email) values (v_id,'wbudiman1995@gmail.com');
  end if;
  update public.users set is_platform_admin=true,status='active' where id=v_id;
end $$;
update public.users set status='active' where id in (select pg_temp.u(n) from generate_series(31,36) n);
insert into public.roles(id,organization_id,name,is_system) values
  (pg_temp.u(41),pg_temp.u(11),'Owner',true),(pg_temp.u(42),pg_temp.u(10),'Owner',true),(pg_temp.u(43),pg_temp.u(12),'Owner',true),
  (pg_temp.u(44),pg_temp.u(11),'Manager',false),(pg_temp.u(45),pg_temp.u(11),'Staff',false),(pg_temp.u(46),pg_temp.u(11),'Bantuan Operro',false);
insert into public.memberships(organization_id,user_id,role_id,status) values
  (pg_temp.u(11),pg_temp.u(31),pg_temp.u(41),'active'),(pg_temp.u(10),pg_temp.u(32),pg_temp.u(42),'active'),(pg_temp.u(12),pg_temp.u(33),pg_temp.u(43),'active'),
  (pg_temp.u(11),pg_temp.u(34),pg_temp.u(44),'active'),(pg_temp.u(11),pg_temp.u(35),pg_temp.u(45),'active'),(pg_temp.u(11),pg_temp.u(36),pg_temp.u(46),'active');
insert into public.role_permissions(organization_id,role_id,permission_id)
select r.org,r.role,p.id from (values (pg_temp.u(11),pg_temp.u(41)),(pg_temp.u(10),pg_temp.u(42)),(pg_temp.u(12),pg_temp.u(43)),
  (pg_temp.u(11),pg_temp.u(44)),(pg_temp.u(11),pg_temp.u(46))) r(org,role)
cross join public.permissions p where p.key in ('service.manage','booking.read','customer.manage') on conflict do nothing;
insert into public.role_permissions(organization_id,role_id,permission_id)
select pg_temp.u(11),pg_temp.u(45),id from public.permissions where key='booking.read' on conflict do nothing;
insert into public.organization_modules(organization_id,module_id,enabled)
select o,m.id,true from (values (pg_temp.u(10)),(pg_temp.u(11)),(pg_temp.u(12))) v(o) cross join public.modules m
where m.key in ('scheduling','crm','membership','finance') on conflict (organization_id,module_id) do update set enabled=true;
insert into public.subscriptions(organization_id,status)
values (pg_temp.u(10),'active'),(pg_temp.u(11),'active'),(pg_temp.u(12),'active') on conflict do nothing;
insert into public.customers(id,organization_id,display_name,status) values
  (pg_temp.u(60),pg_temp.u(11),'D Customer','active'),(pg_temp.u(61),pg_temp.u(10),'L Customer','active'),(pg_temp.u(62),pg_temp.u(12),'O Customer','active');
insert into public.service_catalog(id,organization_id,name,duration_minutes,base_price,currency,price_small,duration_small) values
  (pg_temp.u(70),pg_temp.u(11),'D Basic',60,100000,'IDR',120000,50),
  (pg_temp.u(71),pg_temp.u(10),'L Basic',60,100000,'IDR',120000,50),
  (pg_temp.u(72),pg_temp.u(12),'O Basic',60,100000,'IDR',null,null);

-- ------------------------------------------- legacy mode stays byte-compatible
do $$
begin
  -- management RPCs are unavailable until the platform activates dynamic mode
  perform pg_temp.expect('owner_l',pg_temp.u(10),format('select app.save_size_bands(%L,1,pg_temp.cur(%L))',pg_temp.u(10),pg_temp.u(10)),'42501','dynamic_mode_required','owner save in legacy mode');
  perform pg_temp.expect('owner_l',pg_temp.u(10),format('select app.preview_size_layout_impact(%L,pg_temp.cur(%L))',pg_temp.u(10),pg_temp.u(10)),'42501','dynamic_mode_required','owner preview in legacy mode');
  perform pg_temp.expect('platform',pg_temp.u(10),format('select app.save_size_bands(%L,1,pg_temp.cur(%L))',pg_temp.u(10),pg_temp.u(10)),'22023','dynamic_mode_required','platform save in legacy mode');
  perform pg_temp.expect('owner_l',pg_temp.u(10),format('select app.set_size_band_mode(%L,%L,1)',pg_temp.u(10),'dynamic'),'42501','not_authorized','owner cannot activate dynamic mode');
  -- established boundary errors
  perform pg_temp.expect('staff_d',pg_temp.u(11),format('select app.set_dog_size_boundaries(%L,6,11,16,26)',pg_temp.u(11)),'42501','not_authorized','staff boundaries');
  perform pg_temp.expect('owner_l',pg_temp.u(10),format('select app.set_dog_size_boundaries(%L,6,6,16,26)',pg_temp.u(10)),'22023','invalid_boundaries','boundaries order');
  perform pg_temp.expect('owner_l',pg_temp.u(10),format('select app.set_dog_size_boundaries(%L,6,11,16,1000)',pg_temp.u(10)),'22023','invalid_boundaries','boundaries range');
  perform pg_temp.expect('owner_l',pg_temp.u(10),format('select app.set_dog_size_boundaries(%L,null,11,16,26)',pg_temp.u(10)),'22023','invalid_boundaries','boundaries null');
  perform pg_temp.expect('owner_o',pg_temp.u(12),format('select app.set_dog_size_boundaries(%L,6,11,16,26)',pg_temp.u(10)),'42501','not_authorized','owner of another tenant');
  -- the platform owner may only edit the tenant it has selected
  perform pg_temp.expect('platform',pg_temp.u(12),format('select app.set_dog_size_boundaries(%L,6,11,16,26)',pg_temp.u(10)),'42501','not_authorized','platform with another tenant selected');
  update public.organizations set status='suspended' where id=pg_temp.u(13);
  raise notice 'PASS legacy-mode gating and established boundary errors';
end $$;

-- legacy path behaves as before: boundaries row, re-banding, shadow bands, 25.00/25.01
insert into public.pets(id,organization_id,customer_id,name,species,weight_kg,status) values
  (pg_temp.u(80),pg_temp.u(10),pg_temp.u(61),'L25','dog',25.00,'active'),(pg_temp.u(81),pg_temp.u(10),pg_temp.u(61),'L2501','dog',25.01,'active'),
  (pg_temp.u(82),pg_temp.u(10),pg_temp.u(61),'L3','dog',3,'active');
do $$
begin
  if (select string_agg(size,',' order by name) from public.pets where organization_id=pg_temp.u(10)) <> 'large,extra_large,extra_small' then
    raise exception 'FAIL default 25.00/25.01 edge: %', (select string_agg(size,',' order by name) from public.pets where organization_id=pg_temp.u(10)); end if;
  perform pg_temp.act('owner_l',pg_temp.u(10));
  perform app.set_dog_size_boundaries(pg_temp.u(10),6,11,16,26);
  perform pg_temp.sup();
  if (select string_agg(size,',' order by name) from public.pets where organization_id=pg_temp.u(10)) <> 'large,large,extra_small'
     or pg_temp.keys(pg_temp.u(10)) <> 'extra_small=6,small=11,medium=16,large=26i,extra_large=open' then
    raise exception 'FAIL legacy boundary edit: %', pg_temp.keys(pg_temp.u(10)); end if;
  perform pg_temp.act('platform',pg_temp.u(10));
  perform app.set_dog_size_boundaries(pg_temp.u(10),5,10,15,25);
  perform pg_temp.sup();
  if (select string_agg(size,',' order by name) from public.pets where organization_id=pg_temp.u(10)) <> 'large,extra_large,extra_small' then
    raise exception 'FAIL legacy edge after restore'; end if;
  raise notice 'PASS legacy boundary edit by owner and by platform (selected tenant) keeps 25.00 large / 25.01 extra_large';
end $$;

-- ------------------------------------------------- mode switch (platform only)
do $$
declare v jsonb; v_ver integer := pg_temp.ver(pg_temp.u(11));
begin
  perform pg_temp.expect('owner_d',pg_temp.u(11),format('select app.set_size_band_mode(%L,%L,%s)',pg_temp.u(11),'dynamic',v_ver),'42501','not_authorized','owner mode switch');
  perform pg_temp.expect('helper_d',pg_temp.u(11),format('select app.set_size_band_mode(%L,%L,%s)',pg_temp.u(11),'dynamic',v_ver),'42501','not_authorized','helper mode switch');
  perform pg_temp.expect('manager_d',pg_temp.u(11),format('select app.set_size_band_mode(%L,%L,%s)',pg_temp.u(11),'dynamic',v_ver),'42501','not_authorized','manager mode switch');
  perform pg_temp.expect('anon',null,format('select app.set_size_band_mode(%L,%L,%s)',pg_temp.u(11),'dynamic',v_ver),'42501','permission denied%','anon mode switch');
  perform pg_temp.expect('platform',pg_temp.u(12),format('select app.set_size_band_mode(%L,%L,%s)',pg_temp.u(11),'dynamic',v_ver),'42501','not_authorized','platform with another tenant selected');
  perform pg_temp.expect('platform',pg_temp.u(11),format('select app.set_size_band_mode(%L,%L,%s)',pg_temp.u(11),'weird',v_ver),'22023','invalid_mode','invalid mode');
  perform pg_temp.expect('platform',pg_temp.u(11),format('select app.set_size_band_mode(%L,%L,%s)',pg_temp.u(11),'dynamic',v_ver+5),'40001','stale_layout','stale mode switch');
  perform pg_temp.expect('platform',pg_temp.u(13),format('select app.set_size_band_mode(%L,%L,1)',pg_temp.u(13),'dynamic'),'22023','organization_unavailable','suspended tenant');
  perform pg_temp.act('platform',pg_temp.u(11));
  v := app.set_size_band_mode(pg_temp.u(11),'dynamic',v_ver);
  perform pg_temp.sup();
  if v->>'mode' <> 'dynamic' or (v->>'layout_version')::integer <> v_ver+1 or pg_temp.ver(pg_temp.u(11)) <> v_ver+1 then raise exception 'FAIL activation: %', v; end if;
  perform pg_temp.act('platform',pg_temp.u(11));
  v := app.set_size_band_mode(pg_temp.u(11),'dynamic',v_ver+1);
  perform pg_temp.sup();
  if (v->>'changed')::boolean or pg_temp.ver(pg_temp.u(11)) <> v_ver+1 then raise exception 'FAIL replay of the same mode must be a no-op'; end if;
  -- other tenants are unaffected
  if (select mode from public.organization_size_band_settings where organization_id=pg_temp.u(12)) <> 'legacy' then raise exception 'FAIL mode leaked to another tenant'; end if;
  raise notice 'PASS T-DB-11 mode activation is platform-only, selected-tenant-only, version-checked and idempotent';
end $$;

-- ----------------------------------------- dynamic organization D: fixtures
insert into public.pets(id,organization_id,customer_id,name,species,weight_kg,size,status) values
  (pg_temp.u(90),pg_temp.u(11),pg_temp.u(60),'W3','dog',3,null,'active'),
  (pg_temp.u(91),pg_temp.u(11),pg_temp.u(60),'W12','dog',12,null,'active'),
  (pg_temp.u(92),pg_temp.u(11),pg_temp.u(60),'W30','dog',30,null,'active'),
  (pg_temp.u(93),pg_temp.u(11),pg_temp.u(60),'W35','dog',35.00,null,'active'),
  (pg_temp.u(94),pg_temp.u(11),pg_temp.u(60),'W3501','dog',35.01,null,'active'),
  (pg_temp.u(95),pg_temp.u(11),pg_temp.u(60),'W40','dog',40,null,'active'),
  (pg_temp.u(96),pg_temp.u(11),pg_temp.u(60),'W155','dog',15.5,null,'active'),
  (pg_temp.u(97),pg_temp.u(11),pg_temp.u(60),'Manual XL','dog',null,'extra_large','active'),
  (pg_temp.u(98),pg_temp.u(11),pg_temp.u(60),'Cat','cat',4,null,'active');
insert into public.packages(id,organization_id,name,service_id,total_sessions,price,currency,per_pet,size_band)
values (pg_temp.u(100),pg_temp.u(11),'D Paw XL',pg_temp.u(70),4,800000,'IDR',true,'extra_large');
insert into public.customer_packages(id,organization_id,customer_id,package_id,pet_id,sessions_remaining)
values (pg_temp.u(101),pg_temp.u(11),pg_temp.u(60),pg_temp.u(100),pg_temp.u(92),4);
-- a historical line snapshot and entitlement that no layout change may rewrite
insert into public.bookings(id,organization_id,branch_id,customer_id,booking_type,status,starts_at,ends_at)
values (pg_temp.u(110),pg_temp.u(11),pg_temp.u(20),pg_temp.u(60),'grooming','completed',now()-interval '2 day',now()-interval '2 day'+interval '2 hours');
insert into public.grooming_jobs(booking_id,organization_id,checklist,photos,metadata) values (pg_temp.u(110),pg_temp.u(11),'{}','[]','{}');
insert into public.grooming_job_pets(id,organization_id,grooming_job_id,pet_id,sequence,status) values (pg_temp.u(111),pg_temp.u(11),pg_temp.u(110),pg_temp.u(92),1,'complete');
insert into public.grooming_job_pet_services(id,organization_id,grooming_job_pet_id,service_id,service_name_snapshot,duration_minutes,quantity,unit_price_snapshot,currency,pet_size_snapshot,price_source,pet_size_label_snapshot,pet_weight_kg_snapshot,size_layout_version_snapshot)
values (pg_temp.u(112),pg_temp.u(11),pg_temp.u(111),pg_temp.u(70),'D Basic',60,1,269000,'IDR','extra_large','size_matrix','XL',30,1);
create temporary table sb_hist as
select md5((select string_agg(to_jsonb(g)::text,'~' order by g.id::text) from public.grooming_job_pet_services g where g.organization_id=pg_temp.u(11))
        || (select string_agg(to_jsonb(c)::text,'~' order by c.id::text) from public.customer_packages c where c.organization_id=pg_temp.u(11))
        || (select string_agg(to_jsonb(k)::text,'~' order by k.id::text) from public.packages k where k.organization_id=pg_temp.u(11))) as h;
create function pg_temp.hist() returns text language sql stable as $$
  select md5((select string_agg(to_jsonb(g)::text,'~' order by g.id::text) from public.grooming_job_pet_services g where g.organization_id=pg_temp.u(11))
        || (select string_agg(to_jsonb(c)::text,'~' order by c.id::text) from public.customer_packages c where c.organization_id=pg_temp.u(11))
        || (select string_agg(to_jsonb(k)::text,'~' order by k.id::text) from public.packages k where k.organization_id=pg_temp.u(11))) $$;
create function pg_temp.audits(p_org uuid) returns integer language sql stable as $$
  select count(*)::integer from app.audit_log where organization_id=p_org and entity_table='organization_size_band_settings' and diff ? 'event' $$;

-- ------------------------------------------- dual-write while still legacy-five
do $$
declare v jsonb; v_ver integer := pg_temp.ver(pg_temp.u(11)); v_pay jsonb; v_a integer := pg_temp.audits(pg_temp.u(11));
begin
  -- the dynamic layout starts as the legacy five; edit only the cutoffs (key set and flags preserved)
  v_pay := jsonb_set(jsonb_set(jsonb_set(jsonb_set(pg_temp.cur(pg_temp.u(11)),'{0,upper_kg}','6'),'{1,upper_kg}','11'),'{2,upper_kg}','16'),'{3,upper_kg}','26');
  perform pg_temp.act('owner_d',pg_temp.u(11));
  v := app.save_size_bands(pg_temp.u(11),v_ver,v_pay);
  perform pg_temp.sup();
  if not (v->>'changed')::boolean or pg_temp.ver(pg_temp.u(11)) <> v_ver+1 or pg_temp.keys(pg_temp.u(11)) <> 'extra_small=6,small=11,medium=16,large=26i,extra_large=open' then
    raise exception 'FAIL cutoff-only save: %', v; end if;
  if (select xs_lt_kg||','||s_lt_kg||','||m_lt_kg||','||l_lte_kg from public.organization_dog_size_boundaries where organization_id=pg_temp.u(11)) <> '6.00,11.00,16.00,26.00' then
    raise exception 'FAIL legacy boundary row not dual-written'; end if;
  if (select price_small||'/'||duration_small from public.service_catalog where id=pg_temp.u(70)) <> '120000.00/50' then raise exception 'FAIL legacy columns disturbed'; end if;
  if pg_temp.audits(pg_temp.u(11)) <> v_a+1 then raise exception 'FAIL audit row missing for save'; end if;
  -- compatibility wrapper translates a legacy-five layout in dynamic mode
  perform pg_temp.act('owner_d',pg_temp.u(11));
  perform app.set_dog_size_boundaries(pg_temp.u(11),5,10,15,25);
  perform pg_temp.sup();
  if pg_temp.keys(pg_temp.u(11)) <> 'extra_small=5,small=10,medium=15,large=25i,extra_large=open' or pg_temp.ver(pg_temp.u(11)) <> v_ver+2 then
    raise exception 'FAIL dynamic-mode wrapper translation: % v%', pg_temp.keys(pg_temp.u(11)), pg_temp.ver(pg_temp.u(11)); end if;
  raise notice 'PASS T-DB-03a cutoff edits in dynamic mode dual-write the legacy boundary row; wrapper translates a legacy-five layout';
end $$;

-- --------------------------------------------- validation, preview == save
do $$
declare v jsonb; v_prev jsonb; v_ver integer := pg_temp.ver(pg_temp.u(11)); v_cur jsonb := pg_temp.cur(pg_temp.u(11)); v_keys_before text;
        v_t3 timestamptz; v_t40 timestamptz; v_a integer;
begin
  perform pg_temp.expect('owner_d',pg_temp.u(11),format('select app.save_size_bands(%L,%s,%L)',pg_temp.u(11),v_ver,'[]'),'22023','invalid_size_layout','empty layout');
  perform pg_temp.expect('owner_d',pg_temp.u(11),format('select app.save_size_bands(%L,%s,%L)',pg_temp.u(11),v_ver,(select jsonb_agg(v_cur->0) from generate_series(1,13))),'22023','invalid_size_layout','13 bands');
  perform pg_temp.expect('owner_d',pg_temp.u(11),format('select app.save_size_bands(%L,%s,%L)',pg_temp.u(11),v_ver,'{"a":1}'),'22023','invalid_size_layout','not an array');
  perform pg_temp.expect('owner_d',pg_temp.u(11),format('select app.save_size_bands(%L,%s,%L)',pg_temp.u(11),v_ver,jsonb_set(v_cur,'{4,upper_kg}','60')),'22023','invalid_size_layout','top band must be open');
  perform pg_temp.expect('owner_d',pg_temp.u(11),format('select app.save_size_bands(%L,%s,%L)',pg_temp.u(11),v_ver,jsonb_set(v_cur,'{1,upper_kg}','null')),'22023','invalid_size_layout','inner band without upper');
  perform pg_temp.expect('owner_d',pg_temp.u(11),format('select app.save_size_bands(%L,%s,%L)',pg_temp.u(11),v_ver,jsonb_set(v_cur,'{1,upper_kg}','4')),'22023','invalid_size_layout','descending uppers');
  perform pg_temp.expect('owner_d',pg_temp.u(11),format('select app.save_size_bands(%L,%s,%L)',pg_temp.u(11),v_ver,jsonb_set(v_cur,'{1,upper_kg}','5')),'22023','invalid_size_layout','equal uppers');
  perform pg_temp.expect('owner_d',pg_temp.u(11),format('select app.save_size_bands(%L,%s,%L)',pg_temp.u(11),v_ver,jsonb_set(v_cur,'{1,upper_kg}','10.005')),'22023','invalid_size_layout','three decimals');
  perform pg_temp.expect('owner_d',pg_temp.u(11),format('select app.save_size_bands(%L,%s,%L)',pg_temp.u(11),v_ver,jsonb_set(v_cur,'{1,upper_kg}','1000')),'22023','invalid_size_layout','upper above 999');
  perform pg_temp.expect('owner_d',pg_temp.u(11),format('select app.save_size_bands(%L,%s,%L)',pg_temp.u(11),v_ver,jsonb_set(v_cur,'{1,label}','"  "')),'22023','invalid_size_layout','blank label');
  perform pg_temp.expect('owner_d',pg_temp.u(11),format('select app.save_size_bands(%L,%s,%L)',pg_temp.u(11),v_ver,jsonb_set(v_cur,'{1,label}',to_jsonb(repeat('x',41)))),'22023','invalid_size_layout','label too long');
  perform pg_temp.expect('owner_d',pg_temp.u(11),format('select app.save_size_bands(%L,%s,%L)',pg_temp.u(11),v_ver,jsonb_set(v_cur,'{1,label}','"xs"')),'22023','invalid_size_layout','duplicate label (case-insensitive)');
  perform pg_temp.expect('owner_d',pg_temp.u(11),format('select app.save_size_bands(%L,%s,%L)',pg_temp.u(11),v_ver,v_cur #- '{2}'),'22023','invalid_size_layout','omitted band must use archive');
  perform pg_temp.expect('owner_d',pg_temp.u(11),format('select app.save_size_bands(%L,%s,%L)',pg_temp.u(11),v_ver,jsonb_set(v_cur,'{1,id}',to_jsonb(pg_temp.u(999)::text))),'22023','invalid_size_layout','unknown band id');
  perform pg_temp.expect('owner_d',pg_temp.u(11),format('select app.save_size_bands(%L,%s,%L)',pg_temp.u(11),v_ver,jsonb_set(v_cur,'{1,id}',v_cur->0->'id')),'22023','invalid_size_layout','duplicate band id');
  perform pg_temp.expect('owner_d',pg_temp.u(11),format('select app.save_size_bands(%L,%s,%L)',pg_temp.u(11),v_ver,jsonb_set(v_cur,'{1,id}',to_jsonb((select id::text from public.organization_size_bands where organization_id=pg_temp.u(11) and band_key='cat')))),'22023','invalid_size_layout','cat id inside dog layout');
  perform pg_temp.expect('owner_d',pg_temp.u(11),format('select app.save_size_bands(%L,%s,%L)',pg_temp.u(11),v_ver+1,v_cur),'40001','stale_layout','stale version');
  perform pg_temp.expect('owner_d',pg_temp.u(11),format('select app.save_size_bands(%L,null,%L)',pg_temp.u(11),v_cur),'40001','stale_layout','missing version');
  perform pg_temp.expect('owner_d',pg_temp.u(12),format('select app.save_size_bands(%L,%s,%L)',pg_temp.u(11),v_ver,v_cur),'42501','not_authorized','p_org is not the selected tenant');
  perform pg_temp.expect('owner_o',pg_temp.u(12),format('select app.save_size_bands(%L,%s,%L)',pg_temp.u(11),v_ver,v_cur),'42501','not_authorized','owner of another tenant');
  perform pg_temp.expect('owner_o',pg_temp.u(11),format('select app.save_size_bands(%L,%s,%L)',pg_temp.u(11),v_ver,v_cur),'42501','not_authorized','owner of another tenant with D selected');
  perform pg_temp.expect('manager_d',pg_temp.u(11),format('select app.save_size_bands(%L,%s,%L)',pg_temp.u(11),v_ver,v_cur),'42501','not_authorized','manager has no layout authority');
  perform pg_temp.expect('staff_d',pg_temp.u(11),format('select app.save_size_bands(%L,%s,%L)',pg_temp.u(11),v_ver,v_cur),'42501','not_authorized','staff');
  perform pg_temp.expect('helper_d',pg_temp.u(11),format('select app.save_size_bands(%L,%s,%L)',pg_temp.u(11),v_ver,v_cur),'42501','not_authorized','helper role');
  perform pg_temp.expect('helper_d',pg_temp.u(11),format('select app.preview_size_layout_impact(%L,%L)',pg_temp.u(11),v_cur),'42501','not_authorized','helper preview');
  perform pg_temp.expect('manager_d',pg_temp.u(11),format('select app.archive_size_band(%L,%s,%L)',pg_temp.u(11),v_ver,(v_cur->0->>'id')::uuid),'42501','not_authorized','manager archive');
  perform pg_temp.expect('helper_d',pg_temp.u(11),format('select app.delete_size_band(%L,%s,%L)',pg_temp.u(11),v_ver,(v_cur->0->>'id')::uuid),'42501','not_authorized','helper delete');
  perform pg_temp.expect('anon',null,format('select app.save_size_bands(%L,%s,%L)',pg_temp.u(11),v_ver,v_cur),'42501','permission denied%','anon save');
  if pg_temp.ver(pg_temp.u(11)) <> v_ver or pg_temp.cur(pg_temp.u(11)) <> v_cur then raise exception 'FAIL a refused call changed the layout'; end if;

  -- a sixth band: preview == save
  v_keys_before := pg_temp.keys(pg_temp.u(11)); v_a := pg_temp.audits(pg_temp.u(11));
  select updated_at into v_t3 from public.pets where id=pg_temp.u(90);
  select updated_at into v_t40 from public.pets where id=pg_temp.u(95);
  perform pg_temp.act('owner_d',pg_temp.u(11));
  v_prev := app.preview_size_layout_impact(pg_temp.u(11),pg_temp.xxl(pg_temp.u(11)));
  perform pg_temp.sup();
  if pg_temp.ver(pg_temp.u(11)) <> v_ver or pg_temp.keys(pg_temp.u(11)) <> v_keys_before then raise exception 'FAIL preview wrote data'; end if;
  if (v_prev->'impact'->>'pets_rebanded') <> '2' or (v_prev->'impact'->>'pets_measured') <> '7' or (v_prev->'impact'->>'package_conflicts') <> '0'
     or v_prev->'new_bands' <> '[{"key":"xxl","label":"XXL"}]'::jsonb then
    raise exception 'FAIL preview impact: %', v_prev; end if;
  perform pg_temp.act('owner_d',pg_temp.u(11));
  v := app.save_size_bands(pg_temp.u(11),v_ver,pg_temp.xxl(pg_temp.u(11)));
  perform pg_temp.sup();
  if v->'impact' <> v_prev->'impact' or v->'layout' <> v_prev->'layout' or v->'new_bands' <> v_prev->'new_bands' then
    raise exception 'FAIL preview and save disagree: % vs %', v_prev, v; end if;
  if pg_temp.keys(pg_temp.u(11)) <> 'extra_small=5,small=10,medium=15,large=25i,extra_large=35i,xxl=open' or pg_temp.ver(pg_temp.u(11)) <> v_ver+1 then
    raise exception 'FAIL sixth band layout: % v%', pg_temp.keys(pg_temp.u(11)), pg_temp.ver(pg_temp.u(11)); end if;
  if (select string_agg(name||'='||size,',' order by name) from public.pets where organization_id=pg_temp.u(11) and species='dog' and weight_kg is not null)
     <> 'W12=medium,W155=large,W3=extra_small,W30=extra_large,W35=extra_large,W3501=xxl,W40=xxl' then
    raise exception 'FAIL measured dogs were not re-banded: %', (select string_agg(name||'='||size,',' order by name) from public.pets where organization_id=pg_temp.u(11) and species='dog' and weight_kg is not null); end if;
  if (select size from public.pets where id=pg_temp.u(97)) <> 'extra_large' then raise exception 'FAIL manual-size dog was touched'; end if;
  if (select updated_at from public.pets where id=pg_temp.u(90)) is distinct from v_t3 then raise exception 'FAIL unchanged pet was rewritten'; end if;
  if (select updated_at from public.pets where id=pg_temp.u(95)) is not distinct from v_t40 then raise exception 'FAIL changed pet was not updated'; end if;
  if pg_temp.hist() <> (select h from sb_hist) then raise exception 'FAIL historical snapshots/entitlements/packages changed'; end if;
  if pg_temp.audits(pg_temp.u(11)) <> v_a+1 or not exists (select 1 from app.audit_log where organization_id=pg_temp.u(11)
       and diff->>'event'='save_size_bands' and diff->'new'->'impact'->>'pets_rebanded'='2' and jsonb_array_length(diff->'old'->'bands')=6 and jsonb_array_length(diff->'new'->'bands')=7) then
    raise exception 'FAIL audit before/after payload missing'; end if;
  -- the legacy mirror stops once the layout is no longer the legacy five
  if (select count(*) from public.organization_dog_size_boundaries where organization_id=pg_temp.u(11) and xs_lt_kg=5 and l_lte_kg=25) <> 1 then
    raise exception 'FAIL legacy boundary row must keep the last representable values'; end if;
  perform pg_temp.expect('owner_d',pg_temp.u(11),format('select app.set_dog_size_boundaries(%L,6,11,16,26)',pg_temp.u(11)),'22023','use_size_band_editor','wrapper refuses a custom layout');
  -- no-op replay does not bump the version or audit
  v_a := pg_temp.audits(pg_temp.u(11));
  perform pg_temp.act('owner_d',pg_temp.u(11));
  v := app.save_size_bands(pg_temp.u(11),v_ver+1,pg_temp.cur(pg_temp.u(11)));
  perform pg_temp.sup();
  if (v->>'changed')::boolean or pg_temp.ver(pg_temp.u(11)) <> v_ver+1 or pg_temp.audits(pg_temp.u(11)) <> v_a then raise exception 'FAIL no-op replay must not bump the version'; end if;
  raise notice 'PASS T-DB-03b sixth band: validation, authority matrix, preview==save, re-banding of measured dogs only, no-op replay, audit, snapshots untouched';
end $$;

-- ------------------------- rename/reorder boundaries, server keys, collisions
do $$
declare v jsonb; v_ver integer := pg_temp.ver(pg_temp.u(11)); v_cur jsonb := pg_temp.cur(pg_temp.u(11)); v_pay jsonb;
begin
  -- rename + move a boundary: keys stay, only labels/cutoffs change; 15.5 kg becomes medium
  v_pay := jsonb_set(jsonb_set(v_cur,'{5,label}','"Giant"'),'{2,upper_kg}','16');
  perform pg_temp.act('owner_d',pg_temp.u(11));
  v := app.save_size_bands(pg_temp.u(11),v_ver,v_pay);
  perform pg_temp.sup();
  if (select label from public.organization_size_bands where organization_id=pg_temp.u(11) and band_key='xxl') <> 'Giant'
     or (select size from public.pets where id=pg_temp.u(96)) <> 'medium' or pg_temp.ver(pg_temp.u(11)) <> v_ver+1 then
    raise exception 'FAIL rename/reorder boundaries'; end if;
  -- keys are server-generated, deterministic and collision-safe; reorder via a new middle band
  v_ver := pg_temp.ver(pg_temp.u(11)); v_cur := pg_temp.cur(pg_temp.u(11));
  v_pay := jsonb_set(v_cur,'{5,upper_kg}','45')
    || '[{"label":"XXL!","upper_kg":55,"upper_inclusive":false},{"label":"2xl+","upper_kg":65,"upper_inclusive":false},{"label":"S","upper_kg":null}]'::jsonb;
  perform pg_temp.expect('owner_d',pg_temp.u(11),format('select app.save_size_bands(%L,%s,%L)',pg_temp.u(11),v_ver,v_pay),'22023','invalid_size_layout','new band duplicating a label');
  v_pay := jsonb_set(v_cur,'{5,upper_kg}','45')
    || '[{"label":"XXL!","upper_kg":55,"upper_inclusive":false},{"label":"2xl+","upper_kg":65,"upper_inclusive":false},{"label":"x","upper_kg":null}]'::jsonb;
  perform pg_temp.act('owner_d',pg_temp.u(11));
  v := app.save_size_bands(pg_temp.u(11),v_ver,v_pay);
  perform pg_temp.sup();
  if (select string_agg(band_key,',' order by sort_order) from public.organization_size_bands where organization_id=pg_temp.u(11) and band_kind='dog_weight' and status='active')
     <> 'extra_small,small,medium,large,extra_large,xxl,xxl_2,band_2xl,band_x' then
    raise exception 'FAIL generated keys: %', (select string_agg(band_key,',' order by sort_order) from public.organization_size_bands where organization_id=pg_temp.u(11) and band_kind='dog_weight' and status='active'); end if;
  if (select size from public.pets where id=pg_temp.u(95)) <> 'xxl' or (select size from public.pets where name='W3501' and organization_id=pg_temp.u(11)) <> 'xxl' then
    raise exception 'FAIL 35.01 and 40 kg dogs should still be xxl (upper 45)'; end if;
  if (select count(*) from public.organization_size_bands where organization_id=pg_temp.u(11) and band_kind='dog_weight' and status='active') <> 9 then raise exception 'FAIL band count'; end if;
  -- keys are immutable for clients: a payload cannot carry or change them
  if (select band_key from public.organization_size_bands where id=(v_cur->5->>'id')::uuid) <> 'xxl' then raise exception 'FAIL key changed on rename'; end if;
  raise notice 'PASS T-DB-03c rename and reorder keep keys; new keys are server generated (xxl_2, band_2xl, band_x) and collision-safe';
end $$;

-- --------------- package conflict is refused with no partial write; preview agrees
do $$
declare v_ver integer := pg_temp.ver(pg_temp.u(11)); v_cur jsonb := pg_temp.cur(pg_temp.u(11)); v_pay jsonb; v_prev jsonb; v_snap jsonb; v_pets text; v_a integer := pg_temp.audits(pg_temp.u(11)); v_h text := pg_temp.hist();
begin
  -- W30 (extra_large, sold an XL package) would become `large` if large closed at 32
  v_pay := jsonb_set(v_cur,'{3,upper_kg}','32');
  v_snap := app.size_band_snapshot(pg_temp.u(11));
  select string_agg(name||'='||coalesce(size,'-'),',' order by name) into v_pets from public.pets where organization_id=pg_temp.u(11);
  perform pg_temp.act('owner_d',pg_temp.u(11));
  v_prev := app.preview_size_layout_impact(pg_temp.u(11),v_pay);
  perform pg_temp.sup();
  if (v_prev->'impact'->>'package_conflicts') <> '1' then raise exception 'FAIL preview must report the entitlement conflict: %', v_prev; end if;
  perform pg_temp.expect('owner_d',pg_temp.u(11),format('select app.save_size_bands(%L,%s,%L)',pg_temp.u(11),v_ver,v_pay),'23514','active_package_size_would_change','entitlement conflict');
  if app.size_band_snapshot(pg_temp.u(11)) <> v_snap or pg_temp.audits(pg_temp.u(11)) <> v_a or pg_temp.hist() <> v_h
     or (select string_agg(name||'='||coalesce(size,'-'),',' order by name) from public.pets where organization_id=pg_temp.u(11)) <> v_pets then
    raise exception 'FAIL refused save left partial writes'; end if;
  raise notice 'PASS T-DB-04 preview reports and save refuses an active-entitlement mismatch without any partial write';
end $$;

-- expect with a DETAIL check (structured dependency reasons travel in DETAIL as JSON)
create function pg_temp.expect_d(p_who text, p_org uuid, p_sql text, p_state text, p_msg text, p_detail jsonb, p_label text) returns void
language plpgsql as $$
declare v_detail text;
begin
  perform pg_temp.act(p_who, p_org);
  begin
    execute p_sql;
    raise exception 'ACCEPTED';
  exception when others then
    get stacked diagnostics v_detail = pg_exception_detail;
    if sqlerrm = 'ACCEPTED' then raise exception 'FAIL % was accepted', p_label; end if;
    if sqlstate <> p_state or sqlerrm <> p_msg then raise exception 'FAIL %: expected [%] %, got [%] %', p_label, p_state, p_msg, sqlstate, sqlerrm; end if;
    if v_detail is null or not (v_detail::jsonb @> p_detail) then raise exception 'FAIL %: detail [%] does not contain %', p_label, v_detail, p_detail; end if;
  end;
  perform pg_temp.sup();
end $$;
create function pg_temp.band(p_org uuid, p_key text) returns uuid language sql stable as
$$ select id from public.organization_size_bands where organization_id=p_org and band_key=p_key $$;
create function pg_temp.size(p_org uuid, p_name text) returns text language sql stable as
$$ select size from public.pets where organization_id=p_org and name=p_name $$;

-- ------------------------------------------------ archive guards and effects
insert into public.pets(id,organization_id,customer_id,name,species,weight_kg,size,status,deleted_at) values
  (pg_temp.u(120),pg_temp.u(11),pg_temp.u(60),'Old','dog',null,'band_x','active',now());
insert into public.pets(id,organization_id,customer_id,name,species,weight_kg,size,status) values
  (pg_temp.u(121),pg_temp.u(11),pg_temp.u(60),'W50','dog',50,null,'active');
insert into public.packages(id,organization_id,name,service_id,total_sessions,price,currency,per_pet,size_band,is_active,deleted_at) values
  (pg_temp.u(122),pg_temp.u(11),'D Old',pg_temp.u(70),1,1,'IDR',true,'band_x',false,now()),
  (pg_temp.u(123),pg_temp.u(11),'D Paw XXL (retired)',pg_temp.u(70),2,500000,'IDR',true,'xxl',false,null);
insert into public.customer_packages(id,organization_id,customer_id,package_id,pet_id,sessions_remaining)
values (pg_temp.u(124),pg_temp.u(11),pg_temp.u(60),pg_temp.u(123),pg_temp.u(94),2);
update sb_hist set h = pg_temp.hist();

do $$
declare v jsonb; v_ver integer := pg_temp.ver(pg_temp.u(11)); v_snap jsonb; v_h text := pg_temp.hist(); v_a integer;
begin
  if pg_temp.size(pg_temp.u(11),'W50') <> 'xxl_2' then raise exception 'FAIL fixture: 50 kg should be xxl_2, is %', pg_temp.size(pg_temp.u(11),'W50'); end if;
  perform pg_temp.expect('owner_d',pg_temp.u(11),format('select app.archive_size_band(%L,%s,%L)',pg_temp.u(11),v_ver,pg_temp.band(pg_temp.u(11),'cat')),'23514','size_band_cat_permanent','archive cat');
  perform pg_temp.expect('owner_d',pg_temp.u(11),format('select app.archive_size_band(%L,%s,%L)',pg_temp.u(11),v_ver,pg_temp.u(999)),'P0002','size_band_not_found','archive unknown band');
  perform pg_temp.expect('owner_d',pg_temp.u(11),format('select app.archive_size_band(%L,%s,%L)',pg_temp.u(11),v_ver,pg_temp.band(pg_temp.u(12),'small')),'P0002','size_band_not_found','archive another tenant''s band');
  perform pg_temp.expect('owner_d',pg_temp.u(11),format('select app.archive_size_band(%L,%s,%L)',pg_temp.u(11),v_ver+3,pg_temp.band(pg_temp.u(11),'band_x')),'40001','stale_layout','archive stale version');
  perform pg_temp.expect_d('owner_d',pg_temp.u(11),format('select app.archive_size_band(%L,%s,%L)',pg_temp.u(11),v_ver,pg_temp.band(pg_temp.u(11),'extra_large')),'23514','size_band_in_use',
    '{"manual_pets":1,"sellable_packages":1}','manual pet and sellable package guards');
  -- archive the open top band: the previous band is promoted
  v_a := pg_temp.audits(pg_temp.u(11));
  perform pg_temp.act('owner_d',pg_temp.u(11));
  v := app.archive_size_band(pg_temp.u(11),v_ver,pg_temp.band(pg_temp.u(11),'band_x'));
  perform pg_temp.sup();
  if pg_temp.keys(pg_temp.u(11)) <> 'extra_small=5,small=10,medium=16,large=25i,extra_large=35i,xxl=45,xxl_2=55,band_2xl=open'
     or pg_temp.ver(pg_temp.u(11)) <> v_ver+1 or (select status||':'||(archived_at is not null) from public.organization_size_bands where band_key='band_x' and organization_id=pg_temp.u(11)) <> 'archived:true'
     or pg_temp.audits(pg_temp.u(11)) <> v_a+1 then
    raise exception 'FAIL archive top band: % v%', pg_temp.keys(pg_temp.u(11)), pg_temp.ver(pg_temp.u(11)); end if;
  perform pg_temp.expect('owner_d',pg_temp.u(11),format('select app.archive_size_band(%L,%s,%L)',pg_temp.u(11),v_ver+1,pg_temp.band(pg_temp.u(11),'band_x')),'22023','size_band_not_active','archive twice');
  -- archive a middle band: its range is absorbed by the next-larger band
  v_ver := v_ver + 1;
  perform pg_temp.act('owner_d',pg_temp.u(11));
  v := app.archive_size_band(pg_temp.u(11),v_ver,pg_temp.band(pg_temp.u(11),'xxl_2'));
  perform pg_temp.sup();
  if pg_temp.size(pg_temp.u(11),'W50') <> 'band_2xl' or (v->>'pets_rebanded') <> '1' or pg_temp.ver(pg_temp.u(11)) <> v_ver+1 then raise exception 'FAIL archive middle band: %', v; end if;
  v_ver := v_ver + 1;
  -- an active entitlement on a retired (non-sellable) package still blocks the archive; nothing is written
  v_snap := app.size_band_snapshot(pg_temp.u(11)); v_a := pg_temp.audits(pg_temp.u(11));
  perform pg_temp.expect_d('owner_d',pg_temp.u(11),format('select app.archive_size_band(%L,%s,%L)',pg_temp.u(11),v_ver,pg_temp.band(pg_temp.u(11),'xxl')),'23514','active_package_size_would_change',
    '{"package_conflicts":1}','entitlement mismatch on archive');
  if app.size_band_snapshot(pg_temp.u(11)) <> v_snap or pg_temp.audits(pg_temp.u(11)) <> v_a or pg_temp.size(pg_temp.u(11),'W3501') <> 'xxl' then raise exception 'FAIL refused archive wrote data'; end if;
  update public.customer_packages set status='canceled' where id=pg_temp.u(124);
  update sb_hist set h = pg_temp.hist();  -- fixture change (cancel) is not a layout side effect
  perform pg_temp.act('owner_d',pg_temp.u(11));
  perform app.archive_size_band(pg_temp.u(11),v_ver,pg_temp.band(pg_temp.u(11),'xxl'));
  perform pg_temp.sup();
  v_ver := v_ver + 1;
  if pg_temp.size(pg_temp.u(11),'W3501') <> 'band_2xl' or pg_temp.size(pg_temp.u(11),'W40') <> 'band_2xl' or pg_temp.size(pg_temp.u(11),'W35') <> 'extra_large' then
    raise exception 'FAIL re-banding after archive'; end if;
  if pg_temp.hist() <> (select h from sb_hist) then raise exception 'FAIL history changed by archives'; end if;
  raise notice 'PASS T-DB-05a archive: guards (cat, unknown, tenant, stale, manual pets, sellable package, entitlement mismatch), top promotion, middle absorption, re-banding, history untouched';
end $$;

-- an archived band can be restored through save (key and history are intact)
do $$
declare v jsonb; v_ver integer := pg_temp.ver(pg_temp.u(11)); v_cur jsonb := pg_temp.cur(pg_temp.u(11)); v_pay jsonb;
begin
  v_pay := (v_cur #- '{5}') || jsonb_build_array(jsonb_build_object('id',pg_temp.band(pg_temp.u(11),'xxl'),'label','Giant','upper_kg',45,'upper_inclusive',false)) || jsonb_build_array(v_cur->5);
  perform pg_temp.act('owner_d',pg_temp.u(11));
  v := app.save_size_bands(pg_temp.u(11),v_ver,v_pay);
  perform pg_temp.sup();
  if pg_temp.keys(pg_temp.u(11)) <> 'extra_small=5,small=10,medium=16,large=25i,extra_large=35i,xxl=45,band_2xl=open'
     or pg_temp.size(pg_temp.u(11),'W3501') <> 'xxl' or pg_temp.size(pg_temp.u(11),'W50') <> 'band_2xl'
     or (select status||':'||(archived_at is null) from public.organization_size_bands where organization_id=pg_temp.u(11) and band_key='xxl') <> 'active:true' then
    raise exception 'FAIL restore archived band: %', pg_temp.keys(pg_temp.u(11)); end if;
  raise notice 'PASS T-DB-05b an archived band is restored through save with its original key';
end $$;

\ir size_band_oracle.sql

-- ------------------------------------------- service band prices (D, custom layout)
do $$
declare v jsonb; v_ver integer := pg_temp.ver(pg_temp.u(11)); v_a integer; v_pay jsonb;
begin
  v_pay := '[{"band_key":"xxl","price":400000,"duration_minutes":150},{"band_key":"extra_large","price":300000,"duration_minutes":120},
             {"band_key":"small","price":120000,"duration_minutes":50},{"band_key":"cat","price":90000}]'::jsonb;
  v_a := pg_temp.audits(pg_temp.u(11));
  perform pg_temp.act('manager_d',pg_temp.u(11));
  v := app.set_service_band_prices(pg_temp.u(11),pg_temp.u(70),v_ver,v_pay);
  perform pg_temp.sup();
  if (select string_agg(pricing_key||'='||coalesce(price::text,'n')||'/'||coalesce(duration_minutes::text,'n'),',' order by pricing_key) from public.service_band_prices where service_id=pg_temp.u(70))
     <> 'cat=90000.00/n,extra_large=300000.00/120,small=120000.00/50,xxl=400000.00/150' then
    raise exception 'FAIL price rows: %', (select string_agg(pricing_key,',') from public.service_band_prices where service_id=pg_temp.u(70)); end if;
  if pg_temp.ver(pg_temp.u(11)) <> v_ver then raise exception 'FAIL price save must not bump the layout version'; end if;
  if (select price_extra_large from public.service_catalog where id=pg_temp.u(70)) is not null then
    raise exception 'FAIL legacy columns must not be dual-written while the layout is custom'; end if;
  if pg_temp.audits(pg_temp.u(11)) <> v_a+1 then raise exception 'FAIL price audit row'; end if;
  -- base-price fallback for a band without a row, and the resolver reads the new rows
  if pg_temp.new_line(pg_temp.u(11),pg_temp.u(70),'dog',40,null,1) <> 'xxl|400000.00|150|size_matrix'
     or pg_temp.new_line(pg_temp.u(11),pg_temp.u(70),'dog',12,null,1) <> 'medium|100000.00|60|base'
     or pg_temp.new_line(pg_temp.u(11),pg_temp.u(70),'dog',50,null,2) <> 'band_2xl|100000.00|60|base'
     or pg_temp.new_line(pg_temp.u(11),pg_temp.u(70),'cat',null,null,1) <> 'cat|90000.00|60|size_matrix' then
    raise exception 'FAIL resolver after price save: % / % / %', pg_temp.new_line(pg_temp.u(11),pg_temp.u(70),'dog',40,null,1), pg_temp.new_line(pg_temp.u(11),pg_temp.u(70),'dog',12,null,1), pg_temp.new_line(pg_temp.u(11),pg_temp.u(70),'cat',null,null,1); end if;
  -- idempotent replay: no audit row
  v_a := pg_temp.audits(pg_temp.u(11));
  perform pg_temp.act('owner_d',pg_temp.u(11));
  perform app.set_service_band_prices(pg_temp.u(11),pg_temp.u(70),v_ver,v_pay);
  perform pg_temp.sup();
  if pg_temp.audits(pg_temp.u(11)) <> v_a then raise exception 'FAIL identical replay must not audit'; end if;
  -- copy from the previous band (server-side) and replace semantics (omitted bands are cleared)
  perform pg_temp.act('manager_d',pg_temp.u(11));
  perform app.set_service_band_prices(pg_temp.u(11),pg_temp.u(70),v_ver,
    '[{"band_key":"xxl","price":400000,"duration_minutes":150},{"band_key":"band_2xl","copy_from":"xxl"},{"band_key":"extra_large","price":300000,"duration_minutes":120}]'::jsonb);
  perform pg_temp.sup();
  if (select string_agg(pricing_key||'='||coalesce(price::text,'n')||'/'||coalesce(duration_minutes::text,'n'),',' order by pricing_key) from public.service_band_prices where service_id=pg_temp.u(70))
     <> 'band_2xl=400000.00/150,extra_large=300000.00/120,xxl=400000.00/150' then raise exception 'FAIL copy/replace semantics'; end if;
  perform pg_temp.expect('manager_d',pg_temp.u(11),format('select app.set_service_band_prices(%L,%L,%s,%L)',pg_temp.u(11),pg_temp.u(70),v_ver,'[{"band_key":"medium","copy_from":"small"}]'),'22023','copy_source_empty','copy from an empty band');
  -- validation
  perform pg_temp.expect('manager_d',pg_temp.u(11),format('select app.set_service_band_prices(%L,%L,%s,%L)',pg_temp.u(11),pg_temp.u(70),v_ver,'[{"band_key":"zzz","price":1}]'),'22023','invalid_band_prices','unknown band');
  perform pg_temp.expect('manager_d',pg_temp.u(11),format('select app.set_service_band_prices(%L,%L,%s,%L)',pg_temp.u(11),pg_temp.u(70),v_ver,'[{"band_key":"band_x","price":1}]'),'22023','invalid_band_prices','archived band');
  perform pg_temp.expect('manager_d',pg_temp.u(11),format('select app.set_service_band_prices(%L,%L,%s,%L)',pg_temp.u(11),pg_temp.u(70),v_ver,'[{"band_key":"xxl","price":1},{"band_key":"xxl","price":2}]'),'22023','invalid_band_prices','duplicate band');
  perform pg_temp.expect('manager_d',pg_temp.u(11),format('select app.set_service_band_prices(%L,%L,%s,%L)',pg_temp.u(11),pg_temp.u(70),v_ver,'[{"band_key":"xxl","price":-1}]'),'22023','invalid_band_prices','negative price');
  perform pg_temp.expect('manager_d',pg_temp.u(11),format('select app.set_service_band_prices(%L,%L,%s,%L)',pg_temp.u(11),pg_temp.u(70),v_ver,'[{"band_key":"xxl","price":1.234}]'),'22023','invalid_band_prices','three decimals');
  perform pg_temp.expect('manager_d',pg_temp.u(11),format('select app.set_service_band_prices(%L,%L,%s,%L)',pg_temp.u(11),pg_temp.u(70),v_ver,'[{"band_key":"xxl","duration_minutes":1441}]'),'22023','invalid_band_prices','duration too long');
  perform pg_temp.expect('manager_d',pg_temp.u(11),format('select app.set_service_band_prices(%L,%L,%s,%L)',pg_temp.u(11),pg_temp.u(70),v_ver,'[{"band_key":"xxl","duration_minutes":10.5}]'),'22023','invalid_band_prices','fractional minutes');
  perform pg_temp.expect('manager_d',pg_temp.u(11),format('select app.set_service_band_prices(%L,%L,%s,%L)',pg_temp.u(11),pg_temp.u(70),v_ver,'[{"band_key":"xxl","price":"9"}]'),'22023','invalid_band_prices','string price is not a number');
  perform pg_temp.expect('manager_d',pg_temp.u(11),format('select app.set_service_band_prices(%L,%L,%s,%L)',pg_temp.u(11),pg_temp.u(70),v_ver,'{"band_key":"xxl"}'),'22023','invalid_band_prices','not an array');
  perform pg_temp.expect('manager_d',pg_temp.u(11),format('select app.set_service_band_prices(%L,%L,%s,%L)',pg_temp.u(11),pg_temp.u(70),v_ver+1,'[]'),'40001','stale_layout','stale version');
  -- tenant isolation and authority
  perform pg_temp.expect('manager_d',pg_temp.u(11),format('select app.set_service_band_prices(%L,%L,%s,%L)',pg_temp.u(11),pg_temp.u(72),v_ver,'[]'),'P0002','service_not_found','another tenant''s service');
  perform pg_temp.expect('manager_d',pg_temp.u(11),format('select app.set_service_band_prices(%L,%L,%s,%L)',pg_temp.u(12),pg_temp.u(72),1,'[]'),'42501','not_authorized','p_org is not the selected tenant');
  perform pg_temp.expect('owner_o',pg_temp.u(12),format('select app.set_service_band_prices(%L,%L,%s,%L)',pg_temp.u(11),pg_temp.u(70),v_ver,'[]'),'42501','not_authorized','another tenant''s owner');
  perform pg_temp.expect('staff_d',pg_temp.u(11),format('select app.set_service_band_prices(%L,%L,%s,%L)',pg_temp.u(11),pg_temp.u(70),v_ver,'[]'),'42501','not_authorized','staff without service.manage');
  perform pg_temp.expect('anon',null,format('select app.set_service_band_prices(%L,%L,%s,%L)',pg_temp.u(11),pg_temp.u(70),v_ver,'[]'),'42501','permission denied%','anon');
  perform pg_temp.expect('owner_l',pg_temp.u(10),format('select app.set_service_band_prices(%L,%L,%s,%L)',pg_temp.u(10),pg_temp.u(71),1,'[]'),'42501','dynamic_mode_required','legacy-mode organization');
  perform pg_temp.expect('manager_d',pg_temp.u(11),format('select app.set_service_band_prices(%L,%L,%s,%L)',pg_temp.u(11),pg_temp.u(70),v_ver,'[{"band_key":"small","price":1}]') || '; select 1/0','22012','division by zero','sanity: statement list executes');
  if (select price from public.service_band_prices where service_id=pg_temp.u(70) and pricing_key='small') is not null then
    -- the failed attempt above ran in a savepoint; the committed state must still have no `small` row
    raise exception 'FAIL rolled-back price attempt leaked'; end if;
  -- a price for a service of D must not exist for O
  if exists (select 1 from public.service_band_prices where organization_id=pg_temp.u(12)) then raise exception 'FAIL tenant leak'; end if;
  raise notice 'PASS T-DB-06 service band prices: manager and owner save, copy_from, replace semantics, base fallback, validation, stale/tenant/authority refusals, audit, no layout bump';
end $$;

-- ------------------------------------------------ grants, search paths, RLS
do $$
declare r record; v_n integer := 0;
begin
  for r in select p.oid, p.oid::regprocedure::text sig, p.proname, p.prosecdef, p.proconfig, p.proacl, p.proowner from pg_proc p join pg_namespace n on n.oid=p.pronamespace
           where n.nspname='app' and p.proname in ('size_band_slug','size_band_new_key','size_band_snapshot','size_band_audit','size_layout_is_legacy_five','size_band_mirror_legacy',
             'size_band_authorize','size_band_lock_settings','size_layout_plan','size_layout_apply','size_layout_reband_pets','size_band_references',
             'preview_size_layout_impact','save_size_bands','archive_size_band','delete_size_band','set_service_band_prices','set_size_band_mode') loop
    v_n := v_n + 1;
    if r.proname <> 'size_band_slug' and not r.prosecdef then raise exception 'FAIL % must be SECURITY DEFINER', r.sig; end if;
    if r.proconfig is null or not (r.proconfig @> array['search_path=""']) then raise exception 'FAIL % must pin an empty search_path', r.sig; end if;
    if exists (select 1 from aclexplode(coalesce(r.proacl, acldefault('f', r.proowner))) a where a.privilege_type='EXECUTE'
               and (a.grantee = 0 or a.grantee = (select oid from pg_roles where rolname='anon'))) then
      raise exception 'FAIL % is executable by PUBLIC/anon', r.sig; end if;
    if r.proname in ('preview_size_layout_impact','save_size_bands','archive_size_band','delete_size_band','set_service_band_prices','set_size_band_mode') then
      if not has_function_privilege('authenticated', r.oid, 'execute') then raise exception 'FAIL % must be executable by authenticated', r.sig; end if;
    elsif has_function_privilege('authenticated', r.oid, 'execute') then raise exception 'FAIL internal % is client-callable', r.sig; end if;
  end loop;
  if v_n <> 18 then raise exception 'FAIL audited % functions, expected 18', v_n; end if;
  if (select proacl::text from pg_proc where oid='app.set_dog_size_boundaries(uuid,numeric,numeric,numeric,numeric)'::regprocedure) <> '{postgres=X/postgres,authenticated=X/postgres}'
     or (select proargtypes::text from pg_proc where oid='app.set_dog_size_boundaries(uuid,numeric,numeric,numeric,numeric)'::regprocedure) is null then
    raise exception 'FAIL wrapper grants changed'; end if;
  -- the redefined package guards stay trigger-only (no execute for clients beyond the pre-existing default)
  if (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='app' and p.proname like 'assembly%') <> 8 then raise exception 'FAIL assembly count'; end if;
  raise notice 'PASS R-09 % management/internal functions: definer, empty search_path, no PUBLIC/anon execute, only the six RPCs granted to authenticated; wrapper ACL unchanged', v_n;
end $$;

do $$
begin
  perform pg_temp.expect('owner_d',pg_temp.u(11),format('insert into public.organization_size_bands(organization_id,band_key,label,sort_order,upper_kg) values (%L,%L,%L,99,60)',pg_temp.u(11),'zz','ZZ'),'42501','permission denied%','owner direct insert');
  perform pg_temp.expect('owner_d',pg_temp.u(11),'update public.organization_size_bands set label=''x''','42501','permission denied%','owner direct update');
  perform pg_temp.expect('owner_d',pg_temp.u(11),'delete from public.organization_size_bands','42501','permission denied%','owner direct delete');
  perform pg_temp.expect('owner_d',pg_temp.u(11),'update public.organization_size_band_settings set mode=''legacy''','42501','permission denied%','owner flips mode directly');
  perform pg_temp.expect('manager_d',pg_temp.u(11),'insert into public.service_band_prices(organization_id,service_id,pricing_key,price) select organization_id,id,''cat'',1 from public.service_catalog','42501','permission denied%','manager direct price insert');
  perform pg_temp.expect('anon',null,'select count(*) from public.organization_size_bands','42501','permission denied%','anon read');
  perform pg_temp.act('manager_d',pg_temp.u(11));
  if exists (select 1 from public.organization_size_bands where organization_id <> pg_temp.u(11)) or exists (select 1 from public.service_band_prices where organization_id <> pg_temp.u(11)) then
    raise exception 'FAIL cross-tenant read'; end if;
  if (select count(*) from public.organization_size_bands where organization_id=pg_temp.u(11)) < 10 then raise exception 'FAIL members must read their active org bands'; end if;
  perform pg_temp.sup();
  raise notice 'PASS R-01..R-07 real authenticated/anon roles: direct DML denied, no cross-tenant read, members read their tenant';
end $$;

-- ------------------------------------------------------- hard delete guards
do $$
declare v_ver integer := pg_temp.ver(pg_temp.u(11)); v jsonb; v_a integer; v_bx uuid := pg_temp.band(pg_temp.u(11),'band_x'); v_m uuid;
begin
  perform pg_temp.expect('owner_d',pg_temp.u(11),format('select app.delete_size_band(%L,%s,%L)',pg_temp.u(11),v_ver,pg_temp.band(pg_temp.u(11),'xxl')),'22023','size_band_not_archived','delete an active band');
  perform pg_temp.expect('owner_d',pg_temp.u(11),format('select app.delete_size_band(%L,%s,%L)',pg_temp.u(11),v_ver,pg_temp.band(pg_temp.u(11),'cat')),'23514','size_band_cat_permanent','delete cat');
  perform pg_temp.expect('owner_d',pg_temp.u(11),format('select app.delete_size_band(%L,%s,%L)',pg_temp.u(11),v_ver+1,v_bx),'40001','stale_layout','delete stale');
  perform pg_temp.expect('owner_d',pg_temp.u(11),format('select app.delete_size_band(%L,%s,%L)',pg_temp.u(11),v_ver,pg_temp.band(pg_temp.u(12),'small')),'P0002','size_band_not_found','delete another tenant''s band');
  -- 1) soft-deleted pet and 2) deleted+inactive package reference band_x
  perform pg_temp.expect_d('owner_d',pg_temp.u(11),format('select app.delete_size_band(%L,%s,%L)',pg_temp.u(11),v_ver,v_bx),'23503','size_band_in_use',
    '{"pets":1,"packages":1,"entitlements":0,"lines":0,"payroll":0,"prices":0}','soft-deleted pet + deleted package');
  delete from public.pets where id=pg_temp.u(120);
  perform pg_temp.expect_d('owner_d',pg_temp.u(11),format('select app.delete_size_band(%L,%s,%L)',pg_temp.u(11),v_ver,v_bx),'23503','size_band_in_use','{"pets":0,"packages":1}','deleted package only');
  delete from public.packages where id=pg_temp.u(122);
  -- 3) entitlement snapshot
  update public.customer_packages set size_band_snapshot='band_x' where id=pg_temp.u(101);
  perform pg_temp.expect_d('owner_d',pg_temp.u(11),format('select app.delete_size_band(%L,%s,%L)',pg_temp.u(11),v_ver,v_bx),'23503','size_band_in_use','{"entitlements":1,"packages":0}','entitlement snapshot');
  update public.customer_packages set size_band_snapshot=null where id=pg_temp.u(101);
  -- 4) a voided (soft-deleted) historical line snapshot
  insert into public.grooming_job_pet_services(id,organization_id,grooming_job_pet_id,service_id,service_name_snapshot,duration_minutes,quantity,unit_price_snapshot,currency,pet_size_snapshot,price_source,deleted_at)
  values (pg_temp.u(125),pg_temp.u(11),pg_temp.u(111),pg_temp.u(70),'D Basic',60,1,1,'IDR','band_x','base',now());
  perform pg_temp.expect_d('owner_d',pg_temp.u(11),format('select app.delete_size_band(%L,%s,%L)',pg_temp.u(11),v_ver,v_bx),'23503','size_band_in_use','{"lines":1,"entitlements":0}','voided line snapshot');
  update public.grooming_job_pet_services set pet_size_snapshot=null where id=pg_temp.u(125);
  -- 5) payroll matrices (org default and per-staff). SB-06 refuses NEW matrix entries for an archived band, so the
  --    pre-validation rows this guard exists for are reproduced with the matrix trigger off (legacy data).
  alter table public.payroll_cycle_settings disable trigger trg_pcs_validate_size_matrix;
  alter table public.staff_payroll_settings disable trigger trg_sps_validate_size_matrix;
  insert into public.payroll_cycle_settings(organization_id,cycle_start_day,botak_amount_default,per_pet_amount_default,per_pet_size_matrix_default,styling_tiers_default)
  values (pg_temp.u(11),26,10000,20000,'{"band_x":1000}'::jsonb,'[]'::jsonb);
  perform pg_temp.expect_d('owner_d',pg_temp.u(11),format('select app.delete_size_band(%L,%s,%L)',pg_temp.u(11),v_ver,v_bx),'23503','size_band_in_use','{"payroll":1,"lines":0}','org payroll matrix');
  update public.payroll_cycle_settings set per_pet_size_matrix_default='{}'::jsonb where organization_id=pg_temp.u(11);
  insert into public.staff_payroll_settings(organization_id,membership_id,per_pet_enabled,per_pet_size_matrix)
  select pg_temp.u(11),m.id,true,'{"band_x":5}'::jsonb from public.memberships m where m.organization_id=pg_temp.u(11) and m.user_id=pg_temp.u(34);
  perform pg_temp.expect_d('owner_d',pg_temp.u(11),format('select app.delete_size_band(%L,%s,%L)',pg_temp.u(11),v_ver,v_bx),'23503','size_band_in_use','{"payroll":1}','staff payroll matrix');
  update public.staff_payroll_settings set per_pet_size_matrix=null where organization_id=pg_temp.u(11);
  alter table public.payroll_cycle_settings enable trigger trg_pcs_validate_size_matrix;
  alter table public.staff_payroll_settings enable trigger trg_sps_validate_size_matrix;
  -- 6) a non-empty service price row (an empty row never blocks)
  insert into public.service_band_prices(organization_id,service_id,pricing_key,price) values (pg_temp.u(11),pg_temp.u(70),'band_x',5);
  perform pg_temp.expect_d('owner_d',pg_temp.u(11),format('select app.delete_size_band(%L,%s,%L)',pg_temp.u(11),v_ver,v_bx),'23503','size_band_in_use','{"prices":1,"payroll":0}','service price row');
  update public.service_band_prices set price=null where pricing_key='band_x' and organization_id=pg_temp.u(11);
  -- now unreferenced: delete succeeds, empty price rows go with it, the layout is untouched
  v_a := pg_temp.audits(pg_temp.u(11));
  perform pg_temp.act('owner_d',pg_temp.u(11));
  v := app.delete_size_band(pg_temp.u(11),v_ver,v_bx);
  perform pg_temp.sup();
  if exists (select 1 from public.organization_size_bands where id=v_bx) or exists (select 1 from public.service_band_prices where organization_id=pg_temp.u(11) and pricing_key='band_x')
     or pg_temp.ver(pg_temp.u(11)) <> v_ver or pg_temp.audits(pg_temp.u(11)) <> v_a+1 or v->>'deleted_key' <> 'band_x' then
    raise exception 'FAIL delete result: %', v; end if;
  -- the archived mid band left no references either
  perform pg_temp.act('owner_d',pg_temp.u(11));
  perform app.delete_size_band(pg_temp.u(11),v_ver,pg_temp.band(pg_temp.u(11),'xxl_2'));
  perform pg_temp.sup();
  raise notice 'PASS T-DB-05c hard delete: refused for each reference type (soft-deleted pet, deleted package, entitlement snapshot, voided line, org/staff payroll matrices, non-empty price) and allowed once unreferenced';
end $$;

-- ----------- dual-write correctness, then rollback rules (platform-controlled)
do $$
declare v_ver integer := pg_temp.ver(pg_temp.u(11)); v jsonb; r record; v_n integer := 0;
begin
  perform pg_temp.expect('platform',pg_temp.u(11),format('select app.set_size_band_mode(%L,%L,%s)',pg_temp.u(11),'legacy',v_ver),'22023','rollback_blocked_custom_bands','rollback with custom bands');
  perform pg_temp.expect('owner_d',pg_temp.u(11),format('select app.set_size_band_mode(%L,%L,%s)',pg_temp.u(11),'legacy',v_ver),'42501','not_authorized','owner rollback');
  -- retire the custom bands (top first): the layout becomes the legacy five again
  perform pg_temp.act('owner_d',pg_temp.u(11));
  perform app.archive_size_band(pg_temp.u(11),v_ver,pg_temp.band(pg_temp.u(11),'band_2xl'));
  perform app.archive_size_band(pg_temp.u(11),v_ver+1,pg_temp.band(pg_temp.u(11),'xxl'));
  perform pg_temp.sup();
  v_ver := v_ver + 2;
  if pg_temp.keys(pg_temp.u(11)) <> 'extra_small=5,small=10,medium=16,large=25i,extra_large=open' then raise exception 'FAIL layout after retiring custom bands: %', pg_temp.keys(pg_temp.u(11)); end if;
  if (select xs_lt_kg||','||s_lt_kg||','||m_lt_kg||','||l_lte_kg from public.organization_dog_size_boundaries where organization_id=pg_temp.u(11)) <> '5.00,10.00,16.00,25.00' then
    raise exception 'FAIL legacy boundary row was not re-synced'; end if;
  if (select price_extra_large||'/'||duration_extra_large||'/'||coalesce(price_small::text,'null') from public.service_catalog where id=pg_temp.u(70)) <> '300000.00/120/null' then
    raise exception 'FAIL legacy catalog columns were not re-synced: %', (select price_extra_large||'/'||duration_extra_large||'/'||coalesce(price_small::text,'null') from public.service_catalog where id=pg_temp.u(70)); end if;
  -- while dynamic, answers equal the legacy columns/boundary row (oracle) for every D pet x service
  for r in select p.species, p.weight_kg w, p.size, s.id svc from public.pets p join public.service_catalog s on s.organization_id=p.organization_id
           where p.organization_id=pg_temp.u(11) and p.deleted_at is null and s.is_active loop
    v_n := v_n + 1;
    if pg_temp.new_line(pg_temp.u(11),r.svc,r.species,r.w,r.size,2) is distinct from pg_temp.old_line(pg_temp.u(11),r.svc,r.species,r.w,r.size,2) then
      raise exception 'FAIL dual-write mismatch: dynamic [%] vs legacy columns [%]', pg_temp.new_line(pg_temp.u(11),r.svc,r.species,r.w,r.size,2), pg_temp.old_line(pg_temp.u(11),r.svc,r.species,r.w,r.size,2); end if;
  end loop;
  perform pg_temp.expect('platform',pg_temp.u(11),format('select app.set_size_band_mode(%L,%L,%s)',pg_temp.u(11),'legacy',v_ver+1),'40001','stale_layout','rollback stale');
  perform pg_temp.act('platform',pg_temp.u(11));
  v := app.set_size_band_mode(pg_temp.u(11),'legacy',v_ver);
  perform pg_temp.sup();
  if v->>'mode' <> 'legacy' or (select mode from public.organization_size_band_settings where organization_id=pg_temp.u(11)) <> 'legacy' then raise exception 'FAIL rollback'; end if;
  -- legacy again: writers behave exactly as before, management RPCs are unavailable
  perform pg_temp.expect('owner_d',pg_temp.u(11),format('select app.save_size_bands(%L,%s,pg_temp.cur(%L))',pg_temp.u(11),v_ver+1,pg_temp.u(11)),'42501','dynamic_mode_required','owner after rollback');
  perform pg_temp.act('owner_d',pg_temp.u(11));
  perform app.set_dog_size_boundaries(pg_temp.u(11),5,10,15,25);
  perform pg_temp.sup();
  if pg_temp.new_line(pg_temp.u(11),pg_temp.u(70),'dog',25.01,null,1) is distinct from pg_temp.old_line(pg_temp.u(11),pg_temp.u(70),'dog',25.01,null,1)
     or pg_temp.size(pg_temp.u(11),'W3501') <> 'extra_large' or pg_temp.size(pg_temp.u(11),'W50') <> 'extra_large' then raise exception 'FAIL post-rollback behaviour'; end if;
  raise notice 'PASS T-DB-11b rollback only when representable (% pet x service answers equal the legacy columns while dynamic), re-syncs legacy writers, legacy path works again', v_n;
end $$;

-- platform owner re-activates; last-band guard on a tenant with only platform authority
insert into public.organizations(id,name,slug,status) values (pg_temp.u(14),'SB2 Solo','sb2-solo','active');
do $$
declare v jsonb; v_ver integer; b text;
begin
  perform pg_temp.act('platform',pg_temp.u(14));
  v := app.set_size_band_mode(pg_temp.u(14),'dynamic',1);
  v_ver := (v->>'layout_version')::integer;
  foreach b in array array['extra_small','small','medium','large'] loop
    v := app.archive_size_band(pg_temp.u(14),v_ver,pg_temp.band(pg_temp.u(14),b));
    v_ver := (v->>'layout_version')::integer;
  end loop;
  perform pg_temp.sup();
  if pg_temp.keys(pg_temp.u(14)) <> 'extra_large=open' then raise exception 'FAIL solo layout: %', pg_temp.keys(pg_temp.u(14)); end if;
  perform pg_temp.expect('platform',pg_temp.u(14),format('select app.archive_size_band(%L,%s,%L)',pg_temp.u(14),v_ver,pg_temp.band(pg_temp.u(14),'extra_large')),'22023','last_size_band','archive the last band');
  -- grow to the 12-band maximum (11 new bands + the existing open band); a 13th is refused
  perform pg_temp.act('platform',pg_temp.u(14));
  v := app.save_size_bands(pg_temp.u(14),v_ver,(select jsonb_agg(jsonb_build_object('label','B'||g,'upper_kg',g*5,'upper_inclusive',false) order by g) from generate_series(1,11) g)
        || jsonb_build_array(jsonb_build_object('id',pg_temp.band(pg_temp.u(14),'extra_large'),'label','XL','upper_kg',null,'upper_inclusive',false)));
  perform pg_temp.sup();
  v_ver := (v->>'layout_version')::integer;
  if (select count(*) from public.organization_size_bands where organization_id=pg_temp.u(14) and band_kind='dog_weight' and status='active') <> 12 then raise exception 'FAIL 12 bands'; end if;
  perform pg_temp.expect('platform',pg_temp.u(14),format('select app.save_size_bands(%L,%s,%L)',pg_temp.u(14),v_ver,pg_temp.cur(pg_temp.u(14))||'[{"label":"Extra","upper_kg":null}]'::jsonb),'22023','invalid_size_layout','13 bands');
  raise notice 'PASS T-DB-05d platform authority on its selected tenant; last-band guard; 12-band maximum';
exception when others then
  perform pg_temp.sup();
  raise;
end $$;
