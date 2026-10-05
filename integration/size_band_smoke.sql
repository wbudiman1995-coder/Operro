\set ON_ERROR_STOP on
-- Behavioral proof for dynamic size bands (SB-01..SB-04). Disposable database
-- only; run from the repository root after all migrations:
--   psql <db> -v ON_ERROR_STOP=1 -f integration/size_band_smoke.sql
-- Golden vectors are shared with the TypeScript bundle.
\set vectors `cat integration/size_band_golden_vectors.json`
select set_config('request.jwt.claims','{}',false) as c \gset
select set_config('sb.vectors',:'vectors',false) as v \gset

create function pg_temp.u(n integer) returns uuid language sql immutable as
$$ select ('5b000000-0000-4000-8000-' || lpad(to_hex(n), 12, '0'))::uuid $$;

-- Mutation must be refused (at statement time or when deferred constraints are
-- forced at commit). The savepoint rolls the attempt back either way.
create function pg_temp.expect_fail(p_sql text, p_pattern text, p_label text) returns void
language plpgsql as $$
begin
  begin
    execute p_sql;
    set constraints all immediate;
    raise exception 'ACCEPTED';
  exception when others then
    if sqlerrm = 'ACCEPTED' then raise exception 'FAIL % was accepted', p_label; end if;
    if sqlerrm not like p_pattern then
      raise exception 'FAIL %: expected like [%] got [%] (%)', p_label, p_pattern, sqlerrm, sqlstate; end if;
  end;
end $$;
create function pg_temp.expect_ok(p_sql text, p_label text) returns void
language plpgsql as $$
begin
  begin
    execute p_sql;
    set constraints all immediate;
    raise exception 'ROLLBACK_OK';
  exception when others then
    if sqlerrm <> 'ROLLBACK_OK' then raise exception 'FAIL % was refused: [%] (%)', p_label, sqlerrm, sqlstate; end if;
  end;
end $$;

-- ---------------------------------------------------------------- fixtures
insert into public.organizations(id,name,slug,status) values
  (pg_temp.u(10),'SB Org A','sb-org-a','active'),
  (pg_temp.u(11),'SB Org B','sb-org-b','active'),
  (pg_temp.u(12),'SB Org Validator','sb-org-v','active'),
  (pg_temp.u(13),'SB Org Household','sb-org-h','active');
insert into public.branches(id,organization_id,name,is_default,status)
select pg_temp.u(20),pg_temp.u(10),'SB Branch A',true,'active';
insert into auth.users(id,email) values
  (pg_temp.u(31),'sb-owner-a@qc.local'),(pg_temp.u(32),'sb-staff-a@qc.local'),
  (pg_temp.u(33),'sb-owner-b@qc.local'),(pg_temp.u(34),'sb-owner-h@qc.local');
insert into public.users(id,full_name,email,status) values
  (pg_temp.u(31),'SB Owner A','sb-owner-a@qc.local','active'),(pg_temp.u(32),'SB Staff A','sb-staff-a@qc.local','active'),
  (pg_temp.u(33),'SB Owner B','sb-owner-b@qc.local','active'),(pg_temp.u(34),'SB Owner H','sb-owner-h@qc.local','active')
on conflict (id) do update set full_name=excluded.full_name,email=excluded.email,status=excluded.status;
insert into public.roles(id,organization_id,name,is_system) values
  (pg_temp.u(41),pg_temp.u(10),'Owner',true),(pg_temp.u(42),pg_temp.u(10),'Staff',false),
  (pg_temp.u(43),pg_temp.u(11),'Owner',true),(pg_temp.u(44),pg_temp.u(13),'Owner',true);
insert into public.memberships(id,organization_id,user_id,role_id,status) values
  (pg_temp.u(51),pg_temp.u(10),pg_temp.u(31),pg_temp.u(41),'active'),
  (pg_temp.u(52),pg_temp.u(10),pg_temp.u(32),pg_temp.u(42),'active'),
  (pg_temp.u(53),pg_temp.u(11),pg_temp.u(33),pg_temp.u(43),'active'),
  (pg_temp.u(54),pg_temp.u(13),pg_temp.u(34),pg_temp.u(44),'active');
insert into public.membership_branch_access(organization_id,membership_id,branch_id)
values (pg_temp.u(10),pg_temp.u(51),pg_temp.u(20));
insert into public.role_permissions(organization_id,role_id,permission_id)
select o.org,o.role,p.id from (values (pg_temp.u(10),pg_temp.u(41)),(pg_temp.u(13),pg_temp.u(44))) o(org,role)
cross join public.permissions p where p.key in ('customer.manage','booking.update','service.manage')
on conflict do nothing;
insert into public.role_permissions(organization_id,role_id,permission_id)
select pg_temp.u(10),pg_temp.u(42),id from public.permissions where key in ('booking.update') on conflict do nothing;
insert into public.organization_modules(organization_id,module_id,enabled)
select o,m.id,true from (values (pg_temp.u(10)),(pg_temp.u(11)),(pg_temp.u(13))) v(o)
cross join public.modules m where m.key in ('scheduling','crm')
on conflict (organization_id,module_id) do update set enabled=true;
insert into public.subscriptions(organization_id,status)
values (pg_temp.u(10),'active'),(pg_temp.u(11),'active'),(pg_temp.u(13),'active') on conflict do nothing;
insert into public.customers(id,organization_id,display_name,status)
values (pg_temp.u(60),pg_temp.u(10),'SB Customer A','active'),(pg_temp.u(61),pg_temp.u(11),'SB Customer B','active');
insert into public.organization_pet_types(organization_id,key,label) values (pg_temp.u(10),'rabbit','Kelinci'),(pg_temp.u(10),'turtle','Kura-kura');

-- ------------------------------------------------- T-DB-02 seed for new orgs
do $$ declare v_org uuid; v_n integer; begin
  foreach v_org in array array[pg_temp.u(10),pg_temp.u(11),pg_temp.u(12)] loop
    select count(*) into v_n from public.organization_size_bands where organization_id=v_org;
    if v_n <> 6 then raise exception 'org % expected 6 seeded bands, got %', v_org, v_n; end if;
    if (select mode||':'||layout_version from public.organization_size_band_settings where organization_id=v_org) <> 'legacy:1' then
      raise exception 'org % settings not legacy:1', v_org; end if;
    if (select string_agg(band_key||'='||coalesce(trim_scale(upper_kg)::text,'open')||case when upper_inclusive then 'i' else '' end,',' order by sort_order)
        from public.organization_size_bands where organization_id=v_org)
       <> 'extra_small=5,small=10,medium=15,large=25i,extra_large=open,cat=open' then
      raise exception 'org % unexpected seeded layout', v_org; end if;
    if (select string_agg(label,',' order by sort_order) from public.organization_size_bands where organization_id=v_org) <> 'XS,S,M,L,XL,Cat' then
      raise exception 'org % labels', v_org; end if;
  end loop;
  if (select string_agg(band_key||':'||trim_scale(lower_kg)||':'||lower_inclusive,',' order by sort_order)
      from public.organization_size_band_ranges where organization_id=pg_temp.u(10))
     <> 'extra_small:0:false,small:5:true,medium:10:true,large:15:true,extra_large:25:false' then
    raise exception 'ranges view lower bounds wrong: %', (select string_agg(band_key||':'||trim_scale(lower_kg)||':'||lower_inclusive,',' order by sort_order) from public.organization_size_band_ranges where organization_id=pg_temp.u(10)); end if;
  raise notice 'PASS T-DB-02 new organizations seed five legacy bands + cat, legacy mode, 5/10/15/25 with inclusive large';
end $$;

