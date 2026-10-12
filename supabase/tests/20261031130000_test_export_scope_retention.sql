-- P4 export scope report, retention (purge candidates / record), recorded verification, Storage delete policy, allowlist review.
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/20261031130000_test_export_scope_retention.sql
\set ON_ERROR_STOP on
begin;
alter table storage.objects add column if not exists updated_at timestamptz default now();

create function pg_temp.u(n integer) returns uuid language sql immutable as
$$ select ('e4000000-0000-4000-8000-' || lpad(to_hex(n), 12, '0'))::uuid $$;
create function pg_temp.act_as(p_user uuid, p_org uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', jsonb_build_object('sub', p_user, 'active_org_id', p_org, 'role', 'authenticated')::text, true);
end $$;
create function pg_temp.expect(p_sql text, p_state text, p_label text) returns void language plpgsql as $$
begin
  begin execute p_sql; exception when others then
    if sqlstate = p_state then raise notice 'PASS: %', p_label; return; end if;
    raise exception 'FAIL: % (expected %, got % %)', p_label, p_state, sqlstate, sqlerrm;
  end;
  raise exception 'FAIL: % (statement succeeded)', p_label;
end $$;
create function pg_temp.check(p_ok boolean, p_label text) returns void language plpgsql as $$
begin if p_ok is not true then raise exception 'FAIL: %', p_label; end if; raise notice 'PASS: %', p_label; end $$;

insert into public.organizations(id,name,slug,status) values
  (pg_temp.u(1),'Scope A','scope-a-test','active'), (pg_temp.u(2),'Scope B','scope-b-test','active');
insert into public.branches(id,organization_id,name,is_default,status) values
  (pg_temp.u(5),pg_temp.u(1),'A main',true,'active'), (pg_temp.u(6),pg_temp.u(2),'B main',true,'active');
insert into public.roles(id,organization_id,name) values
  (pg_temp.u(11),pg_temp.u(1),'Pemilik'), (pg_temp.u(12),pg_temp.u(1),'Manager'), (pg_temp.u(13),pg_temp.u(2),'Pemilik');
insert into public.role_permissions(role_id,organization_id,permission_id)
select pg_temp.u(12),pg_temp.u(1),id from public.permissions where key in ('settings.manage','finance.read','finance.manage');
insert into auth.users(id,email,raw_user_meta_data) values
  (pg_temp.u(21),'scope-owner-a@example.test','{}'), (pg_temp.u(22),'scope-manager-a@example.test','{}'), (pg_temp.u(23),'scope-owner-b@example.test','{}');
update public.users set status='active' where id in (pg_temp.u(21),pg_temp.u(22),pg_temp.u(23));
insert into public.memberships(user_id,organization_id,role_id,status) values
  (pg_temp.u(21),pg_temp.u(1),pg_temp.u(11),'active'), (pg_temp.u(22),pg_temp.u(1),pg_temp.u(12),'active'), (pg_temp.u(23),pg_temp.u(2),pg_temp.u(13),'active');
insert into public.customers(id,organization_id,display_name) values
  (pg_temp.u(101),pg_temp.u(1),'A one'),(pg_temp.u(102),pg_temp.u(1),'A two'),(pg_temp.u(201),pg_temp.u(2),'B one');
insert into public.organization_pet_types(organization_id,key,label,is_active) values (pg_temp.u(1),'ferret','Ferret',true);
insert into public.cash_accounts(id,organization_id,name,kind,currency) values (pg_temp.u(301),pg_temp.u(1),'Kas A','cash','IDR'),(pg_temp.u(302),pg_temp.u(2),'Kas B','cash','IDR');
insert into public.cash_movements(organization_id,account_id,kind,direction,amount,currency,occurred_on,request_key)
values (pg_temp.u(1),pg_temp.u(301),'opening_balance','in',100,'IDR',current_date,gen_random_uuid());
insert into public.custom_field_definitions(id,organization_id,entity_type,label,field_type,sort_order) values
  (pg_temp.u(401),pg_temp.u(1),'customer','Warna','text',1);
insert into public.customer_onboarding_links(organization_id,token_hash,status) values (pg_temp.u(1),'hash-secret','active');

-- Jobs for A: failed 10d (purgeable), failed 2d, cancelled 8d (purgeable), completed 200d, completed 100d, running 100d.
insert into public.organization_export_jobs(id,organization_id,status,storage_prefix,created_by,created_at,completed_at,manifest) values
  (pg_temp.u(501),pg_temp.u(1),'failed',pg_temp.u(1)::text||'/exports/'||pg_temp.u(501)::text,pg_temp.u(21), now()-interval '10 days', now()-interval '10 days', null),
  (pg_temp.u(502),pg_temp.u(1),'failed',pg_temp.u(1)::text||'/exports/'||pg_temp.u(502)::text,pg_temp.u(21), now()-interval '2 days', now()-interval '2 days', null),
  (pg_temp.u(503),pg_temp.u(1),'cancelled',pg_temp.u(1)::text||'/exports/'||pg_temp.u(503)::text,pg_temp.u(21), now()-interval '8 days', now()-interval '8 days', null),
  (pg_temp.u(504),pg_temp.u(1),'completed',pg_temp.u(1)::text||'/exports/'||pg_temp.u(504)::text,pg_temp.u(21), now()-interval '200 days', now()-interval '200 days', '{"manifestSha256":"aa"}'),
  (pg_temp.u(505),pg_temp.u(1),'completed',pg_temp.u(1)::text||'/exports/'||pg_temp.u(505)::text,pg_temp.u(21), now()-interval '100 days', now()-interval '100 days', '{"manifestSha256":"bb"}'),
  (pg_temp.u(506),pg_temp.u(2),'failed',pg_temp.u(2)::text||'/exports/'||pg_temp.u(506)::text,pg_temp.u(23), now()-interval '30 days', now()-interval '30 days', null);
insert into public.organization_export_jobs(id,organization_id,status,storage_prefix,created_by,created_at) values
  (pg_temp.u(507),pg_temp.u(1),'running',pg_temp.u(1)::text||'/exports/'||pg_temp.u(507)::text,pg_temp.u(21), now()-interval '100 days');
insert into storage.objects(id,bucket_id,name,metadata) values
  (gen_random_uuid(),'organization-exports',pg_temp.u(1)::text||'/exports/'||pg_temp.u(501)::text||'/manifest.json','{}'),
  (gen_random_uuid(),'organization-exports',pg_temp.u(2)::text||'/exports/'||pg_temp.u(506)::text||'/manifest.json','{}'),
  (gen_random_uuid(),'attachments',pg_temp.u(1)::text||'/photo.jpg','{}');

-- ===== Scope =============================================================================================================
select pg_temp.act_as(pg_temp.u(21), pg_temp.u(1));
set local role authenticated;
do $$
declare s jsonb; s2 jsonb; inc jsonb; unc jsonb;
begin
  s := app.org_export_scope();
  s2 := app.org_export_scope();
  inc := s -> 'included'; unc := s -> 'uncovered';
  perform pg_temp.check(s ->> 'fingerprint' ~ '^[0-9a-f]{64}$' and s ->> 'fingerprint' = s2 ->> 'fingerprint', 'the scope fingerprint is a stable sha-256 over table names');
  perform pg_temp.check((select (x ->> 'row_count')::int from jsonb_array_elements(inc) x where x ->> 'table' = 'customers') = 2, 'included tables carry this tenant''s live row count only (customers = 2, tenant B has 1)');
  perform pg_temp.check((select (x ->> 'row_count')::int from jsonb_array_elements(inc) x where x ->> 'table' = 'cash_movements') = 1 and (select (x ->> 'row_count')::int from jsonb_array_elements(inc) x where x ->> 'table' = 'cash_accounts') = 1, 'the new register tables are in scope');
  perform pg_temp.check((select count(*) from jsonb_array_elements(inc) x where x ->> 'table' in ('custom_field_definitions','custom_field_values','whatsapp_drafts','whatsapp_batches','whatsapp_draft_events','financial_ledger','tax_rates','resource_availability','branch_service_areas','branch_served_city_dates','branch_availability_blocks','commission_rules','commission_entries','customer_next_discounts','sop_templates')) = 15, 'every reviewed addition is listed');
  perform pg_temp.check(inc -> 0 ->> 'table' = 'branches' and inc -> (jsonb_array_length(inc) - 1) ->> 'table' = 'cash_movements'
    and (select bool_and((a ->> 'sort_order')::int < (b ->> 'sort_order')::int) from jsonb_array_elements(inc) with ordinality t1(a, i) join jsonb_array_elements(inc) with ordinality t2(b, j) on j = i + 1), 'included list is strictly ordered by the allowlist order');
  perform pg_temp.check((select x ->> 'class' from jsonb_array_elements(unc) x where x ->> 'table' = 'customer_onboarding_links') = 'secret' and (select (x ->> 'row_count')::int from jsonb_array_elements(unc) x where x ->> 'table' = 'customer_onboarding_links') = 1, 'token-hash table reported as secret, never exported');
  perform pg_temp.check((select x ->> 'class' from jsonb_array_elements(unc) x where x ->> 'table' = 'roles') = 'access', 'roles = access control');
  perform pg_temp.check((select x ->> 'class' from jsonb_array_elements(unc) x where x ->> 'table' = 'subscriptions') = 'operator' and (select x ->> 'class' from jsonb_array_elements(unc) x where x ->> 'table' = 'platform_invoices') = 'operator', 'billing/entitlement tables = operator');
  perform pg_temp.check((select x ->> 'class' from jsonb_array_elements(unc) x where x ->> 'table' = 'organization_export_jobs') = 'bookkeeping', 'export bookkeeping reported as bookkeeping');
  perform pg_temp.check((select x ->> 'class' from jsonb_array_elements(unc) x where x ->> 'table' = 'organization_bank_accounts') = 'sensitive', 'bank accounts = deliberately sensitive');
  perform pg_temp.check((select x ->> 'class' from jsonb_array_elements(unc) x where x ->> 'table' = 'storage_cleanup_schedules') = 'bookkeeping'
    and (select x ->> 'class' from jsonb_array_elements(unc) x where x ->> 'table' = 'whatsapp_contact_preferences') = 'sensitive', 'tables added by the closeout slices are classified, not left as not_reviewed (consent is deliberately not restored)');
  perform pg_temp.check((select x ->> 'class' from jsonb_array_elements(unc) x where x ->> 'table' = 'organization_pet_types') = 'configuration', 'tables exported inside configuration.json are labelled configuration');
  perform pg_temp.check((select x ->> 'class' from jsonb_array_elements(unc) x where x ->> 'table' = 'grooming_jobs') = 'no_uuid_cursor', 'a table with no uuid id cursor is reported as such');
  perform pg_temp.check((select x ->> 'class' from jsonb_array_elements(unc) x where x ->> 'table' = 'inventory_movements') = 'not_reviewed', 'an unreviewed tenant table is named, not hidden');
  perform pg_temp.check(not exists (select 1 from jsonb_array_elements(inc) a join jsonb_array_elements(unc) b on a ->> 'table' = b ->> 'table'), 'no table is both covered and uncovered');
  perform pg_temp.check(not exists (select 1 from jsonb_array_elements(unc) x where (x ->> 'row_count')::int > 10000), 'uncovered counts are capped');
  perform pg_temp.check((s -> 'retention' ->> 'completed_days')::int = 90 and (s -> 'retention' ->> 'failed_or_cancelled_days')::int = 7 and (s -> 'retention' ->> 'keeps_newest_completed')::boolean, 'retention rule is reported');
  perform pg_temp.check(not exists (select 1 from jsonb_array_elements(unc) x where x ->> 'class' not in ('secret','access','operator','bookkeeping','sensitive','configuration','no_uuid_cursor','not_reviewed')), 'every class is from the closed vocabulary');
  perform pg_temp.check(not (s::text ~* '(hash-secret|e4000000-0000-4000-8000-000000000201)'), 'no row content, secret or other-tenant id appears in the report');
end $$;
select pg_temp.act_as(pg_temp.u(23), pg_temp.u(2));
do $$ begin
  perform pg_temp.check((select (x ->> 'row_count')::int from jsonb_array_elements(app.org_export_scope() -> 'included') x where x ->> 'table' = 'customers') = 1, 'tenant B sees its own counts');
  perform pg_temp.check((select (x ->> 'row_count')::int from jsonb_array_elements(app.org_export_scope() -> 'uncovered') x where x ->> 'table' = 'customer_onboarding_links') = 0, 'and none of tenant A''s onboarding links');
end $$;
select pg_temp.act_as(pg_temp.u(22), pg_temp.u(1));
do $$ begin
  perform pg_temp.expect('select app.org_export_scope()', '42501', 'a manager with settings.manage is not the owner');
  perform pg_temp.expect('select app.org_export_purge_candidates()', '42501', 'manager cannot list purge candidates');
  perform pg_temp.expect(format($q$select app.org_export_mark_purged(%L, 3)$q$, pg_temp.u(501)), '42501', 'manager cannot mark a purge');
  perform pg_temp.expect(format($q$select app.org_export_record_verification(%L, true, 0)$q$, pg_temp.u(504)), '42501', 'manager cannot record a verification');
end $$;
select pg_temp.act_as(pg_temp.u(21), pg_temp.u(2));
do $$ begin
  perform pg_temp.expect('select app.org_export_scope()', '42501', 'forged active organization refused');
end $$;

-- ===== Purge candidates ====================================================================================================
select pg_temp.act_as(pg_temp.u(21), pg_temp.u(1));
do $$
declare c jsonb;
begin
  c := app.org_export_purge_candidates();
  perform pg_temp.check((select array_agg(x ->> 'id' order by x ->> 'id') from jsonb_array_elements(c) x) = array[pg_temp.u(501)::text, pg_temp.u(503)::text, pg_temp.u(504)::text],
    'candidates: failed 10d, cancelled 8d and the older completed archive; not failed 2d, not the newest completed (100d), not the running job');
  perform pg_temp.check(not exists (select 1 from jsonb_array_elements(c) x where x ->> 'id' = pg_temp.u(506)::text), 'another tenant''s job is never a candidate');
  perform pg_temp.expect(format($q$select app.org_export_mark_purged(%L, 5)$q$, pg_temp.u(505)), '22023', 'the newest completed archive cannot be purged however old');
  perform pg_temp.expect(format($q$select app.org_export_mark_purged(%L, 5)$q$, pg_temp.u(502)), '22023', 'a recent failed archive cannot be purged');
  perform pg_temp.expect(format($q$select app.org_export_mark_purged(%L, 5)$q$, pg_temp.u(507)), '22023', 'a running job cannot be purged');
  perform pg_temp.expect(format($q$select app.org_export_mark_purged(%L, 5)$q$, pg_temp.u(506)), 'P0002', 'another tenant''s job is not found');
  perform pg_temp.expect(format($q$select app.org_export_mark_purged(%L, -1)$q$, pg_temp.u(501)), '22023', 'negative file count refused');
  perform pg_temp.expect($q$select app.org_export_mark_purged(null, 1)$q$, '22023', 'null job refused');
  perform app.org_export_mark_purged(pg_temp.u(501), 4);
  perform app.org_export_mark_purged(pg_temp.u(501), 99);
  perform pg_temp.check((select (x ->> 'purged_files')::int from jsonb_array_elements(app.org_export_list()) x where x ->> 'id' = pg_temp.u(501)::text) = 4, 'marking twice is a no-op and keeps the first record');
  perform pg_temp.check(not exists (select 1 from jsonb_array_elements(app.org_export_purge_candidates()) x where x ->> 'id' = pg_temp.u(501)::text), 'a purged job leaves the candidate list');
  perform app.org_export_mark_purged(pg_temp.u(504), 12);
  -- a newer completed archive makes the 100-day one purgeable
  perform pg_temp.check(true, 'setup');
end $$;
reset role;
insert into public.organization_export_jobs(id,organization_id,status,storage_prefix,created_by,created_at,completed_at,manifest) values
  (pg_temp.u(508),pg_temp.u(1),'completed',pg_temp.u(1)::text||'/exports/'||pg_temp.u(508)::text,pg_temp.u(21), now()-interval '5 days', now()-interval '5 days', '{"manifestSha256":"cc"}');
set local role authenticated;
do $$ begin
  perform pg_temp.check((select array_agg(x ->> 'id' order by x ->> 'id') from jsonb_array_elements(app.org_export_purge_candidates()) x) = array[pg_temp.u(503)::text, pg_temp.u(505)::text],
    'once a newer completed archive exists the 100-day one becomes a candidate (and purged ones stay out)');
  perform pg_temp.expect(format($q$select app.org_export_manifest(%L)$q$, pg_temp.u(504)), '22023', 'a purged archive has no manifest to verify or download');
  perform pg_temp.check(app.org_export_manifest(pg_temp.u(508)) ->> 'manifestSha256' = 'cc', 'a live completed archive still returns its manifest');
end $$;

-- ===== Recorded verification ===============================================================================================
do $$
declare l jsonb;
begin
  perform app.org_export_record_verification(pg_temp.u(508), true, 0);
  l := app.org_export_list();
  perform pg_temp.check((select (x ->> 'verified_ok')::boolean from jsonb_array_elements(l) x where x ->> 'id' = pg_temp.u(508)::text) is true
    and (select x ->> 'verified_at' from jsonb_array_elements(l) x where x ->> 'id' = pg_temp.u(508)::text) is not null, 'a passed verification is recorded and listed');
  perform app.org_export_record_verification(pg_temp.u(508), false, 3);
  perform pg_temp.check((select (x ->> 'verified_ok')::boolean = false and (x ->> 'verified_failures')::int = 3 from jsonb_array_elements(app.org_export_list()) x where x ->> 'id' = pg_temp.u(508)::text), 'a later failed verification replaces the result');
  perform pg_temp.check((select (x ->> 'purged_at') is not null from jsonb_array_elements(l) x where x ->> 'id' = pg_temp.u(501)::text), 'the list shows purge state');
  perform pg_temp.expect(format($q$select app.org_export_record_verification(%L, true, 2)$q$, pg_temp.u(508)), '22023', 'a pass with failures is contradictory');
  perform pg_temp.expect(format($q$select app.org_export_record_verification(%L, null, 0)$q$, pg_temp.u(508)), '22023', 'null outcome refused');
  perform pg_temp.expect(format($q$select app.org_export_record_verification(%L, false, -1)$q$, pg_temp.u(508)), '22023', 'negative failure count refused');
  perform pg_temp.expect(format($q$select app.org_export_record_verification(%L, true, 0)$q$, pg_temp.u(507)), '22023', 'a running job cannot be verified');
  perform pg_temp.expect(format($q$select app.org_export_record_verification(%L, true, 0)$q$, pg_temp.u(504)), '22023', 'a purged archive cannot be verified');
  perform pg_temp.expect(format($q$select app.org_export_record_verification(%L, true, 0)$q$, pg_temp.u(506)), '22023', 'another tenant''s job is not recordable');
  perform pg_temp.expect($q$update public.organization_export_jobs set verified_ok = true$q$, '42501', 'clients cannot write job rows directly');
end $$;

-- ===== Storage delete policy ===============================================================================================
reset role;
alter table storage.objects enable row level security;
grant usage on schema storage to authenticated;
grant select, insert, update, delete on storage.objects to authenticated;
select pg_temp.act_as(pg_temp.u(21), pg_temp.u(1));
set local role authenticated;
do $$
declare n integer;
begin
  delete from storage.objects where bucket_id = 'organization-exports' and name = pg_temp.u(1)::text||'/exports/'||pg_temp.u(501)::text||'/manifest.json';
  get diagnostics n = row_count;
  perform pg_temp.check(n = 1, 'the owner removes files of an archive under its own exports/ prefix');
  delete from storage.objects where bucket_id = 'organization-exports' and name = pg_temp.u(2)::text||'/exports/'||pg_temp.u(506)::text||'/manifest.json';
  get diagnostics n = row_count;
  perform pg_temp.check(n = 0, 'but not another tenant''s archive');
  delete from storage.objects where bucket_id = 'attachments';
  get diagnostics n = row_count;
  perform pg_temp.check(n = 0, 'and the delete policy does not reach other buckets');
end $$;
reset role;
do $$ begin perform pg_temp.check((select count(*) from storage.objects where bucket_id = 'organization-exports') = 1 and (select count(*) from storage.objects where bucket_id = 'attachments') = 1, 'exactly the owner''s own archive object was removed'); end $$;
select pg_temp.act_as(pg_temp.u(22), pg_temp.u(1));
set local role authenticated;
do $$
declare n integer;
begin
  delete from storage.objects where bucket_id = 'organization-exports';
  get diagnostics n = row_count;
  perform pg_temp.check(n = 0, 'a manager cannot remove archive objects');
end $$;
reset role;

-- ===== Structure ===========================================================================================================
do $$
declare f text; v_def boolean; v_cfg text[]; v_oid oid;
begin
  foreach f in array array['org_export_scope','org_export_purge_candidates','org_export_mark_purged','org_export_record_verification','org_export_manifest','org_export_list'] loop
    select p.oid, p.prosecdef, p.proconfig into v_oid, v_def, v_cfg from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'app' and p.proname = f;
    perform pg_temp.check(v_def and v_cfg = array['search_path=""'] and not has_function_privilege('anon', v_oid, 'execute') and has_function_privilege('authenticated', v_oid, 'execute'), f || ': definer, empty search_path, anon denied, authenticated granted');
  end loop;
  perform pg_temp.check(not has_function_privilege('authenticated', 'app.export_archive_purgeable(text,timestamptz,boolean,timestamptz)', 'execute'), 'the retention rule helper is internal');
  perform pg_temp.check(app.export_archive_purgeable('failed', now() - interval '8 days', false, null) and not app.export_archive_purgeable('failed', now() - interval '6 days', false, null)
    and app.export_archive_purgeable('completed', now() - interval '91 days', false, null) and not app.export_archive_purgeable('completed', now() - interval '91 days', true, null)
    and not app.export_archive_purgeable('completed', now() - interval '89 days', false, null) and not app.export_archive_purgeable('running', now() - interval '999 days', false, null)
    and not app.export_archive_purgeable('failed', now() - interval '99 days', false, now()), 'retention rule boundaries (7 / 90 days, newest completed kept, running and purged excluded)');
  perform pg_temp.check(app.schema_version() >= '20261031130000', 'schema version moved to (or past) this migration');
end $$;
rollback;
