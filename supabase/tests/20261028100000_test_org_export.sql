-- Organization export foundation (E3.1): owner-only access, allowlist, tenant isolation,
-- chunk idempotency, interrupted-run behavior, configuration/Storage metadata boundaries, grants.
-- Everything runs in one transaction that is rolled back.
\set ON_ERROR_STOP on
begin;

-- gate databases stub storage.objects without RLS or updated_at; the real Storage table has both
alter table storage.objects add column if not exists updated_at timestamptz default now();

create function pg_temp.u(n integer) returns uuid language sql immutable as
$$ select ('e3100000-0000-4000-8000-' || lpad(to_hex(n), 12, '0'))::uuid $$;

insert into public.organizations(id,name,slug,status) values
  (pg_temp.u(1),'Export A','export-a-test','active'),
  (pg_temp.u(2),'Export B','export-b-test','active');
insert into public.roles(id,organization_id,name) values
  (pg_temp.u(11),pg_temp.u(1),'Pemilik'),
  (pg_temp.u(12),pg_temp.u(1),'Manager'),
  (pg_temp.u(13),pg_temp.u(2),'Pemilik');
insert into public.role_permissions(role_id,organization_id,permission_id)
select pg_temp.u(12),pg_temp.u(1),id from public.permissions where key = 'settings.manage';
insert into auth.users(id,email,raw_user_meta_data) values
  (pg_temp.u(21),'export-owner-a@example.test','{}'),
  (pg_temp.u(22),'export-manager-a@example.test','{}'),
  (pg_temp.u(23),'export-owner-b@example.test','{}'),
  (pg_temp.u(24),'export-outsider@example.test','{}');
update public.users set status='active' where id in (pg_temp.u(21),pg_temp.u(22),pg_temp.u(23),pg_temp.u(24));
insert into public.memberships(user_id,organization_id,role_id,status) values
  (pg_temp.u(21),pg_temp.u(1),pg_temp.u(11),'active'),
  (pg_temp.u(22),pg_temp.u(1),pg_temp.u(12),'active'),
  (pg_temp.u(23),pg_temp.u(2),pg_temp.u(13),'active');

insert into public.customers(id,organization_id,display_name) values
  (pg_temp.u(101),pg_temp.u(1),'A one'),(pg_temp.u(102),pg_temp.u(1),'A two'),(pg_temp.u(103),pg_temp.u(1),'A three'),
  (pg_temp.u(201),pg_temp.u(2),'B one'),(pg_temp.u(202),pg_temp.u(2),'B two');
-- settings carry a platform-only block and an unreviewed key that must never be exported
update public.organizations set settings = '{"documents":{"tagline":"hi"},"dashboard":{"cards":{"open_tasks":false}},"platform_billing":{"amount":1},"unreviewed_secret":{"k":"v"},"currency":"IDR"}'::jsonb where id = pg_temp.u(1);
insert into public.organization_pet_types(organization_id,key,label,is_active) values (pg_temp.u(1),'ferret','Ferret',true),(pg_temp.u(2),'otter','Otter',true);

insert into storage.objects(id,bucket_id,name,metadata) values
  (gen_random_uuid(),'attachments',pg_temp.u(1)::text||'/a1.jpg','{"size":"10","mimetype":"image/jpeg"}'),
  (gen_random_uuid(),'styling-references',pg_temp.u(1)::text||'/a2.jpg','{"size":"20"}'),
  (gen_random_uuid(),'attachments',pg_temp.u(2)::text||'/b1.jpg','{"size":"30"}'),
  (gen_random_uuid(),'some-other-bucket',pg_temp.u(1)::text||'/x.bin','{"size":"40"}'),
  (gen_random_uuid(),'organization-exports',pg_temp.u(1)::text||'/exports/old/chunk.jsonl','{"size":"50"}');

create function pg_temp.act_as(p_user uuid, p_org uuid, p_role text default 'authenticated') returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', jsonb_build_object('sub', p_user, 'active_org_id', p_org, 'role', p_role)::text, true);
  execute format('set local role %I', p_role);