-- ------------------------------------------- T-DB-03/04 layout validation
do $$
declare v uuid := pg_temp.u(12);
begin
  perform pg_temp.expect_fail(format($f$insert into public.organization_size_bands(organization_id,band_key,label,sort_order,upper_kg)
    select %L,'x'||g,'X'||g,100+g,100+g from generate_series(1,8) g$f$,v),'size_band_layout_invalid: 13 active dog bands%','13 bands');
  perform pg_temp.expect_fail(format($f$update public.organization_size_bands set status='archived',archived_at=now() where organization_id=%L and band_key='extra_large'$f$,v),
    'size_band_layout_invalid: exactly one open-ended top band required, found 0','no open top');
  perform pg_temp.expect_fail(format($f$update public.organization_size_bands set upper_kg=null,upper_inclusive=false where organization_id=%L and band_key='large'$f$,v),
    '%uq_size_band_open_top%','two open-ended bands');
  perform pg_temp.expect_fail(format($f$update public.organization_size_bands set upper_kg=5 where organization_id=%L and band_key='small'$f$,v),
    'size_band_layout_invalid: upper bounds must strictly ascend%','equal uppers');
  perform pg_temp.expect_fail(format($f$update public.organization_size_bands set upper_kg=12 where organization_id=%L and band_key='extra_small'$f$,v),
    'size_band_layout_invalid: upper bounds must strictly ascend%','descending uppers');
  perform pg_temp.expect_fail(format($f$update public.organization_size_bands set sort_order=5 where organization_id=%L and band_key='extra_large'$f$,v),
    'size_band_layout_invalid: upper bounds must strictly ascend%','open band not last');
  perform pg_temp.expect_fail(format($f$update public.organization_size_bands set sort_order=10 where organization_id=%L and band_key='small'$f$,v),
    'size_band_layout_invalid: duplicate sort_order','duplicate sort_order');
  perform pg_temp.expect_fail(format($f$update public.organization_size_bands set upper_kg=0 where organization_id=%L and band_key='extra_small'$f$,v),
    '%violates check constraint%','upper_kg=0');
  perform pg_temp.expect_fail(format($f$update public.organization_size_bands set upper_kg=1000 where organization_id=%L and band_key='large'$f$,v),
    '%violates check constraint%','upper_kg>999');
  perform pg_temp.expect_fail(format($f$update public.organization_size_bands set status='archived',archived_at=now() where organization_id=%L and band_kind='dog_weight'$f$,v),
    'size_band_layout_invalid: 0 active dog bands%','0 active dog bands');
  perform pg_temp.expect_fail(format($f$insert into public.organization_size_bands(organization_id,band_key,label,sort_order,upper_kg) values (%L,'Bad-Key','X',99,60)$f$,v),
    '%violates check constraint%','key regex');
  perform pg_temp.expect_fail(format($f$insert into public.organization_size_bands(organization_id,band_key,label,sort_order,upper_kg) values (%L,'dog','X',99,60)$f$,v),
    'size_band_key_reserved','reserved key dog');
  perform pg_temp.expect_fail(format($f$insert into public.organization_size_bands(organization_id,band_key,label,sort_order,upper_kg) values (%L,'cat','X',99,60)$f$,v),
    'size_band_key_reserved','dog band named cat');
  perform pg_temp.expect_fail(format($f$insert into public.organization_size_bands(organization_id,band_key,label,sort_order,upper_kg) values (%L,'x','',99,60)$f$,v),
    '%violates check constraint%','empty label');
  insert into public.organization_pet_types(organization_id,key,label) values (v,'ferret','Ferret');
  perform pg_temp.expect_fail(format($f$insert into public.organization_size_bands(organization_id,band_key,label,sort_order,upper_kg) values (%L,'ferret','F',99,60)$f$,v),
    'size_band_key_reserved','band key equals species key');
  perform pg_temp.expect_fail(format($f$insert into public.organization_pet_types(organization_id,key,label) values (%L,'small','Small')$f$,v),
    'pet_type_key_is_size_band','species key equals band key');
  perform pg_temp.expect_fail(format($f$insert into public.organization_size_bands(organization_id,band_key,band_kind,label,sort_order,upper_kg,upper_inclusive) values (%L,'big','dog_weight','Big',99,null,true)$f$,v),
    '%violates check constraint%','inclusive flag on open band');
  -- key/identity immutability and the permanent cat row
  perform pg_temp.expect_fail(format($f$update public.organization_size_bands set band_key='tiny' where organization_id=%L and band_key='extra_small'$f$,v),
    'size_band_key_immutable','band_key immutable');
  perform pg_temp.expect_fail(format($f$update public.organization_size_bands set band_kind='cat' where organization_id=%L and band_key='small'$f$,v),
    'size_band_identity_immutable','band_kind immutable');
  perform pg_temp.expect_fail(format($f$update public.organization_size_bands set organization_id=%L where organization_id=%L and band_key='small'$f$,pg_temp.u(11),v),
    'size_band_identity_immutable','organization immutable');
  perform pg_temp.expect_fail(format($f$update public.organization_size_bands set status='archived',archived_at=now() where organization_id=%L and band_key='cat'$f$,v),
    '%violates check constraint%','cat cannot be archived');
  perform pg_temp.expect_fail(format($f$delete from public.organization_size_bands where organization_id=%L and band_key='cat'$f$,v),
    'size_band_cat_permanent','cat cannot be deleted');
  perform pg_temp.expect_fail(format($f$insert into public.organization_size_bands(organization_id,band_key,band_kind,label,sort_order) values (%L,'kitty','cat','Kitty',1001)$f$,v),
    '%violates check constraint%','cat kind must be keyed cat');
  perform pg_temp.expect_fail(format($f$insert into public.organization_size_bands(organization_id,band_key,band_kind,label,sort_order) values (%L,'cat','cat','Cat 2',1001)$f$,v),
    '%uq_size_bands_org_key%','second cat row');
  perform pg_temp.expect_fail(format($f$update public.organization_size_bands set status='archived',archived_at=null where organization_id=%L and band_key='small'$f$,v),
    '%violates check constraint%','archive without stamp');
  -- accepted layouts: 12 bands (the maximum) and a single open band
  perform pg_temp.expect_ok(format($f$
    update public.organization_size_bands set sort_order=200 where organization_id=%L and band_key='extra_large';
    insert into public.organization_size_bands(organization_id,band_key,label,sort_order,upper_kg)
    select %L,'k'||g,'K'||g,60+g*10,25+g*5 from generate_series(1,7) g$f$,v,v),'12 active dog bands');
  perform pg_temp.expect_ok(format($f$update public.organization_size_bands set status='archived',archived_at=now()
    where organization_id=%L and band_kind='dog_weight' and band_key<>'extra_large'$f$,v),'single open band');
  -- a layout may pass through invalid intermediate states inside one transaction
  perform pg_temp.expect_ok(format($f$
    update public.organization_size_bands set upper_kg=11 where organization_id=%L and band_key='extra_small';
    update public.organization_size_bands set upper_kg=12 where organization_id=%L and band_key='small';
    update public.organization_size_bands set upper_kg=13 where organization_id=%L and band_key='medium'$f$,v,v,v),'multi-step reorder');
  raise notice 'PASS T-DB-03/04 layout validator, 12-band cap, open-band uniqueness, immutable keys, permanent cat';
end $$;

-- ----------------------------------- legacy golden: new vs inline old function
\ir size_band_oracle.sql

do $$
declare v_org uuid; v_cust uuid; i integer; v_xs numeric; v_s numeric; v_m numeric; v_l numeric;
        w numeric; v_bad integer := 0; v_checked integer := 0; v_new text; v_old text; v_pet uuid; b numeric;
begin
  perform setseed(0.4242);
  for i in 1..30 loop
    v_org := ('5b100000-0000-4000-8000-' || lpad(i::text,12,'0'))::uuid;
    insert into public.organizations(id,name,slug,status) values (v_org,'SB Rand '||i,'sb-rand-'||i,'active');
    insert into public.customers(organization_id,display_name,status) values (v_org,'Rand '||i,'active') returning id into v_cust;
    if i > 2 then  -- orgs 1-2 keep NO boundary row (defaults); 3 uses the {6,11,16,26} case
      if i = 3 then v_xs:=6; v_s:=11; v_m:=16; v_l:=26;
      else
        v_xs := round((0.5 + random()*9)::numeric,2);
        v_s := v_xs + round((0.01 + random()*9)::numeric,2);
        v_m := v_s + round((0.01 + random()*9)::numeric,2);
        v_l := v_m + round((0.01 + random()*40)::numeric,2);
      end if;
      insert into public.organization_dog_size_boundaries(organization_id,xs_lt_kg,s_lt_kg,m_lt_kg,l_lte_kg) values (v_org,v_xs,v_s,v_m,v_l);
      -- a second write path: update, which the shadow trigger must also mirror
      if i % 2 = 0 then update public.organization_dog_size_boundaries set l_lte_kg=l_lte_kg where organization_id=v_org; end if;
    end if;
    for w in select * from (select unnest(array[0.01,0.5,999,1000,5000]) union all
        select x from (select b0.b from (select xs_lt_kg b from public.organization_dog_size_boundaries where organization_id=v_org
          union all select s_lt_kg from public.organization_dog_size_boundaries where organization_id=v_org
          union all select m_lt_kg from public.organization_dog_size_boundaries where organization_id=v_org
          union all select l_lte_kg from public.organization_dog_size_boundaries where organization_id=v_org
          union all select 5 where not exists(select 1 from public.organization_dog_size_boundaries where organization_id=v_org)
          union all select 10 where not exists(select 1 from public.organization_dog_size_boundaries where organization_id=v_org)
          union all select 15 where not exists(select 1 from public.organization_dog_size_boundaries where organization_id=v_org)
          union all select 25 where not exists(select 1 from public.organization_dog_size_boundaries where organization_id=v_org)) b0) bb,
        lateral unnest(array[bb.b-0.01,bb.b,bb.b+0.01]) x) t(w) loop
      if w <= 0 then continue; end if;
      v_new := app.dog_size_for_weight(v_org,w); v_old := pg_temp.old_dog_size(v_org,w);
      v_checked := v_checked + 1;
      if v_new is distinct from v_old
         or app.pet_pricing_key(v_org,'dog',w,'small') is distinct from v_old then
        v_bad := v_bad + 1; raise warning 'org % weight %: new % old %', v_org, w, v_new, v_old; end if;
      insert into public.pets(organization_id,customer_id,name,species,weight_kg,status)
      values (v_org,v_cust,'p','dog',w,'active') returning id into v_pet;
      if (select size from public.pets where id=v_pet) is distinct from v_old then
        v_bad := v_bad + 1; raise warning 'org % weight %: pets.size % old %', v_org, w, (select size from public.pets where id=v_pet), v_old; end if;
    end loop;
    -- shadow bands equal the boundary row
    if (select string_agg(coalesce(trim_scale(upper_kg)::text,'open')||case when upper_inclusive then 'i' else '' end,',' order by sort_order)
        from public.organization_size_bands where organization_id=v_org and band_kind='dog_weight')
       is distinct from coalesce((select trim_scale(xs_lt_kg)||','||trim_scale(s_lt_kg)||','||trim_scale(m_lt_kg)||','||trim_scale(l_lte_kg)||'i,open' from public.organization_dog_size_boundaries where organization_id=v_org),'5,10,15,25i,open') then
      v_bad := v_bad + 1; raise warning 'org %: shadow bands differ from boundaries', v_org; end if;
  end loop;
  if v_bad > 0 then raise exception 'FAIL legacy golden equivalence: % differences over % checks', v_bad, v_checked; end if;
  raise notice 'PASS T-DB-05 legacy equivalence: 30 organizations, % weight checks, 0 differences (function, pricing key, trigger-written pets.size, shadow bands)', v_checked;
end $$;

-- ------------------------------ shared golden vectors (SQL side of T-TS-04)
create function pg_temp.apply_layout(p_org uuid, p_layout jsonb) returns void language plpgsql as $$
declare v_bands jsonb := p_layout->'bands'; v_b jsonb; v_i integer := 0; v_keys text[];
begin
  if p_layout->>'mode' = 'legacy' then
    if p_layout->>'id' <> 'default' then   -- default = organization without a boundary row
      insert into public.organization_dog_size_boundaries(organization_id,xs_lt_kg,s_lt_kg,m_lt_kg,l_lte_kg)
      values (p_org,(v_bands->0->>'upper_kg')::numeric,(v_bands->1->>'upper_kg')::numeric,(v_bands->2->>'upper_kg')::numeric,(v_bands->3->>'upper_kg')::numeric);
    end if;
    return;
  end if;
  select array_agg(x->>'key') into v_keys from jsonb_array_elements(v_bands) x;
  update public.organization_size_bands set status='archived', archived_at=now()
  where organization_id=p_org and band_kind='dog_weight' and status='active' and band_key <> all (v_keys);
  for v_b in select * from jsonb_array_elements(v_bands) loop
    v_i := v_i + 1;
    insert into public.organization_size_bands(organization_id,band_key,label,sort_order,upper_kg,upper_inclusive)
    values (p_org,v_b->>'key',v_b->>'label',v_i*10,(v_b->>'upper_kg')::numeric,(v_b->>'upper_inclusive')::boolean)
    on conflict (organization_id,band_key) do update set label=excluded.label,sort_order=excluded.sort_order,
      upper_kg=excluded.upper_kg,upper_inclusive=excluded.upper_inclusive,status='active',archived_at=null;
  end loop;
  update public.organization_size_band_settings set mode='dynamic', layout_version=layout_version+1 where organization_id=p_org;
end $$;

do $$
declare v jsonb := current_setting('sb.vectors')::jsonb; l jsonb; c jsonb; v_org uuid; v_cust uuid; v_n integer := 0; v_i integer := 0; v_pet uuid; v_cases integer := 0;
begin
  for l in select * from jsonb_array_elements(v->'layouts') loop
    v_i := v_i + 1;
    v_org := ('5b200000-0000-4000-8000-' || lpad(v_i::text,12,'0'))::uuid;
    insert into public.organizations(id,name,slug,status) values (v_org,'SB Golden '||(l->>'id'),'sb-golden-'||(l->>'id'),'active');
    insert into public.customers(organization_id,display_name,status) values (v_org,'Golden','active') returning id into v_cust;
    perform pg_temp.apply_layout(v_org,l);
    for c in select * from jsonb_array_elements(v->'cases') where value->>'layout' = l->>'id' loop
      v_cases := v_cases + 1;
      if app.dog_size_for_weight(v_org,(c->>'weight_kg')::numeric) is distinct from c->>'expected_key' then
        raise exception 'FAIL golden % weight %: dog_size_for_weight % expected %', l->>'id', c->>'weight_kg', app.dog_size_for_weight(v_org,(c->>'weight_kg')::numeric), c->>'expected_key'; end if;
      if app.pet_pricing_key(v_org,'dog',(c->>'weight_kg')::numeric,null) is distinct from c->>'expected_key' then
        raise exception 'FAIL golden % weight %: pet_pricing_key', l->>'id', c->>'weight_kg'; end if;
      insert into public.pets(organization_id,customer_id,name,species,weight_kg,status)
      values (v_org,v_cust,'g','dog',(c->>'weight_kg')::numeric,'active') returning id into v_pet;
      if (select size from public.pets where id=v_pet) is distinct from c->>'expected_key' then
        raise exception 'FAIL golden % weight %: pets.size % expected %', l->>'id', c->>'weight_kg', (select size from public.pets where id=v_pet), c->>'expected_key'; end if;
    end loop;
    v_n := v_n + 1;
  end loop;
  -- the edge called out by the product ruling, asserted explicitly on the default layout
  if app.dog_size_for_weight(('5b200000-0000-4000-8000-000000000001')::uuid,25.00) <> 'large'
     or app.dog_size_for_weight(('5b200000-0000-4000-8000-000000000001')::uuid,25.01) <> 'extra_large' then
    raise exception 'FAIL 25.00 must be large and 25.01 extra_large'; end if;
  raise notice 'PASS T-DB-05b shared golden vectors: % layouts, % cases (25.00 -> large, 25.01 -> extra_large)', v_n, v_cases;
end $$;

-- ------------------------------------- T-DB-06 resolver parity (org A, legacy)
-- Inline copy of the pre-SB-03 pricing rules (20261020120000) used as the oracle.
insert into public.service_catalog(id,organization_id,name,duration_minutes,base_price,currency,additional_duration_minutes,
  price_extra_small,price_small,price_medium,price_large,price_extra_large,price_cat,
  duration_extra_small,duration_small,duration_medium,duration_large,duration_extra_large,duration_cat) values
 (pg_temp.u(70),pg_temp.u(10),'SB Full Matrix',60,99000,'IDR',15,99000,120000,170000,230000,269000,125000,50,60,90,120,130,45),
 (pg_temp.u(71),pg_temp.u(10),'SB Base Only',45,50000,'IDR',0,null,null,null,null,null,null,null,null,null,null,null,null),
 (pg_temp.u(72),pg_temp.u(10),'SB Prices Only',30,40000,'IDR',10,null,70000,null,90000,null,null,null,null,null,null,null,null),
 (pg_temp.u(73),pg_temp.u(10),'SB Zero Minute Addon',0,25000,'IDR',0,null,null,null,null,null,null,null,null,null,null,null,null),
 (pg_temp.u(74),pg_temp.u(10),'SB Zero Band Duration',60,30000,'IDR',20,null,null,35000,null,null,null,null,null,0,null,null,0),
 (pg_temp.u(75),pg_temp.u(10),'SB Species Priced',20,10000,'IDR',5,null,15000,null,null,null,null,null,null,null,null,null,null);
update public.service_catalog set species_pricing='{"rabbit":{"price":70000,"duration":40}}'::jsonb where id=pg_temp.u(75);
insert into public.pets(id,organization_id,customer_id,name,species,weight_kg,size,status) values
 (pg_temp.u(80),pg_temp.u(10),pg_temp.u(60),'D3','dog',3,null,'active'),
 (pg_temp.u(81),pg_temp.u(10),pg_temp.u(60),'D7','dog',7,'large','active'),
 (pg_temp.u(82),pg_temp.u(10),pg_temp.u(60),'D12','dog',12,null,'active'),
 (pg_temp.u(83),pg_temp.u(10),pg_temp.u(60),'D25','dog',25.00,null,'active'),
 (pg_temp.u(84),pg_temp.u(10),pg_temp.u(60),'D25b','dog',25.01,null,'active'),
 (pg_temp.u(85),pg_temp.u(10),pg_temp.u(60),'D30','dog',30,null,'active'),
 (pg_temp.u(86),pg_temp.u(10),pg_temp.u(60),'Manual small','dog',null,'small','active'),
 (pg_temp.u(87),pg_temp.u(10),pg_temp.u(60),'Unsized','dog',null,null,'active'),
 (pg_temp.u(88),pg_temp.u(10),pg_temp.u(60),'Kitty','cat',4,'medium','active'),
 (pg_temp.u(89),pg_temp.u(10),pg_temp.u(60),'Bun','rabbit',2,null,'active'),
 (pg_temp.u(90),pg_temp.u(10),pg_temp.u(60),'Shell','turtle',1,null,'active');