end $$;
create function pg_temp.sqlstate_of(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return 'ok';
exception when others then return sqlstate || ':' || sqlerrm; end $$;
create function pg_temp.expect(p_sql text, p_state text, p_msg text, p_label text) returns void language plpgsql as $$
declare v text := pg_temp.sqlstate_of(p_sql);
begin
  if v is distinct from p_state || ':' || p_msg then raise exception 'FAIL %: expected %:%, got %', p_label, p_state, p_msg, v; end if;
end $$;
create function pg_temp.seed_job_state(p_job uuid, p_table text, p_completed boolean) returns void language sql security definer as
$$ update public.organization_export_table_state set completed = p_completed where job_id = p_job and table_name = p_table $$;

-- 1) only the active organization's business owner may use any export function ------------------------
do $$
declare v_fn text;
begin
  perform pg_temp.act_as(pg_temp.u(22), pg_temp.u(1));      -- manager with settings.manage, not the owner
  perform pg_temp.expect('select app.org_export_start(true)', '42501', 'not_authorized', 'manager start');
  perform pg_temp.expect('select app.org_export_list()', '42501', 'not_authorized', 'manager list');
  perform pg_temp.act_as(pg_temp.u(24), pg_temp.u(1));      -- authenticated without any membership
  perform pg_temp.expect('select app.org_export_start(true)', '42501', 'not_authorized', 'outsider start');
  perform pg_temp.act_as(pg_temp.u(21), pg_temp.u(2));      -- owner of A forging the active org claim to B
  perform pg_temp.expect('select app.org_export_start(true)', '42501', 'not_authorized', 'forged active org');
  perform pg_temp.expect('select app.org_export_configuration()', '42501', 'not_authorized', 'forged configuration');
  perform pg_temp.act_as(pg_temp.u(21), pg_temp.u(1), 'anon');
  foreach v_fn in array array['app.org_export_start(true)','app.org_export_list()','app.org_export_configuration()'] loop
    if pg_temp.sqlstate_of('select ' || v_fn) not like '42501:%' then raise exception 'FAIL anon executed %', v_fn; end if;
  end loop;
  reset role;
  raise notice 'PASS export access: manager, outsider, forged organization and anon are all refused';
end $$;

-- 2) client roles have no direct table access ------------------------------------------------------------
do $$
declare v_t text;
begin
  perform pg_temp.act_as(pg_temp.u(21), pg_temp.u(1));
  foreach v_t in array array['public.organization_export_jobs','public.organization_export_table_state','public.organization_export_chunks','app.organization_export_table_specs'] loop
    if pg_temp.sqlstate_of('select count(*) from ' || v_t) not like '42501:%' then raise exception 'FAIL owner read % directly', v_t; end if;
    if pg_temp.sqlstate_of('delete from ' || v_t) not like '42501:%' then raise exception 'FAIL owner wrote % directly', v_t; end if;
  end loop;
  reset role;
  raise notice 'PASS export bookkeeping tables are not reachable by client roles';
end $$;

-- 3) full run as owner A: allowlist paging, tenant isolation, chunk idempotency ---------------------------------
create table pg_temp.run(job uuid, table_name text, rows integer);
grant all on pg_temp.run to authenticated;
do $$
declare
  v_start jsonb; v_job uuid; v_work jsonb; v_rows jsonb; v_count integer; v_n integer := 0; v_first uuid; v_last uuid;
  v_path text; v_sha text := repeat('a', 64); v_other_org integer; v_total integer;