create function pg_temp.parity(p_org uuid) returns integer language plpgsql as $$
declare p record; s record; q integer; v_old text; v_new text; v_n integer := 0;
begin
  for p in select id,species,weight_kg,size from public.pets where organization_id=p_org and customer_id=pg_temp.u(60) loop
    for s in select id,name from public.service_catalog where organization_id=p_org loop
      foreach q in array array[1,3] loop
        v_old := pg_temp.old_line(p_org,s.id,p.species,p.weight_kg,p.size,q);
        v_new := pg_temp.new_line(p_org,s.id,p.species,p.weight_kg,p.size,q);
        v_n := v_n + 1;
        if v_old is distinct from v_new then
          raise exception 'FAIL parity pet % service % qty %: old [%] new [%]', p.id, s.name, q, v_old, v_new; end if;
      end loop;
    end loop;
  end loop;
  return v_n;
end $$;

do $$
declare v_n integer; v_org uuid := pg_temp.u(10); v_spot record; v_actual text;
begin
  v_n := pg_temp.parity(v_org);
  -- the matrix must exercise real prices, durations, zero minutes and error codes, not only empty cases
  for v_spot in select * from (values
    ($q$v_org,pg_temp.u(70),'dog',3,null,1$q$, 'extra_small|99000.00|50|size_matrix'),
    ($q$v_org,pg_temp.u(70),'dog',25.00,null,3$q$, 'large|230000.00|150|size_matrix'),
    ($q$v_org,pg_temp.u(70),'dog',25.01,null,1$q$, 'extra_large|269000.00|130|size_matrix'),
    ($q$v_org,pg_temp.u(70),'cat',null,null,1$q$, 'cat|125000.00|45|size_matrix'),
    ($q$v_org,pg_temp.u(71),'dog',12,null,1$q$, 'medium|50000.00|45|base'),
    ($q$v_org,pg_temp.u(72),'dog',12,null,2$q$, 'medium|40000.00|40|base'),
    ($q$v_org,pg_temp.u(73),'dog',12,null,1$q$, 'medium|25000.00|0|base'),
    ($q$v_org,pg_temp.u(74),'dog',12,null,1$q$, 'medium|35000.00|0|size_matrix'),
    ($q$v_org,pg_temp.u(74),'dog',25.00,null,2$q$, 'large|30000.00|80|base'),
    ($q$v_org,pg_temp.u(74),'dog',12,null,3$q$, 'medium|35000.00|40|size_matrix'),
    ($q$v_org,pg_temp.u(74),'cat',null,null,1$q$, 'cat|30000.00|0|base'),
    ($q$v_org,pg_temp.u(75),'rabbit',2,null,2$q$, 'rabbit|70000|45|size_matrix'),
    ($q$v_org,pg_temp.u(71),'rabbit',2,null,1$q$, 'ERR:22023:species_price_not_configured'),
    ($q$v_org,pg_temp.u(99),'dog',3,null,1$q$, 'ERR:23514:service_not_active_or_not_in_org'),
    ($q$v_org,pg_temp.u(70),'dog',null,'small',1$q$, 'small|120000.00|60|size_matrix'),
    ($q$v_org,pg_temp.u(70),'dog',null,null,1$q$, '|99000.00|60|base')
  ) as t(args, expected) loop
    execute format('select pg_temp.new_line(%s)', replace(v_spot.args,'v_org',quote_literal(v_org)||'::uuid')) into v_actual;
    if v_actual <> v_spot.expected then
      raise exception 'FAIL spot value (%): expected [%] got [%]', v_spot.args, v_spot.expected, v_actual; end if;
  end loop;
  raise notice 'PASS T-DB-06 legacy resolver parity: % pet x service x quantity combinations equal the pre-migration rules (incl. zero-minute, custom species, errors)', v_n;
  -- shadow table equals the legacy columns in full, both directions
  if exists (select 1 from (
       select organization_id,id service_id,k pricing_key,p price,d duration_minutes from public.service_catalog sc cross join lateral (values
         ('extra_small',sc.price_extra_small,sc.duration_extra_small),('small',sc.price_small,sc.duration_small),('medium',sc.price_medium,sc.duration_medium),
         ('large',sc.price_large,sc.duration_large),('extra_large',sc.price_extra_large,sc.duration_extra_large),('cat',sc.price_cat,sc.duration_cat)) v(k,p,d)
       where p is not null or d is not null
       except select organization_id,service_id,pricing_key,price,duration_minutes from public.service_band_prices) x)
     or exists (select 1 from (
       select organization_id,service_id,pricing_key,price,duration_minutes from public.service_band_prices
       except select organization_id,id,k,p,d from public.service_catalog sc cross join lateral (values
         ('extra_small',sc.price_extra_small,sc.duration_extra_small),('small',sc.price_small,sc.duration_small),('medium',sc.price_medium,sc.duration_medium),
         ('large',sc.price_large,sc.duration_large),('extra_large',sc.price_extra_large,sc.duration_extra_large),('cat',sc.price_cat,sc.duration_cat)) v(k,p,d)
       where p is not null or d is not null) y) then
    raise exception 'FAIL service_band_prices is not equal to legacy columns'; end if;
  raise notice 'PASS T-DB-06b service_band_prices mirrors every legacy price/duration (no extras, none missing)';

  -- flip to dynamic: the new tables alone must reproduce every legacy answer
  update public.organization_size_band_settings set mode='dynamic' where organization_id=v_org;
  v_n := pg_temp.parity(v_org);
  raise notice 'PASS T-DB-06c dynamic-mode resolver (bands + service_band_prices) equals legacy answers for % combinations', v_n;
  -- legacy columns are a frozen mirror in dynamic mode
  update public.service_catalog set price_small=1 where id=pg_temp.u(70);
  if (select price from public.service_band_prices where service_id=pg_temp.u(70) and pricing_key='small') <> 120000 then
    raise exception 'FAIL dynamic mode must not sync legacy column writes'; end if;
  update public.service_catalog set price_small=120000 where id=pg_temp.u(70);
  update public.organization_size_band_settings set mode='legacy' where organization_id=v_org;
end $$;

-- ----------------------------------------------- T-DB-09b shadow sync writers
do $$
declare v_org uuid := pg_temp.u(10); v_svc uuid := pg_temp.u(70); v_t1 timestamptz; v_t2 timestamptz; v_new uuid;
begin
  update public.service_catalog set price_small=130000,duration_small=65 where id=v_svc;
  if (select price||'/'||duration_minutes from public.service_band_prices where service_id=v_svc and pricing_key='small') <> '130000.00/65' then
    raise exception 'FAIL legacy price update did not sync'; end if;
  update public.service_catalog set price_small=null,duration_small=null where id=v_svc;
  if exists (select 1 from public.service_band_prices where service_id=v_svc and pricing_key='small') then
    raise exception 'FAIL clearing both legacy columns must remove the shadow row'; end if;
  update public.service_catalog set price_small=null,duration_small=20 where id=v_svc;
  if (select coalesce(price::text,'null')||'/'||duration_minutes from public.service_band_prices where service_id=v_svc and pricing_key='small') <> 'null/20' then
    raise exception 'FAIL duration-only band must keep a row'; end if;
  update public.service_catalog set price_small=120000,duration_small=60 where id=v_svc;
  select updated_at into v_t1 from public.service_band_prices where service_id=v_svc and pricing_key='medium';
  update public.service_catalog set name='SB Full Matrix renamed' where id=v_svc;
  select updated_at into v_t2 from public.service_band_prices where service_id=v_svc and pricing_key='medium';
  if v_t1 is distinct from v_t2 then raise exception 'FAIL unrelated service edit touched shadow rows'; end if;
  insert into public.service_catalog(id,organization_id,name,duration_minutes,base_price,price_cat,duration_extra_large)
  values (pg_temp.u(76),v_org,'SB New Service',30,1000,5000,33) returning id into v_new;
  if (select string_agg(pricing_key||'='||coalesce(price::text,'n')||'/'||coalesce(duration_minutes::text,'n'),',' order by pricing_key) from public.service_band_prices where service_id=v_new)
     <> 'cat=5000.00/n,extra_large=n/33' then raise exception 'FAIL insert did not sync'; end if;
  delete from public.service_catalog where id=v_new;
  if exists (select 1 from public.service_band_prices where service_id=v_new) then raise exception 'FAIL service delete must cascade shadow rows'; end if;
  update public.service_catalog set name='SB Full Matrix' where id=v_svc;
  raise notice 'PASS T-DB-09b legacy catalog writes (insert/update/clear/no-op/delete) shadow-sync service_band_prices';
end $$;

-- boundaries edited through the existing owner RPC (authenticated, active-org owner)
begin;
set local role authenticated;
select set_config('request.jwt.claims',json_build_object('sub',pg_temp.u(31),'role','authenticated','active_org_id',pg_temp.u(10))::text,true) as c \gset
do $$
declare v_org uuid := pg_temp.u(10); v_ver integer;
begin
  select layout_version into v_ver from public.organization_size_band_settings where organization_id=v_org;
  perform app.set_dog_size_boundaries(v_org,6,11,16,26);
  if (select string_agg(trim_scale(upper_kg)::text||case when upper_inclusive then 'i' else '' end,',' order by sort_order)
      from public.organization_size_bands where organization_id=v_org and band_kind='dog_weight' and upper_kg is not null) <> '6,11,16,26i' then
    raise exception 'FAIL boundaries RPC did not shadow-sync bands'; end if;
  if (select layout_version from public.organization_size_band_settings where organization_id=v_org) <> v_ver + 1 then
    raise exception 'FAIL layout_version must bump once per real change'; end if;
  perform app.set_dog_size_boundaries(v_org,6,11,16,26);
  if (select layout_version from public.organization_size_band_settings where organization_id=v_org) <> v_ver + 1 then
    raise exception 'FAIL identical boundaries must not bump layout_version'; end if;
  raise notice 'PASS T-DB-11a set_dog_size_boundaries (legacy mode) updates authoritative boundaries and shadow bands';
end $$;
commit;
do $$
declare v_org uuid := pg_temp.u(10);
begin
  if (select size from public.pets where id=pg_temp.u(84)) <> 'large' or (select size from public.pets where id=pg_temp.u(83)) <> 'large' then
    raise exception 'FAIL pets were not re-banded after a boundary change: 25.01kg should now be large under 26'; end if;
  delete from public.organization_dog_size_boundaries where organization_id=v_org;
  if (select string_agg(trim_scale(upper_kg)::text,',' order by sort_order) from public.organization_size_bands where organization_id=v_org and band_kind='dog_weight' and upper_kg is not null) <> '5,10,15,25' then
    raise exception 'FAIL deleting the boundary row must restore 5/10/15/25 defaults'; end if;
  perform pg_temp.parity(v_org);
  raise notice 'PASS T-DB-11b removing the boundary row restores defaults; resolver still equals the oracle';
end $$;

-- ------------------------------------ T-DB-07 assembly_add_line end to end (A)
insert into public.bookings(id,organization_id,branch_id,customer_id,booking_type,status,starts_at,ends_at)
select pg_temp.u(100+n),pg_temp.u(10),pg_temp.u(20),pg_temp.u(60),'grooming','confirmed',now()+interval '1 day',now()+interval '1 day 2 hours'
from generate_series(0,9) n;

begin;
set local role authenticated;
select set_config('request.jwt.claims',json_build_object('sub',pg_temp.u(31),'role','authenticated','active_org_id',pg_temp.u(10))::text,true) as c \gset
do $$
declare v_jp uuid; v_jp1 uuid; v_line uuid; v_lines text := '';
        v_pets uuid[] := array[pg_temp.u(80),pg_temp.u(83),pg_temp.u(84),pg_temp.u(88),pg_temp.u(86),pg_temp.u(87)];
        i integer;
begin
  for i in 1..array_length(v_pets,1) loop
    v_jp := app.assembly_add_pet(pg_temp.u(100+i),v_pets[i],true);
    if i = 1 then v_jp1 := v_jp; end if;
    v_line := app.assembly_add_line(v_jp,pg_temp.u(70),2);
    v_lines := v_lines || v_pets[i] || '=' || v_line || ',';
  end loop;
  -- zero-minute add-on and the custom species line
  v_line := app.assembly_add_line(v_jp1,pg_temp.u(73),1); v_lines := v_lines || 'zero=' || v_line || ',';
  v_jp := app.assembly_add_pet(pg_temp.u(107),pg_temp.u(89),true);
  v_line := app.assembly_add_line(v_jp,pg_temp.u(75),3); v_lines := v_lines || pg_temp.u(89) || '=' || v_line || ',';
  perform set_config('sb.lines',v_lines,false);
  -- unchanged error contract
  perform pg_temp.expect_fail(format('select app.assembly_add_line(%L,%L,0)',v_jp,pg_temp.u(75)),'quantity_must_be_positive','quantity 0');
  perform pg_temp.expect_fail(format('select app.assembly_add_line(%L,%L,1)',v_jp,pg_temp.u(99)),'service_not_active_or_not_in_org','unknown service');
  perform pg_temp.expect_fail(format('select app.assembly_add_line(%L,%L,1)',v_jp,pg_temp.u(71)),'species_price_not_configured','rabbit without species price');
  perform pg_temp.expect_fail(format('select app.assembly_add_line(%L,%L,1)',pg_temp.u(99),pg_temp.u(71)),'pet_not_found','unknown job pet');
end $$;
commit;
do $$
declare v_pair text; v_old text; v_pet uuid; v_line uuid; g record; v_pet_row record; v_svc uuid; v_qty integer; v_ver integer; v_n integer := 0;
begin
  select layout_version into v_ver from public.organization_size_band_settings where organization_id=pg_temp.u(10);
  foreach v_pair in array string_to_array(rtrim(current_setting('sb.lines'),','),',') loop
    if v_pair like 'zero=%' then
      select * into g from public.grooming_job_pet_services where id=split_part(v_pair,'=',2)::uuid;
      if g.duration_minutes <> 0 or g.unit_price_snapshot <> 25000 then raise exception 'FAIL zero-minute add-on line: % min %', g.duration_minutes, g.unit_price_snapshot; end if;
      v_n := v_n + 1; continue;
    end if;
    v_pet := split_part(v_pair,'=',1)::uuid; v_line := split_part(v_pair,'=',2)::uuid;
    select * into v_pet_row from public.pets where id=v_pet;
    select * into g from public.grooming_job_pet_services where id=v_line;
    v_svc := g.service_id; v_qty := g.quantity;
    v_old := pg_temp.old_line(pg_temp.u(10),v_svc,v_pet_row.species,v_pet_row.weight_kg,v_pet_row.size,v_qty);
    if coalesce(g.pet_size_snapshot,'') <> split_part(v_old,'|',1) or g.unit_price_snapshot <> split_part(v_old,'|',2)::numeric
       or g.duration_minutes <> split_part(v_old,'|',3)::integer or g.price_source <> split_part(v_old,'|',4) then
      raise exception 'FAIL line for % differs from oracle: [% % % %] vs [%]', v_pet_row.name,
        g.pet_size_snapshot, g.unit_price_snapshot, g.duration_minutes, g.price_source, v_old; end if;
    if g.size_layout_version_snapshot is distinct from v_ver then raise exception 'FAIL layout version snapshot % vs %', g.size_layout_version_snapshot, v_ver; end if;
    if g.pet_weight_kg_snapshot is distinct from v_pet_row.weight_kg then raise exception 'FAIL weight snapshot for %', v_pet_row.name; end if;
    if g.pet_size_label_snapshot is distinct from (case v_pet_row.name when 'D3' then 'XS' when 'D25' then 'L' when 'D25b' then 'XL' when 'Kitty' then 'Cat'
         when 'Manual small' then 'S' when 'Unsized' then null when 'Bun' then 'Kelinci' end) then
      raise exception 'FAIL label snapshot for % is %', v_pet_row.name, g.pet_size_label_snapshot; end if;
    v_n := v_n + 1;
  end loop;
  -- renaming a band or repricing the catalog never touches existing snapshots
  update public.organization_size_bands set label='Extra Small' where organization_id=pg_temp.u(10) and band_key='extra_small';
  update public.service_catalog set price_extra_small=1 where id=pg_temp.u(70);
  select * into g from public.grooming_job_pet_services where id=split_part(split_part(current_setting('sb.lines'),',',1),'=',2)::uuid;
  if g.pet_size_label_snapshot <> 'XS' or g.unit_price_snapshot <> 99000 then raise exception 'FAIL snapshots changed after rename/reprice'; end if;
  update public.organization_size_bands set label='XS' where organization_id=pg_temp.u(10) and band_key='extra_small';
  update public.service_catalog set price_extra_small=99000 where id=pg_temp.u(70);
  raise notice 'PASS T-DB-07 assembly_add_line: % lines match the pre-migration oracle and carry label/weight/layout snapshots; error codes unchanged; snapshots immutable', v_n;
end $$;

-- --------------------------------------------------------------- R-01..R-09 RLS
do $$ begin
  if has_table_privilege('anon','public.organization_size_bands','select') or has_table_privilege('anon','public.organization_size_band_settings','select')
     or has_table_privilege('anon','public.service_band_prices','select') or has_table_privilege('anon','public.organization_size_band_ranges','select') then
    raise exception 'FAIL anon can read size band objects'; end if;
  if has_table_privilege('authenticated','public.organization_size_bands','insert,update,delete')
     or has_table_privilege('authenticated','public.organization_size_band_settings','insert')
     or has_table_privilege('authenticated','public.organization_size_band_settings','update')
     or has_table_privilege('authenticated','public.organization_size_band_settings','delete')
     or has_table_privilege('authenticated','public.service_band_prices','insert')
     or has_table_privilege('authenticated','public.service_band_prices','update')
     or has_table_privilege('authenticated','public.service_band_prices','delete') then
    raise exception 'FAIL authenticated has direct DML grants'; end if;
  if not (select bool_and(c.relrowsecurity) from pg_class c where c.oid in ('public.organization_size_bands'::regclass,'public.organization_size_band_settings'::regclass,'public.service_band_prices'::regclass)) then
    raise exception 'FAIL RLS is not enabled on every new tenant table'; end if;