begin
  perform pg_temp.act_as(pg_temp.u(21), pg_temp.u(1));
  v_start := app.org_export_start(true);
  v_job := (v_start ->> 'job_id')::uuid;
  if (v_start ->> 'resumed')::boolean then raise exception 'FAIL first start must not be a resume'; end if;
  if (app.org_export_start(false) ->> 'job_id')::uuid is distinct from v_job or not (app.org_export_start(false) ->> 'resumed')::boolean then
    raise exception 'FAIL an interrupted run must be resumed, not duplicated'; end if;
  if v_start ->> 'storage_prefix' is distinct from pg_temp.u(1)::text || '/exports/' || v_job::text then raise exception 'FAIL storage prefix'; end if;

  -- work that is not on the allowlist or not this job's current cursor is refused
  perform pg_temp.expect(format('select app.org_export_table_page(%L,%L,null,10)', v_job, 'memberships'), '22023', 'invalid_export_work', 'memberships not allowlisted');
  perform pg_temp.expect(format('select app.org_export_table_page(%L,%L,null,10)', v_job, 'customer_onboarding_links'), '22023', 'invalid_export_work', 'token table not allowlisted');
  perform pg_temp.expect(format('select app.org_export_table_page(%L,%L,null,10)', v_job, 'organization_export_jobs'), '22023', 'invalid_export_work', 'bookkeeping not allowlisted');
  perform pg_temp.expect(format('select app.org_export_table_page(%L,%L,null,10)', v_job, 'customers; drop table x'), '22023', 'invalid_export_work', 'injection');
  perform pg_temp.expect(format('select app.org_export_table_page(%L,%L,%L,10)', v_job, 'customers', pg_temp.u(101)), '22023', 'invalid_export_work', 'cursor skip');
  perform pg_temp.expect(format('select app.org_export_table_page(%L,%L,null,201)', v_job, 'customers'), '22023', 'invalid_limit', 'limit 201');
  perform pg_temp.expect(format('select app.org_export_complete(%L,%L)', v_job, '{"format":"operro-organization-export","version":1}'), '22023', 'invalid_manifest', 'complete before done');

  -- completeness: a populated table cannot be marked complete before its rows are exported
  perform pg_temp.expect(format('select app.org_export_finish_table(%L,%L,null)', v_job, 'customers'), '22023', 'export_incomplete', 'early completion of a populated table');

  loop
    v_work := app.org_export_next_work(v_job);
    exit when (v_work ->> 'done')::boolean;
    v_n := v_n + 1; if v_n > 500 then raise exception 'FAIL export did not terminate'; end if;
    v_rows := app.org_export_table_page(v_job, v_work ->> 'table_name', nullif(v_work ->> 'after_id','')::uuid, 2);
    v_count := jsonb_array_length(v_rows);
    if v_count = 0 then
      perform app.org_export_finish_table(v_job, v_work ->> 'table_name', nullif(v_work ->> 'after_id','')::uuid);
      continue;
    end if;
    select count(*) into v_other_org from jsonb_array_elements(v_rows) r where r ->> 'organization_id' is distinct from pg_temp.u(1)::text;
    if v_other_org <> 0 then raise exception 'FAIL % exported another organization row', v_work ->> 'table_name'; end if;
    v_first := (v_rows -> 0 ->> 'id')::uuid; v_last := (v_rows -> (v_count - 1) ->> 'id')::uuid;
    v_path := (v_work ->> 'storage_prefix') || '/tables/' || (v_work ->> 'table_name') || '/chunk-' || lpad((v_work ->> 'chunk_index'), 5, '0') || '.jsonl';
    if v_work ->> 'table_name' = 'customers' and (v_work ->> 'chunk_index')::int = 0 then
      -- chunk validation on real data
      perform pg_temp.expect(format('select app.org_export_record_chunk(%L,%L,1,%s,%L,%L,%L,%L)', v_job, 'customers', v_count, v_sha, v_first, v_last, v_path), '22023', 'invalid_chunk_index', 'index gap');
      perform pg_temp.expect(format('select app.org_export_record_chunk(%L,%L,0,%s,%L,%L,%L,%L)', v_job, 'customers', v_count, v_sha, v_first, v_last, v_path || '.evil'), '22023', 'invalid_storage_path', 'path');
      perform pg_temp.expect(format('select app.org_export_record_chunk(%L,%L,0,%s,%L,%L,%L,%L)', v_job, 'customers', v_count, 'zz', v_first, v_last, v_path), '22023', 'invalid_chunk', 'sha');
      perform pg_temp.expect(format('select app.org_export_record_chunk(%L,%L,0,%s,%L,%L,%L,%L)', v_job, 'customers', 201, v_sha, v_first, v_last, v_path), '22023', 'invalid_chunk', 'row bound');
      perform pg_temp.expect(format('select app.org_export_record_chunk(%L,%L,0,%s,%L,%L,%L,%L)', v_job, 'customers', v_count, v_sha, v_last, v_first, v_path), '22023', 'invalid_chunk', 'range reversed');
      perform pg_temp.expect(format('select app.org_export_record_chunk(%L,%L,0,%s,%L,%L,%L,%L)', v_job, 'branches', v_count, v_sha, v_first, v_last, v_path), '22023', 'invalid_export_work', 'table already completed or other');
      -- fabricated or skipped ranges are checked against the page the server itself resolves (rows 101,102 are next; 103 follows)
      perform pg_temp.expect(format('select app.org_export_record_chunk(%L,%L,0,2,%L,%L,%L,%L)', v_job, 'customers', v_sha, pg_temp.u(102), pg_temp.u(103), v_path), '22023', 'invalid_chunk', 'skipped first row');
      perform pg_temp.expect(format('select app.org_export_record_chunk(%L,%L,0,2,%L,%L,%L,%L)', v_job, 'customers', v_sha, v_first, pg_temp.u(999), v_path), '22023', 'invalid_chunk', 'fabricated last id');
      perform pg_temp.expect(format('select app.org_export_record_chunk(%L,%L,0,4,%L,%L,%L,%L)', v_job, 'customers', v_sha, v_first, v_last, v_path), '22023', 'invalid_chunk', 'inflated count');
      perform pg_temp.expect(format('select app.org_export_record_chunk(%L,%L,0,1,%L,%L,%L,%L)', v_job, 'customers', v_sha, v_first, v_last, v_path), '22023', 'invalid_chunk', 'understated count hiding a row');
      if (app.org_export_next_work(v_job) ->> 'table_name') <> 'customers' or (app.org_export_next_work(v_job) ->> 'chunk_index')::int <> 0 then raise exception 'FAIL a refused chunk advanced the cursor'; end if;
    end if;
    perform app.org_export_record_chunk(v_job, v_work ->> 'table_name', (v_work ->> 'chunk_index')::int, v_count, v_sha, v_first, v_last, v_path);
    -- idempotent replay of the same chunk is a no-op; a different one is a conflict
    perform app.org_export_record_chunk(v_job, v_work ->> 'table_name', (v_work ->> 'chunk_index')::int, v_count, v_sha, v_first, v_last, v_path);
    if v_work ->> 'table_name' = 'customers' and (v_work ->> 'chunk_index')::int = 0 then
      perform pg_temp.expect(format('select app.org_export_record_chunk(%L,%L,0,%s,%L,%L,%L,%L)', v_job, 'customers', v_count, repeat('b', 64), v_first, v_last, v_path), '22023', 'chunk_conflict', 'replay with other hash');
      -- the cursor sits after row 102 but row 103 remains: completing the table now is refused
      perform pg_temp.expect(format('select app.org_export_finish_table(%L,%L,%L)', v_job, 'customers', v_last), '22023', 'export_incomplete', 'completion with rows remaining after the cursor');
      -- the cursor already moved: re-paging from the old cursor is refused
      perform pg_temp.expect(format('select app.org_export_table_page(%L,%L,null,2)', v_job, 'customers'), '22023', 'invalid_export_work', 'stale cursor');
    end if;
    insert into pg_temp.run values (v_job, v_work ->> 'table_name', v_count);
  end loop;

  select sum(rows) into v_total from pg_temp.run where table_name = 'customers';
  if v_total <> 3 then raise exception 'FAIL customers exported %, expected exactly organization A''s 3', v_total; end if;
  if (select count(*) from pg_temp.run where table_name = 'customers') <> 2 then raise exception 'FAIL customers should span 2 chunks of <= 2 rows'; end if;
  if exists (select 1 from pg_temp.run where table_name in ('memberships','roles','customer_onboarding_links','organization_export_jobs')) then raise exception 'FAIL non-allowlisted table exported'; end if;

  -- the manifest must name this organization and agree with the recorded chunks
  perform pg_temp.expect(format('select app.org_export_complete(%L,%L)', v_job, jsonb_build_object('format','operro-organization-export','version',1,'organization',jsonb_build_object('id',pg_temp.u(2)),'tables','[]'::jsonb)), '22023', 'invalid_manifest', 'other organization manifest');
  perform pg_temp.expect(format('select app.org_export_complete(%L,%L)', v_job, jsonb_build_object('format','operro-organization-export','version',1,'organization',jsonb_build_object('id',pg_temp.u(1)),'tables','[]'::jsonb)), '22023', 'invalid_manifest', 'empty tables');
  perform pg_temp.expect(format('select app.org_export_complete(%L,%L)', v_job, jsonb_build_object('format','operro-organization-export','version',1,'organization',jsonb_build_object('id',pg_temp.u(1)),
    'tables',(select jsonb_agg(jsonb_build_object('name',t ->> 'table_name','rowCount',99) order by (t ->> 'sort_order')::int) from jsonb_array_elements(app.org_export_tables(v_job)) t))), '22023', 'invalid_manifest', 'row count disagrees with chunks');

  -- configuration: explicit columns, reviewed settings keys only
  if (app.org_export_configuration() -> 'settings') ? 'platform_billing' or (app.org_export_configuration() -> 'settings') ? 'unreviewed_secret' then raise exception 'FAIL configuration leaked a settings key'; end if;
  if (select array_agg(k order by k) from jsonb_object_keys(app.org_export_configuration() -> 'settings') k) is distinct from array['currency','dashboard','documents'] then
    raise exception 'FAIL configuration settings keys: %', app.org_export_configuration() -> 'settings'; end if;
  if (select array_agg(k order by k) from jsonb_object_keys(app.org_export_configuration()) k) is distinct from
     array['created_at','dog_size_boundaries','id','name','pet_types','service_band_prices','settings','size_band_settings','slug','status','updated_at','vertical'] then
    raise exception 'FAIL configuration top-level keys: %', (select array_agg(k) from jsonb_object_keys(app.org_export_configuration()) k); end if;
  if not exists (select 1 from jsonb_array_elements(app.org_export_configuration() -> 'pet_types') t where t ->> 'key' = 'ferret')
     or exists (select 1 from jsonb_array_elements(app.org_export_configuration() -> 'pet_types') t where t ->> 'key' = 'otter' or t ->> 'organization_id' <> pg_temp.u(1)::text) then raise exception 'FAIL configuration pet types are not exactly organization A''s'; end if;

  -- storage listing: metadata of this organization's three reviewed buckets only
  if (select count(*) from jsonb_array_elements(app.org_export_storage_listing(v_job) -> 'objects')) <> 2
     or exists (select 1 from jsonb_array_elements(app.org_export_storage_listing(v_job) -> 'objects') o where o ->> 'name' not like pg_temp.u(1)::text || '/%' or o ->> 'bucket' not in ('attachments','styling-references','onboarding-styling'))
     or exists (select 1 from jsonb_array_elements(app.org_export_storage_listing(v_job) -> 'objects') o, jsonb_object_keys(o) k where k ~* 'url|token|signed') then
    raise exception 'FAIL storage listing: %', app.org_export_storage_listing(v_job); end if;

  -- finish the job with a manifest that agrees with the recorded chunks
  perform app.org_export_complete(v_job, jsonb_build_object('format','operro-organization-export','version',1,'organization',jsonb_build_object('id',pg_temp.u(1)),
    'tables',(select jsonb_agg(jsonb_build_object('name',t ->> 'table_name','rowCount',coalesce((select sum((c ->> 'row_count')::bigint) from jsonb_array_elements(app.org_export_chunks(v_job)) c where c ->> 'table_name' = t ->> 'table_name'),0)) order by (t ->> 'sort_order')::int) from jsonb_array_elements(app.org_export_tables(v_job)) t),
    'manifestSha256','abc'));
  perform pg_temp.expect(format('select app.org_export_next_work(%L)', v_job), '22023', 'job_not_running', 'completed job accepts no work');
  perform pg_temp.expect(format('select app.org_export_complete(%L,%L)', v_job, '{}'), '22023', 'invalid_manifest', 'second complete');
  if app.org_export_manifest(v_job) ->> 'manifestSha256' <> 'abc' then raise exception 'FAIL manifest read-back'; end if;
  if (select (j ->> 'status', j ->> 'tables_done' = j ->> 'tables_total')::text from jsonb_array_elements(app.org_export_list()) j limit 1) is distinct from '(completed,t)' then
    raise exception 'FAIL list: %', app.org_export_list(); end if;
  reset role;
  insert into pg_temp.run values (v_job, '__job__', 0);
  raise notice 'PASS export run: allowlist, paging, tenant isolation, chunk validation/idempotency, manifest agreement, configuration and storage metadata';