end $$;

begin;
set local role authenticated;
select set_config('request.jwt.claims',json_build_object('sub',pg_temp.u(31),'role','authenticated','active_org_id',pg_temp.u(10))::text,true) as c \gset
do $$
declare v_n integer;
begin
  select count(*) into v_n from public.organization_size_bands;
  if v_n <> 6 or exists (select 1 from public.organization_size_bands where organization_id <> pg_temp.u(10)) then raise exception 'FAIL R-01 owner A sees % band rows / other orgs', v_n; end if;
  if (select count(*) from public.organization_size_band_settings) <> 1 or exists (select 1 from public.service_band_prices where organization_id <> pg_temp.u(10)) then
    raise exception 'FAIL R-01 settings/prices leak'; end if;
  if (select count(*) from public.organization_size_band_ranges) <> 5 then raise exception 'FAIL ranges view visibility'; end if;
  if (select count(*) from public.service_band_prices) = 0 then raise exception 'FAIL members must read their own service_band_prices'; end if;
  if exists (select 1 from public.organization_size_bands where organization_id=pg_temp.u(11)) then raise exception 'FAIL R-01 org B visible'; end if;
  perform pg_temp.expect_fail(format($f$insert into public.organization_size_bands(organization_id,band_key,label,sort_order,upper_kg) values (%L,'zz','ZZ',99,60)$f$,pg_temp.u(10)),'%permission denied%','R-07 insert band');
  perform pg_temp.expect_fail(format($f$update public.organization_size_bands set label='x' where organization_id=%L$f$,pg_temp.u(10)),'%permission denied%','R-07 update band');
  perform pg_temp.expect_fail(format($f$delete from public.organization_size_bands where organization_id=%L$f$,pg_temp.u(10)),'%permission denied%','R-07 delete band');
  perform pg_temp.expect_fail(format($f$update public.organization_size_band_settings set mode='dynamic' where organization_id=%L$f$,pg_temp.u(10)),'%permission denied%','R-07 owner cannot flip mode directly');
  perform pg_temp.expect_fail(format($f$insert into public.service_band_prices(organization_id,service_id,pricing_key,price) values (%L,%L,'cat',1)$f$,pg_temp.u(10),pg_temp.u(71)),'%permission denied%','R-07 insert price');
  perform pg_temp.expect_fail(format($f$update public.service_band_prices set price=0$f$),'%permission denied%','R-07 update price');
  perform pg_temp.expect_fail('delete from public.service_band_prices','%permission denied%','R-07 delete price');
  perform pg_temp.expect_fail(format('select app.resolve_service_line(%L,%L,%L,3,null,1)',pg_temp.u(10),pg_temp.u(70),'dog'),'%permission denied%','resolver is not client-callable');
  perform pg_temp.expect_fail(format('select app.pet_pricing_key(%L,%L,3,null)',pg_temp.u(10),'dog'),'%permission denied%','pricing key helper is not client-callable');
  perform pg_temp.expect_fail(format('select app.size_layout_lock(%L)',pg_temp.u(10)),'%permission denied%','layout lock is not client-callable');
end $$;
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims',json_build_object('sub',pg_temp.u(32),'role','authenticated','active_org_id',pg_temp.u(10))::text,true) as c \gset
do $$ begin
  if (select count(*) from public.organization_size_bands) <> 6 then raise exception 'FAIL staff member must read the active organization bands'; end if;
  perform pg_temp.expect_fail(format('select app.set_dog_size_boundaries(%L,6,11,16,26)',pg_temp.u(10)),'not_authorized','R-03 non-owner staff cannot change boundaries');
end $$;
commit;
begin;
set local role authenticated;
-- owner of A while the selected organization is B, and owner of B while selecting A: no rows, no cross-tenant edit
select set_config('request.jwt.claims',json_build_object('sub',pg_temp.u(31),'role','authenticated','active_org_id',pg_temp.u(11))::text,true) as c \gset
do $$ begin
  if exists (select 1 from public.organization_size_bands) or exists (select 1 from public.organization_size_band_settings) or exists (select 1 from public.service_band_prices) then
    raise exception 'FAIL R-06 read leak when active org is not a membership'; end if;
  perform pg_temp.expect_fail(format('select app.set_dog_size_boundaries(%L,6,11,16,26)',pg_temp.u(11)),'not_authorized','R-06 owner A editing org B');
end $$;
commit;
begin;
set local role authenticated;
select set_config('request.jwt.claims',json_build_object('sub',pg_temp.u(33),'role','authenticated','active_org_id',pg_temp.u(10))::text,true) as c \gset
do $$ begin
  if exists (select 1 from public.organization_size_bands) then raise exception 'FAIL owner B sees org A bands'; end if;
  perform pg_temp.expect_fail(format('select app.set_dog_size_boundaries(%L,6,11,16,26)',pg_temp.u(10)),'not_authorized','R-06 owner B editing org A');
  raise notice 'PASS R-01..R-07 RLS: members read only the active organization, anon denied, no direct DML, internal functions not client-callable, non-owner/cross-tenant boundary edits refused';
end $$;
commit;
begin;
set local role anon;
do $$ begin
  perform pg_temp.expect_fail('select count(*) from public.organization_size_bands','%permission denied%','R-02 anon bands');
  perform pg_temp.expect_fail('select count(*) from public.service_band_prices','%permission denied%','R-02 anon prices');
  perform pg_temp.expect_fail('select count(*) from public.organization_size_band_settings','%permission denied%','R-02 anon settings');
  perform pg_temp.expect_fail('select count(*) from public.organization_size_band_ranges','%permission denied%','R-02 anon ranges');
  raise notice 'PASS R-02 anon cannot read any size band object';
end $$;
commit;

-- -------------------------------- R-09 SECURITY DEFINER hardening + ACL parity
do $$
declare r record; v_n integer := 0;
begin
  for r in select p.oid, p.oid::regprocedure::text as sig, p.prosecdef, p.proconfig, p.proacl, p.proowner from pg_proc p
           join pg_namespace n on n.oid=p.pronamespace
           where n.nspname='app' and p.proname in ('tg_size_band_guard','tg_size_band_cat_permanent','tg_pet_type_not_size_band','validate_size_band_layout',
             'tg_validate_size_band_layout','seed_org_size_bands','tg_sync_service_band_prices','tg_sync_size_bands_from_boundaries','size_layout_lock',
             'pet_pricing_key','resolve_service_line','tg_pets_size_band_guard','tg_packages_size_band_guard','dog_size_for_weight') loop
    v_n := v_n + 1;
    if not r.prosecdef then raise exception 'FAIL % must be SECURITY DEFINER', r.sig; end if;
    if r.proconfig is null or not (r.proconfig @> array['search_path=""']) then raise exception 'FAIL % must pin an empty search_path (%)', r.sig, r.proconfig; end if;
    if exists (select 1 from aclexplode(coalesce(r.proacl, acldefault('f', r.proowner))) a
               where a.privilege_type='EXECUTE' and (a.grantee = 0 or a.grantee in (select oid from pg_roles where rolname in ('anon','authenticated')))) then
      raise exception 'FAIL % is executable by public/anon/authenticated', r.sig; end if;
  end loop;
  if v_n <> 14 then raise exception 'FAIL expected 14 audited functions, found %', v_n; end if;
  -- redefined public entry points keep their original grants
  if (select proacl::text from pg_proc where oid='app.assembly_add_line(uuid,uuid,integer)'::regprocedure) not like '{postgres=X/postgres,authenticated=X/postgres}'
     or (select proacl::text from pg_proc where oid='app.create_customer_household(text,text,jsonb,jsonb)'::regprocedure) not like '{postgres=X/postgres,authenticated=X/postgres}'
     or (select proacl::text from pg_proc where oid='app.review_customer_onboarding(uuid,text,uuid)'::regprocedure) not like '{postgres=X/postgres,authenticated=X/postgres}' then
    raise exception 'FAIL redefined function grants changed'; end if;
  if (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='app' and p.proname like 'assembly%') <> 8 then
    raise exception 'FAIL assembly function count changed'; end if;
  raise notice 'PASS R-09 % definer functions have empty search_path and no public/anon/authenticated execute; redefined entry points keep grants', v_n;
end $$;