end $$;

-- 4) tenant B cannot see, drive or read A's job; B's own export contains only B --------------------------
do $$
declare v_job uuid := (select job from pg_temp.run where table_name = '__job__'); v_b uuid; v_work jsonb; v_rows jsonb; v_cnt integer;
begin
  perform pg_temp.act_as(pg_temp.u(23), pg_temp.u(2));
  perform pg_temp.expect(format('select app.org_export_next_work(%L)', v_job), '22023', 'job_not_running', 'B drives A job');
  perform pg_temp.expect(format('select app.org_export_manifest(%L)', v_job), 'P0002', 'job_not_found', 'B reads A manifest');
  perform pg_temp.expect(format('select app.org_export_chunks(%L)', v_job), 'P0002', 'job_not_found', 'B reads A chunks');
  perform pg_temp.expect(format('select app.org_export_tables(%L)', v_job), 'P0002', 'job_not_found', 'B reads A tables');
  perform pg_temp.expect(format('select app.org_export_storage_listing(%L)', v_job), 'P0002', 'job_not_found', 'B lists A storage');
  perform pg_temp.expect(format('select app.org_export_cancel(%L)', v_job), '22023', 'job_not_running', 'B cancels A job');
  perform pg_temp.expect(format('select app.org_export_table_page(%L,%L,null,10)', v_job, 'customers'), '22023', 'invalid_export_work', 'B pages A job');
  if jsonb_array_length(app.org_export_list()) <> 0 then raise exception 'FAIL B sees A jobs'; end if;
  v_b := (app.org_export_start(true) ->> 'job_id')::uuid;
  loop
    v_work := app.org_export_next_work(v_b);
    exit when (v_work ->> 'done')::boolean;
    if v_work ->> 'table_name' = 'customers' and (v_work ->> 'chunk_index')::int = 0 then
      if (select count(*) from jsonb_array_elements(app.org_export_table_page(v_b, 'customers', null, 200))) <> 2
         or exists (select 1 from jsonb_array_elements(app.org_export_table_page(v_b, 'customers', null, 200)) r where r ->> 'organization_id' <> pg_temp.u(2)::text) then
        raise exception 'FAIL B customers page'; end if;
    end if;
    v_rows := app.org_export_table_page(v_b, v_work ->> 'table_name', nullif(v_work ->> 'after_id','')::uuid, 200);
    v_cnt := jsonb_array_length(v_rows);
    if v_cnt = 0 then
      perform app.org_export_finish_table(v_b, v_work ->> 'table_name', nullif(v_work ->> 'after_id','')::uuid);
    else
      perform app.org_export_record_chunk(v_b, v_work ->> 'table_name', (v_work ->> 'chunk_index')::int, v_cnt, repeat('d', 64), (v_rows -> 0 ->> 'id')::uuid, (v_rows -> (v_cnt - 1) ->> 'id')::uuid,
        (v_work ->> 'storage_prefix') || '/tables/' || (v_work ->> 'table_name') || '/chunk-' || lpad(v_work ->> 'chunk_index', 5, '0') || '.jsonl');
    end if;
  end loop;
  if not exists (select 1 from jsonb_array_elements(app.org_export_configuration() -> 'pet_types') t where t ->> 'key' = 'otter')
     or exists (select 1 from jsonb_array_elements(app.org_export_configuration() -> 'pet_types') t where t ->> 'key' = 'ferret' or t ->> 'organization_id' <> pg_temp.u(2)::text)
     or (app.org_export_configuration() -> 'settings') <> '{}'::jsonb then raise exception 'FAIL B configuration'; end if;
  -- cancel releases the single running slot and records why
  perform app.org_export_cancel(v_b);
  perform pg_temp.expect(format('select app.org_export_cancel(%L)', v_b), '22023', 'job_not_running', 'cancel twice');
  perform pg_temp.expect(format('select app.org_export_next_work(%L)', v_b), '22023', 'job_not_running', 'cancelled job accepts no work');
  if (app.org_export_start(false) ->> 'job_id')::uuid = v_b then raise exception 'FAIL a cancelled job must not be resumed'; end if;
  if (select (app.org_export_storage_listing((app.org_export_start(false) ->> 'job_id')::uuid) ->> 'included')::boolean) then raise exception 'FAIL storage excluded job listed objects'; end if;
  reset role;
  raise notice 'PASS export tenant isolation: another owner cannot read, drive or cancel a job; own export contains only own rows; cancel and restart';