-- ------------- dynamic organization H: 6th band end to end (T-DB-08/09/12 subset)
insert into public.branches(id,organization_id,name,is_default,status) values (pg_temp.u(21),pg_temp.u(13),'SB Branch H',true,'active');
insert into public.membership_branch_access(organization_id,membership_id,branch_id) values (pg_temp.u(13),pg_temp.u(54),pg_temp.u(21));
select pg_temp.apply_layout(pg_temp.u(13),(select l from jsonb_array_elements(current_setting('sb.vectors')::jsonb->'layouts') l where l->>'id'='six_band_xxl')) as x \gset
insert into public.service_catalog(id,organization_id,name,duration_minutes,base_price,currency,price_extra_large)
values (pg_temp.u(110),pg_temp.u(13),'H Basic',60,100000,'IDR',1);
insert into public.service_band_prices(organization_id,service_id,pricing_key,price,duration_minutes) values
  (pg_temp.u(13),pg_temp.u(110),'small',120000,60),(pg_temp.u(13),pg_temp.u(110),'extra_large',300000,120),(pg_temp.u(13),pg_temp.u(110),'xxl',400000,150);

begin;
set local role authenticated;
select set_config('request.jwt.claims',json_build_object('sub',pg_temp.u(34),'role','authenticated','active_org_id',pg_temp.u(13))::text,true) as c \gset
do $$
declare v_cust uuid;
begin
  v_cust := app.create_customer_household('SB Household H','081200000001',
    '[{"name":"Big","species":"dog","size":"xxl"},{"name":"Huge","species":"dog","weightKg":"40"},{"name":"Mid","species":"dog","weightKg":"12","size":"small"},{"name":"Tabby","species":"cat","size":"medium","weightKg":"4"}]');
  perform set_config('sb.h_customer',v_cust::text,false);
  perform pg_temp.expect_fail($f$select app.create_customer_household('Bad Size','081200000002','[{"name":"X","species":"dog","size":"nope"}]')$f$,'invalid_pet','unknown size is refused with the domain error');
  perform pg_temp.expect_fail($f$select app.create_customer_household('Cat Size','081200000003','[{"name":"X","species":"dog","size":"cat"}]')$f$,'invalid_pet','cat is not a dog size');
  if app.create_customer_household('XL House','081200000004','[{"name":"Y","species":"dog","size":"extra_large"}]') is null then raise exception 'FAIL legacy key refused'; end if;
end $$;
commit;
do $$
declare v_cust uuid := current_setting('sb.h_customer')::uuid;
begin
  if (select size from public.pets where customer_id=v_cust and name='Big') <> 'xxl' then raise exception 'FAIL manual xxl size not stored'; end if;
  if (select size from public.pets where customer_id=v_cust and name='Huge') <> 'xxl' then raise exception 'FAIL 40kg dog is not xxl'; end if;
  -- a stated (valid) size is overwritten by the measured weight
  if (select size from public.pets where customer_id=v_cust and name='Mid') <> 'medium' then raise exception 'FAIL weight must override the stated size'; end if;
  if (select size from public.pets where customer_id=v_cust and name='Tabby') is not null then raise exception 'FAIL cat kept a dog size'; end if;
  raise notice 'PASS T-DB-08a household RPC validates against active bands (xxl accepted, junk/cat refused with invalid_pet, weight still wins)';
end $$;

insert into public.bookings(id,organization_id,branch_id,customer_id,booking_type,status,starts_at,ends_at)
select pg_temp.u(120+n),pg_temp.u(13),pg_temp.u(21),current_setting('sb.h_customer')::uuid,'grooming','confirmed',now()+interval '1 day',now()+interval '1 day 2 hours' from generate_series(0,2) n;
begin;
set local role authenticated;
select set_config('request.jwt.claims',json_build_object('sub',pg_temp.u(34),'role','authenticated','active_org_id',pg_temp.u(13))::text,true) as c \gset
do $$
declare v_cust uuid := current_setting('sb.h_customer')::uuid; v_jp uuid; v_huge uuid; v_mid uuid; v_big uuid;
begin
  select id into v_huge from public.pets where customer_id=v_cust and name='Huge';
  select id into v_mid from public.pets where customer_id=v_cust and name='Mid';
  select id into v_big from public.pets where customer_id=v_cust and name='Big';
  v_jp := app.assembly_add_pet(pg_temp.u(120),v_huge,true); perform set_config('sb.h_line_huge',app.assembly_add_line(v_jp,pg_temp.u(110),1)::text,false);
  v_jp := app.assembly_add_pet(pg_temp.u(121),v_mid,true);  perform set_config('sb.h_line_mid',app.assembly_add_line(v_jp,pg_temp.u(110),2)::text,false);
  v_jp := app.assembly_add_pet(pg_temp.u(122),v_big,true);  perform set_config('sb.h_line_big',app.assembly_add_line(v_jp,pg_temp.u(110),1)::text,false);
end $$;
commit;
do $$
declare g record; v_ver integer;
begin
  select layout_version into v_ver from public.organization_size_band_settings where organization_id=pg_temp.u(13);
  select * into g from public.grooming_job_pet_services where id=current_setting('sb.h_line_huge')::uuid;
  if g.pet_size_snapshot <> 'xxl' or g.unit_price_snapshot <> 400000 or g.duration_minutes <> 150 or g.price_source <> 'size_matrix'
     or g.pet_size_label_snapshot <> 'XXL' or g.pet_weight_kg_snapshot <> 40 or g.size_layout_version_snapshot <> v_ver then
    raise exception 'FAIL xxl line snapshot: % % % % % % %', g.pet_size_snapshot, g.unit_price_snapshot, g.duration_minutes, g.price_source, g.pet_size_label_snapshot, g.pet_weight_kg_snapshot, g.size_layout_version_snapshot; end if;
  select * into g from public.grooming_job_pet_services where id=current_setting('sb.h_line_mid')::uuid;
  if g.pet_size_snapshot <> 'medium' or g.unit_price_snapshot <> 100000 or g.duration_minutes <> 60 or g.price_source <> 'base' then
    raise exception 'FAIL medium band without a band price must fall back to base: % % % %', g.pet_size_snapshot, g.unit_price_snapshot, g.duration_minutes, g.price_source; end if;
  select * into g from public.grooming_job_pet_services where id=current_setting('sb.h_line_big')::uuid;
  if g.pet_size_snapshot <> 'xxl' or g.unit_price_snapshot <> 400000 or g.pet_weight_kg_snapshot is not null then raise exception 'FAIL manually sized xxl dog line'; end if;
  -- inclusive/exclusive edge on the closed XL band (35.00 inclusive) and the legacy mirror being ignored in dynamic mode
  if pg_temp.new_line(pg_temp.u(13),pg_temp.u(110),'dog',35.00,null,1) <> 'extra_large|300000.00|120|size_matrix'
     or pg_temp.new_line(pg_temp.u(13),pg_temp.u(110),'dog',35.01,null,1) <> 'xxl|400000.00|150|size_matrix'
     or pg_temp.new_line(pg_temp.u(13),pg_temp.u(110),'dog',25.00,null,1) <> 'large|100000.00|60|base' then
    raise exception 'FAIL dynamic edge resolution: % / % / %', pg_temp.new_line(pg_temp.u(13),pg_temp.u(110),'dog',35.00,null,1), pg_temp.new_line(pg_temp.u(13),pg_temp.u(110),'dog',35.01,null,1), pg_temp.new_line(pg_temp.u(13),pg_temp.u(110),'dog',25.00,null,1); end if;
  raise notice 'PASS T-DB-08b sixth band end to end: 40kg -> xxl line (price, minutes, label, weight, layout version), missing band price -> base, dynamic edges, legacy mirror ignored';
end $$;

-- packages: exact band matching, snapshots, renewal, sold lock (dynamic org H)
insert into public.packages(id,organization_id,name,service_id,total_sessions,price,currency,per_pet,size_band)
values (pg_temp.u(130),pg_temp.u(13),'H Paw XXL',pg_temp.u(110),2,700000,'IDR',true,'xxl'),
       (pg_temp.u(131),pg_temp.u(13),'H Paw XL',pg_temp.u(110),2,500000,'IDR',true,'extra_large');