end $$;

-- 5) structural guards: allowlist shape, no credential-like columns, grants, search_path ---------------------
do $$
declare v_bad text; v_fn record; v_cfg text[];
begin
  select string_agg(s.table_name || '.' || c.column_name, ', ') into v_bad
  from app.organization_export_table_specs s join information_schema.columns c on c.table_schema = 'public' and c.table_name = s.table_name
  where c.column_name ~* '(token|secret|password|passwd|api_?key|credential|signed_?url|service_?role|authorization)';
  if v_bad is not null then raise exception 'FAIL credential-like columns in allowlisted tables: %', v_bad; end if;
  select string_agg(s.table_name, ', ') into v_bad from app.organization_export_table_specs s
   where not exists (select 1 from information_schema.columns c where c.table_schema='public' and c.table_name=s.table_name and c.column_name='id' and c.data_type='uuid')
      or not exists (select 1 from information_schema.columns c where c.table_schema='public' and c.table_name=s.table_name and c.column_name='organization_id' and c.data_type='uuid');
  if v_bad is not null then raise exception 'FAIL allowlisted tables without uuid id + organization_id: %', v_bad; end if;
  if exists (select 1 from app.organization_export_table_specs where table_name in ('memberships','roles','role_permissions','customer_onboarding_links','platform_access_invitations','organization_bank_accounts','subscriptions','platform_billing_periods','platform_invoices','organization_export_jobs')) then
    raise exception 'FAIL allowlist contains an identity, token, billing or bookkeeping table'; end if;
  for v_fn in select p.oid, p.proname, p.proconfig, p.prosecdef, p.proacl from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'app' and p.proname like 'org\_export\_%' loop
    if not v_fn.prosecdef or v_fn.proconfig is distinct from array['search_path=""'] then raise exception 'FAIL % is not definer with an empty search_path', v_fn.proname; end if;
    if has_function_privilege('anon', v_fn.oid, 'execute') or exists (select 1 from aclexplode(v_fn.proacl) a where a.grantee = 0) then raise exception 'FAIL % executable by anon/PUBLIC', v_fn.proname; end if;
    if (v_fn.proname = 'org_export_authorized') = has_function_privilege('authenticated', v_fn.oid, 'execute') then raise exception 'FAIL % authenticated grant is wrong', v_fn.proname; end if;
  end loop;
  if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'app' and p.proname like 'org\_export\_%') <> 14 then raise exception 'FAIL expected 14 export functions'; end if;
  raise notice 'PASS export structure: allowlist has no credential-like columns, every function is definer + empty search_path + authenticated-only';
end $$;

-- 6) Storage policies (RLS switched on for the stub table inside this transaction) -------------------------
alter table storage.objects enable row level security;
grant usage on schema storage to authenticated;
grant select, insert, update on storage.objects to authenticated;
do $$
declare v_job uuid := (select job from pg_temp.run where table_name = '__job__'); v_name text;
begin
  v_name := pg_temp.u(1)::text || '/exports/' || v_job::text || '/manifest.json';
  perform pg_temp.act_as(pg_temp.u(21), pg_temp.u(1));
  insert into storage.objects(id,bucket_id,name,metadata) values (gen_random_uuid(),'organization-exports',v_name,'{}');
  if (select count(*) from storage.objects where bucket_id = 'organization-exports' and name = v_name) <> 1 then raise exception 'FAIL owner cannot read own archive object'; end if;
  perform pg_temp.expect(format('insert into storage.objects(id,bucket_id,name,metadata) values (gen_random_uuid(),%L,%L,%L)', 'organization-exports', pg_temp.u(2)::text || '/exports/x/manifest.json', '{}'), '42501', 'new row violates row-level security policy for table "objects"', 'owner A writes B prefix');
  perform pg_temp.expect(format('insert into storage.objects(id,bucket_id,name,metadata) values (gen_random_uuid(),%L,%L,%L)', 'organization-exports', pg_temp.u(1)::text || '/elsewhere/manifest.json', '{}'), '42501', 'new row violates row-level security policy for table "objects"', 'owner A writes outside exports/');
  perform pg_temp.act_as(pg_temp.u(22), pg_temp.u(1));
  if (select count(*) from storage.objects where bucket_id = 'organization-exports') <> 0 then raise exception 'FAIL non-owner manager reads the archive'; end if;
  perform pg_temp.expect(format('insert into storage.objects(id,bucket_id,name,metadata) values (gen_random_uuid(),%L,%L,%L)', 'organization-exports', pg_temp.u(1)::text || '/exports/x/y.json', '{}'), '42501', 'new row violates row-level security policy for table "objects"', 'manager writes archive');
  perform pg_temp.act_as(pg_temp.u(23), pg_temp.u(2));
  if (select count(*) from storage.objects where bucket_id = 'organization-exports') <> 0 then raise exception 'FAIL tenant B reads tenant A archive'; end if;
  reset role;
  if (select public from storage.buckets where id = 'organization-exports') is distinct from false then raise exception 'FAIL archive bucket is public'; end if;
  raise notice 'PASS export Storage policies: only the owner of the active organization reads/writes its own exports/ prefix; bucket is private';
end $$;

rollback;