do $$
declare v_cust uuid := current_setting('sb.h_customer')::uuid; v_huge uuid; v_big uuid; v_mid uuid; v_tab uuid; v_cp uuid; v_cp2 uuid;
begin
  select id into v_huge from public.pets where customer_id=v_cust and name='Huge';
  select id into v_big from public.pets where customer_id=v_cust and name='Big';
  select id into v_mid from public.pets where customer_id=v_cust and name='Mid';
  select id into v_tab from public.pets where customer_id=v_cust and name='Tabby';
  insert into public.customer_packages(organization_id,customer_id,package_id,pet_id) values (pg_temp.u(13),v_cust,pg_temp.u(130),v_huge) returning id into v_cp;
  if (select size_band_snapshot||'/'||size_label_snapshot from public.customer_packages where id=v_cp) <> 'xxl/XXL' then raise exception 'FAIL package snapshot'; end if;
  insert into public.customer_packages(organization_id,customer_id,package_id,pet_id) values (pg_temp.u(13),v_cust,pg_temp.u(130),v_big);
  perform pg_temp.expect_fail(format('insert into public.customer_packages(organization_id,customer_id,package_id,pet_id) values (%L,%L,%L,%L)',pg_temp.u(13),v_cust,pg_temp.u(130),v_mid),'package_size_mismatch','xxl package for a medium dog');
  perform pg_temp.expect_fail(format('insert into public.customer_packages(organization_id,customer_id,package_id,pet_id) values (%L,%L,%L,%L)',pg_temp.u(13),v_cust,pg_temp.u(130),v_tab),'package_size_mismatch','xxl package for a cat');
  perform pg_temp.expect_fail(format('insert into public.customer_packages(organization_id,customer_id,package_id,pet_id) values (%L,%L,%L,%L)',pg_temp.u(13),v_cust,pg_temp.u(131),v_huge),'package_size_mismatch','exact match: a larger dog never buys the smaller tier');
  perform pg_temp.expect_fail(format('insert into public.customer_packages(organization_id,customer_id,package_id) values (%L,%L,%L)',pg_temp.u(13),v_cust,pg_temp.u(130)),'pet_required_for_size_package','size package needs a pet');
  perform pg_temp.expect_fail(format('update public.packages set size_band=%L where id=%L','extra_large',pg_temp.u(130)),'sold_package_size_locked','sold size locked');
  -- renewal follows the live key
  insert into public.customer_package_ledger(organization_id,customer_package_id,delta,reason) values (pg_temp.u(13),v_cp,1,'renewal');
  update public.pets set weight_kg=30 where id=v_huge;
  if (select size from public.pets where id=v_huge) <> 'extra_large' then raise exception 'FAIL pet did not re-band to extra_large'; end if;
  perform pg_temp.expect_fail(format('insert into public.customer_package_ledger(organization_id,customer_package_id,delta,reason) values (%L,%L,1,%L)',pg_temp.u(13),v_cp,'renewal'),'package_size_mismatch_on_renewal','renewal after the pet outgrew the tier');
  update public.pets set weight_kg=40 where id=v_huge;
  raise notice 'PASS T-DB-09 package sale/renewal on a dynamic band: exact match, snapshots, mismatch + renewal errors, sold lock';
end $$;

-- archive xxl (XL becomes open again): history stays valid, new assignment is refused
do $$
declare v_cust uuid := current_setting('sb.h_customer')::uuid; v_big uuid;
begin
  insert into public.pets(organization_id,customer_id,name,species,size) values (pg_temp.u(13),v_cust,'Free','dog','small');
  -- order matters: the open-top unique index is immediate, so archive the old open band before promoting the next
  update public.organization_size_bands set status='archived', archived_at=now() where organization_id=pg_temp.u(13) and band_key='xxl';
  update public.organization_size_bands set upper_kg=null, upper_inclusive=false where organization_id=pg_temp.u(13) and band_key='extra_large';
  set constraints all immediate;
  select id into v_big from public.pets where customer_id=v_cust and name='Big';
  update public.pets set name='Big renamed' where id=v_big;
  if (select size from public.pets where id=v_big) <> 'xxl' then raise exception 'FAIL archived key must stay on existing pets'; end if;
  perform pg_temp.expect_fail(format('insert into public.pets(organization_id,customer_id,name,species,size) values (%L,%L,%L,%L,%L)',pg_temp.u(13),v_cust,'New','dog','xxl'),'invalid_pet_size','new pet on an archived band');
  perform pg_temp.expect_fail(format('update public.pets set size=%L where id=%L','xxl',(select id from public.pets where customer_id=v_cust and name='Free')),'invalid_pet_size','existing unmeasured pet moved onto an archived band');
  perform pg_temp.expect_fail(format('insert into public.packages(organization_id,name,service_id,total_sessions,price,per_pet,size_band) values (%L,%L,%L,1,1,true,%L)',pg_temp.u(13),'H Archived',pg_temp.u(110),'xxl'),'invalid_package_size_band','package on an archived band');
  if app.dog_size_for_weight(pg_temp.u(13),40) <> 'extra_large' then raise exception 'FAIL archived band must leave the weight partition'; end if;
  if pg_temp.new_line(pg_temp.u(13),pg_temp.u(110),'dog',null,'xxl',1) <> '|100000.00|60|base' then raise exception 'FAIL archived stored size must not price (falls to base): %', pg_temp.new_line(pg_temp.u(13),pg_temp.u(110),'dog',null,'xxl',1); end if;
  if (select unit_price_snapshot||'/'||pet_size_snapshot||'/'||pet_size_label_snapshot from public.grooming_job_pet_services where id=current_setting('sb.h_line_huge')::uuid) <> '400000.00/xxl/XXL' then
    raise exception 'FAIL historical line changed after the band was archived'; end if;
  raise notice 'PASS T-DB-12a archived band: existing data valid, weight partition re-absorbed, new pet/package assignments and priced fallback refused/base';
end $$;

-- tenant-safe composite foreign keys (guard triggers bypassed to reach the FK itself)
do $$
begin
  perform pg_temp.expect_fail(format($f$alter table public.pets disable trigger trg_pets_size_band_guard;
    insert into public.pets(organization_id,customer_id,name,species,size) values (%L,%L,'Leak','dog','xxl')$f$,pg_temp.u(10),pg_temp.u(60)),
    '%fk_pets_size_band%','FK: org A pet cannot use a band key that exists only in org H');
  perform pg_temp.expect_fail(format($f$alter table public.packages disable trigger trg_packages_size_band_guard;
    insert into public.packages(organization_id,name,service_id,total_sessions,price,per_pet,size_band) values (%L,'Leak',%L,1,1,true,'xxl')$f$,pg_temp.u(10),pg_temp.u(70)),
    '%fk_packages_size_band%','FK: org A package cannot use org H band');
  perform pg_temp.expect_fail(format($f$insert into public.service_band_prices(organization_id,service_id,pricing_key,price) values (%L,%L,'xxl',1)$f$,pg_temp.u(10),pg_temp.u(70)),
    '%fk_service_band_prices_band%','FK: price row cannot point at another tenant''s band');
  perform pg_temp.expect_fail(format($f$insert into public.service_band_prices(organization_id,service_id,pricing_key,price) values (%L,%L,'small',1)$f$,pg_temp.u(13),pg_temp.u(70)),
    '%fk_service_band_prices_service%','FK: price row cannot point at another tenant''s service');
  perform pg_temp.expect_fail(format($f$insert into public.pets(organization_id,customer_id,name,species,size) values (%L,%L,'cat-size','dog','cat')$f$,pg_temp.u(10),pg_temp.u(60)),
    'invalid_pet_size','cat is never a pet size');
  raise notice 'PASS R-10 composite FKs are tenant-safe (pets, packages, service_band_prices) and cat stays a package-only band';
end $$;

-- ---------------------------- onboarding review: friendly error, legacy leniency
insert into public.customer_onboarding_links(id,organization_id,token_hash,source) values
  (pg_temp.u(140),pg_temp.u(10),'sb-hash-1','SB'),(pg_temp.u(141),pg_temp.u(10),'sb-hash-2','SB'),(pg_temp.u(142),pg_temp.u(10),'sb-hash-3','SB');
insert into public.customer_onboarding_submissions(id,organization_id,link_id,payload) values
  (pg_temp.u(150),pg_temp.u(10),pg_temp.u(140),'{"customerName":"SB Onboard Junk","phone":"081111111111","pets":[{"name":"Junk","species":"dog","size":"bogus"}]}'),
  (pg_temp.u(151),pg_temp.u(10),pg_temp.u(141),'{"customerName":"SB Onboard Ok","phone":"081111111112","pets":[{"name":"Okay","species":"dog","size":"small"}]}'),
  (pg_temp.u(152),pg_temp.u(10),pg_temp.u(142),'{"customerName":"SB Onboard W","phone":"081111111113","pets":[{"name":"Weighed","species":"dog","size":"bogus","weightKg":"3"}]}');
begin;
set local role authenticated;
select set_config('request.jwt.claims',json_build_object('sub',pg_temp.u(31),'role','authenticated','active_org_id',pg_temp.u(10))::text,true) as c \gset
do $$
declare v_c uuid;
begin
  perform pg_temp.expect_fail(format('select app.review_customer_onboarding(%L,%L)',pg_temp.u(150),'approve'),'invalid_pet','unmeasured dog with an unknown size');
  v_c := app.review_customer_onboarding(pg_temp.u(151),'approve');
  if (select size from public.pets where customer_id=v_c and name='Okay') <> 'small' then raise exception 'FAIL onboarding manual size'; end if;
  v_c := app.review_customer_onboarding(pg_temp.u(152),'approve');
  if (select size from public.pets where customer_id=v_c and name='Weighed') <> 'extra_small' then raise exception 'FAIL weighed dog must still be accepted and sized by weight'; end if;
  raise notice 'PASS T-DB-04b onboarding review: unknown manual size -> invalid_pet; valid size and weight-overridden junk still accepted';
end $$;
commit;
