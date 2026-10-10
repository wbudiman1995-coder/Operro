-- E3.3 storage cleanup foundation: dry-run first, metadata before objects, protected references, retry/idempotency,
-- lease/concurrency (sequential part), tenant isolation, audit.  Two-session proof: supabase/tests/storage_cleanup_concurrency.sh
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/20261029160000_test_storage_cleanup.sql
\set ON_ERROR_STOP on
create or replace function pg_temp.claims(p_user uuid, p_org uuid) returns void language plpgsql as $$
begin perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated', 'active_org_id', p_org)::text, true); end $$;
create or replace function pg_temp.expect(p_sql text, p_state text, p_label text) returns void language plpgsql as $$
begin
  begin execute p_sql; exception when others then
    if sqlstate = p_state then raise notice 'PASS: %', p_label; return; end if;
    raise exception 'FAIL: % (expected %, got % %)', p_label, p_state, sqlstate, sqlerrm;
  end;
  raise exception 'FAIL: % (statement succeeded)', p_label;
end $$;
create or replace function pg_temp.ok(p_cond boolean, p_label text) returns void language plpgsql as $$
begin if p_cond is true then raise notice 'PASS: %', p_label; else raise exception 'FAIL: %', p_label; end if; end $$;

begin;
insert into public.organizations (id, name, slug, status) values
  ('c7f00000-0000-4000-8000-000000000001', 'Clean A', 'clean-a-test', 'active'),
  ('c7f00000-0000-4000-8000-000000000002', 'Clean B', 'clean-b-test', 'active');
insert into public.subscriptions (organization_id, status, current_period_start, current_period_end)
  select o, 'active', now() - interval '1 day', now() + interval '1 year'
  from (values ('c7f00000-0000-4000-8000-000000000001'::uuid), ('c7f00000-0000-4000-8000-000000000002'::uuid)) t(o);
insert into public.organization_modules (organization_id, module_id, enabled, source)
  select o, m.id, true, 'override' from public.modules m,
  (values ('c7f00000-0000-4000-8000-000000000001'::uuid), ('c7f00000-0000-4000-8000-000000000002'::uuid)) t(o);
insert into public.branches (id, organization_id, name, is_default, status) values
  ('c7f00000-0000-4000-8000-0000000000e1', 'c7f00000-0000-4000-8000-000000000001', 'Main', true, 'active'),
  ('c7f00000-0000-4000-8000-0000000000e2', 'c7f00000-0000-4000-8000-000000000002', 'Main B', true, 'active');
insert into public.roles (id, organization_id, name) values
  ('c7f00000-0000-4000-8000-000000000011', 'c7f00000-0000-4000-8000-000000000001', 'Pemilik'),
  ('c7f00000-0000-4000-8000-000000000012', 'c7f00000-0000-4000-8000-000000000001', 'Manager'),
  ('c7f00000-0000-4000-8000-000000000013', 'c7f00000-0000-4000-8000-000000000002', 'Pemilik');
insert into public.role_permissions (organization_id, role_id, permission_id)
  select 'c7f00000-0000-4000-8000-000000000001', 'c7f00000-0000-4000-8000-000000000011', id from public.permissions where key in ('settings.manage','customer.manage','branches.all');
insert into public.role_permissions (organization_id, role_id, permission_id)
  select 'c7f00000-0000-4000-8000-000000000001', 'c7f00000-0000-4000-8000-000000000012', id from public.permissions where key in ('settings.manage');
insert into public.role_permissions (organization_id, role_id, permission_id)
  select 'c7f00000-0000-4000-8000-000000000002', 'c7f00000-0000-4000-8000-000000000013', id from public.permissions where key in ('settings.manage','branches.all');
insert into auth.users (id, email, raw_user_meta_data) values
  ('c7f00000-0000-4000-8000-000000000021', 'owner-a@clean.test', '{}'),
  ('c7f00000-0000-4000-8000-000000000022', 'manager-a@clean.test', '{}'),
  ('c7f00000-0000-4000-8000-000000000023', 'owner-b@clean.test', '{}');
update public.users set status = 'active' where id::text like 'c7f00000-%';
insert into public.memberships (user_id, organization_id, role_id, status) values
  ('c7f00000-0000-4000-8000-000000000021', 'c7f00000-0000-4000-8000-000000000001', 'c7f00000-0000-4000-8000-000000000011', 'active'),
  ('c7f00000-0000-4000-8000-000000000022', 'c7f00000-0000-4000-8000-000000000001', 'c7f00000-0000-4000-8000-000000000012', 'active'),
  ('c7f00000-0000-4000-8000-000000000023', 'c7f00000-0000-4000-8000-000000000002', 'c7f00000-0000-4000-8000-000000000013', 'active');

insert into public.customers (id, organization_id, display_name) values
  ('c7f00000-0000-4000-8000-0000000000a1', 'c7f00000-0000-4000-8000-000000000001', 'Cust A');
insert into public.invoices (id, organization_id, branch_id, customer_id, invoice_number, status, currency, subtotal, total) values
  ('c7f00000-0000-4000-8000-0000000000d1', 'c7f00000-0000-4000-8000-000000000001', 'c7f00000-0000-4000-8000-0000000000e1', 'c7f00000-0000-4000-8000-0000000000a1', 'CL-1', 'issued', 'IDR', 1, 1);

-- Attachments. A/ prefix = organization A's storage prefix.
create function pg_temp.att(p_n integer, p_org text, p_bucket text, p_path text, p_meta jsonb, p_deleted boolean default false) returns void language sql as $$
  insert into public.attachments (id, organization_id, storage_bucket, storage_path, filename, metadata, deleted_at)
  values (('c7f00000-0000-4000-8000-0000000b' || lpad(p_n::text, 4, '0'))::uuid, p_org::uuid, p_bucket, p_path, 'f' || p_n, p_meta, case when p_deleted then now() else null end) $$;
do $$
declare a text := 'c7f00000-0000-4000-8000-000000000001'; b text := 'c7f00000-0000-4000-8000-000000000002';
  old_ts text := to_char(now() - interval '2 days', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
begin
  perform pg_temp.att(1, a, 'styling-references', a || '/ref/1.jpg', jsonb_build_object('kind', 'styling_reference', 'expires_at', old_ts));
  perform pg_temp.att(2, a, 'attachments', a || '/ev/2.jpg', jsonb_build_object('category', 'before', 'expires_at', old_ts));
  perform pg_temp.att(3, a, 'styling-references', a || '/ref/3.jpg', jsonb_build_object('kind', 'styling_reference', 'expires_at', to_char(now() - interval '23 hours', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')));       -- inside the grace period
  perform pg_temp.att(4, a, 'styling-references', a || '/ref/4.jpg', jsonb_build_object('kind', 'styling_reference', 'expires_at', to_char(now() - interval '1 day 2 minutes', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))); -- just past the boundary
  perform pg_temp.att(5, a, 'attachments', a || '/ev/5.jpg', jsonb_build_object('category', 'after', 'expires_at', old_ts));                            -- linked to an invoice
  perform pg_temp.att(6, a, 'attachments', a || '/ev/6.jpg', jsonb_build_object('category', 'proof', 'expires_at', old_ts));                            -- payment proof
  perform pg_temp.att(7, a, 'styling-references', a || '/ref/7.jpg', jsonb_build_object('kind', 'styling_reference', 'expires_at', old_ts), true);       -- already deleted
  perform pg_temp.att(8, a, 'styling-references', b || '/ref/8.jpg', jsonb_build_object('kind', 'styling_reference', 'expires_at', old_ts));            -- A's row, path outside A's prefix
  perform pg_temp.att(9, a, 'styling-references', a || '/ref/9.jpg', jsonb_build_object('kind', 'styling_reference', 'expires_at', 'tomorrow-ish'));    -- malformed expiry
  perform pg_temp.att(10, a, 'attachments', a || '/ev/10.jpg', jsonb_build_object('note', 'no retention metadata', 'expires_at', old_ts));             -- not a retention-managed kind
  perform pg_temp.att(11, b, 'styling-references', b || '/ref/11.jpg', jsonb_build_object('kind', 'styling_reference', 'expires_at', old_ts));         -- other tenant
  perform pg_temp.att(12, a, 'attachments', a || '/ev/12.jpg', jsonb_build_object('category', 'complaint', 'expires_at', old_ts));                      -- linked to a complaint
  perform pg_temp.att(13, a, 'attachments', a || '/ev/13.jpg', jsonb_build_object('category', 'job', 'expires_at', old_ts));                            -- linked only to a grooming job pet: allowed
  perform pg_temp.att(14, a, 'not-managed-bucket', a || '/x/14.jpg', jsonb_build_object('kind', 'styling_reference', 'expires_at', old_ts));          -- bucket not managed by this job
end $$;
insert into public.attachment_links (organization_id, attachment_id, subject_type, subject_id) values
  ('c7f00000-0000-4000-8000-000000000001', 'c7f00000-0000-4000-8000-0000000b0005', 'invoice', 'c7f00000-0000-4000-8000-0000000000d1'),
  ('c7f00000-0000-4000-8000-000000000001', 'c7f00000-0000-4000-8000-0000000b0012', 'complaint', gen_random_uuid()),
  ('c7f00000-0000-4000-8000-000000000001', 'c7f00000-0000-4000-8000-0000000b0013', 'grooming_job_pet', gen_random_uuid());
insert into public.payments (id, organization_id, branch_id, invoice_id, method, amount, currency, status, proof_attachment_id) values
  ('c7f00000-0000-4000-8000-0000000000f1', 'c7f00000-0000-4000-8000-000000000001', 'c7f00000-0000-4000-8000-0000000000e1', 'c7f00000-0000-4000-8000-0000000000d1', 'bank_transfer', 1, 'IDR', 'succeeded', 'c7f00000-0000-4000-8000-0000000b0006');

create temporary table att_before as select md5(string_agg(to_jsonb(a)::text, '~' order by a.id::text)) as h from public.attachments a where a.organization_id = 'c7f00000-0000-4000-8000-000000000001';
grant select on att_before to authenticated;
grant select on all tables in schema public to authenticated;
set local role authenticated;

-- ===== Preview (dry run) =====
select pg_temp.claims('c7f00000-0000-4000-8000-000000000022', 'c7f00000-0000-4000-8000-000000000001');   -- Manager: settings.manage, not owner
do $$
declare r jsonb; v_ids text[];
begin
  r := app.storage_cleanup_preview(100);
  select array_agg(right(attachment_id::text, 4) order by attachment_id) into v_ids from public.storage_cleanup_items where run_id = (r ->> 'run_id')::uuid;
  perform pg_temp.ok(v_ids = array['0001', '0002', '0004', '0013'], 'dry run lists exactly the expired, unreferenced, in-prefix, retention-managed objects (got ' || coalesce(v_ids::text, 'none') || ')');
  perform pg_temp.ok((r ->> 'candidates')::int = 4, 'candidate count recorded');
  perform pg_temp.ok((select md5(string_agg(to_jsonb(a)::text, '~' order by a.id::text)) from public.attachments a) = (select h from att_before), 'dry run changed no attachment');
  perform pg_temp.ok((select status from public.storage_cleanup_runs where id = (r ->> 'run_id')::uuid) = 'completed' and (select mode from public.storage_cleanup_runs where id = (r ->> 'run_id')::uuid) = 'dry_run', 'dry run is its own completed bookkeeping record');
  -- Bound: the limit caps the preview.
  perform pg_temp.ok((app.storage_cleanup_preview(2) ->> 'candidates')::int = 2, 'preview is bounded by the requested limit');
  perform pg_temp.ok((app.storage_cleanup_preview(100000) ->> 'candidates')::int = 4, 'an oversized limit is clamped, never unbounded');
  perform set_config('c7.preview', r ->> 'run_id', true);
  perform pg_temp.expect(format($q$select app.storage_cleanup_begin(%L)$q$, r ->> 'run_id'), '42501', 'only the business owner may apply (settings.manage is not enough)');
  perform pg_temp.expect($q$select app.storage_cleanup_record(gen_random_uuid(), '[]')$q$, '42501', 'only the business owner may record results');
  perform pg_temp.expect($q$select app.storage_cleanup_finish(gen_random_uuid())$q$, '42501', 'only the business owner may finish');
end $$;

-- ===== Apply guards =====
select pg_temp.claims('c7f00000-0000-4000-8000-000000000021', 'c7f00000-0000-4000-8000-000000000001');
do $$
begin
  perform pg_temp.expect($q$select app.storage_cleanup_begin(gen_random_uuid())$q$, 'P0002', 'apply without a preview is refused');
  perform pg_temp.expect(format($q$select app.storage_cleanup_begin(%L)$q$, (select id from public.storage_cleanup_items limit 1)), 'P0002', 'an item id is not a preview id');
end $$;
reset role;
update public.storage_cleanup_runs set started_at = now() - interval '25 hours' where id = current_setting('c7.preview')::uuid;
set local role authenticated;
select pg_temp.claims('c7f00000-0000-4000-8000-000000000021', 'c7f00000-0000-4000-8000-000000000001');
do $$ begin perform pg_temp.expect(format($q$select app.storage_cleanup_begin(%L)$q$, current_setting('c7.preview')), '22023', 'a preview older than 24 hours is stale'); end $$;
reset role;
update public.storage_cleanup_runs set started_at = now() where id = current_setting('c7.preview')::uuid;
set local role authenticated;
select pg_temp.claims('c7f00000-0000-4000-8000-000000000023', 'c7f00000-0000-4000-8000-000000000002');
do $$ begin
  perform pg_temp.expect(format($q$select app.storage_cleanup_begin(%L)$q$, current_setting('c7.preview')), 'P0002', 'another tenant cannot apply this tenant''s preview');
  if (select count(*) from public.storage_cleanup_runs) <> 0 or (select count(*) from public.storage_cleanup_items) <> 0 then raise exception 'FAIL tenant B sees tenant A cleanup records'; end if;
  raise notice 'PASS: tenant B sees none of tenant A''s cleanup records';
end $$;

-- ===== Apply: metadata first, then objects =====
select pg_temp.claims('c7f00000-0000-4000-8000-000000000021', 'c7f00000-0000-4000-8000-000000000001');
do $$
declare r jsonb; v_items jsonb; v_run uuid;
begin
  -- Between preview and apply, attachment 4 becomes protected (someone linked it to an invoice) and 13 is deleted by hand.
  null;
end $$;
reset role;
insert into public.attachment_links (organization_id, attachment_id, subject_type, subject_id)
values ('c7f00000-0000-4000-8000-000000000001', 'c7f00000-0000-4000-8000-0000000b0004', 'invoice', 'c7f00000-0000-4000-8000-0000000000d1');
update public.attachments set deleted_at = now() where id = 'c7f00000-0000-4000-8000-0000000b0013';
set local role authenticated;
select pg_temp.claims('c7f00000-0000-4000-8000-000000000021', 'c7f00000-0000-4000-8000-000000000001');
do $$
declare r jsonb; v_run uuid; v_pending jsonb;
begin
  r := app.storage_cleanup_begin(current_setting('c7.preview')::uuid);
  v_run := (r ->> 'run_id')::uuid;
  perform set_config('c7.run', v_run::text, true);
  perform pg_temp.ok((r ->> 'marked')::int = 2 and (r ->> 'skipped')::int = 2, 'apply marks only items still eligible; ones that changed since the preview are skipped (marked 2, skipped 2)');
  perform pg_temp.ok((select deleted_at is not null from public.attachments where id = 'c7f00000-0000-4000-8000-0000000b0001')
                     and (select deleted_at is not null from public.attachments where id = 'c7f00000-0000-4000-8000-0000000b0002'), 'metadata is tombstoned BEFORE any object removal is reported');
  perform pg_temp.ok((select deleted_at is null from public.attachments where id = 'c7f00000-0000-4000-8000-0000000b0004'), 'an attachment that became referenced after the preview is left alone');
  perform pg_temp.ok((select count(*) from public.attachments where deleted_at is null and id in ('c7f00000-0000-4000-8000-0000000b0003', 'c7f00000-0000-4000-8000-0000000b0005', 'c7f00000-0000-4000-8000-0000000b0006', 'c7f00000-0000-4000-8000-0000000b0008', 'c7f00000-0000-4000-8000-0000000b0009', 'c7f00000-0000-4000-8000-0000000b0010', 'c7f00000-0000-4000-8000-0000000b0012', 'c7f00000-0000-4000-8000-0000000b0014')) = 8, 'graced, referenced, proof, foreign-prefix, malformed, unmanaged and complaint attachments are untouched');
  perform pg_temp.ok(jsonb_array_length(r -> 'pending') = 2, 'runner receives exactly the two objects to remove');
  perform pg_temp.ok((select status from public.storage_cleanup_runs where id = v_run) = 'running', 'run holds the lease');
  -- Concurrency guard: a second begin while the lease is live is refused.
  perform pg_temp.expect(format($q$select app.storage_cleanup_begin(%L)$q$, current_setting('c7.preview')), '55P03', 'a second run for the same organization is refused while the first holds its lease');
  v_pending := r -> 'pending';
  perform set_config('c7.item1', v_pending -> 0 ->> 'item_id', true);
  perform set_config('c7.item2', v_pending -> 1 ->> 'item_id', true);
end $$;

-- ===== Record: partial failure, retry, idempotency, absent objects =====
do $$
declare v_run uuid := current_setting('c7.run')::uuid; i1 text := current_setting('c7.item1'); i2 text := current_setting('c7.item2');
begin
  perform pg_temp.expect(format($q$select app.storage_cleanup_record(%L, '[{"item_id":"%s","result":"explode"}]')$q$, v_run, i1), '22023', 'unknown result value rejected');
  perform pg_temp.expect(format($q$select app.storage_cleanup_record(%L, '[{"item_id":"not-a-uuid","result":"deleted"}]')$q$, v_run), '22023', 'malformed item id rejected');
  perform pg_temp.expect(format($q$select app.storage_cleanup_record(%L, '{"a":1}')$q$, v_run), '22023', 'non-array payload rejected');
  perform pg_temp.expect($q$select app.storage_cleanup_record(gen_random_uuid(), '[]')$q$, '55000', 'recording against a run that is not running is refused');
  -- item1 deleted, item2 failed (partial failure)
  perform pg_temp.ok(app.storage_cleanup_record(v_run, jsonb_build_array(jsonb_build_object('item_id', i1, 'result', 'deleted'), jsonb_build_object('item_id', i2, 'result', 'failed', 'error', 'storage 500'))) = 2, 'results recorded');
  perform pg_temp.ok(app.storage_cleanup_record(v_run, jsonb_build_array(jsonb_build_object('item_id', i1, 'result', 'deleted'))) = 0, 'repeating a settled result changes nothing (idempotent)');
  perform pg_temp.ok(app.storage_cleanup_record(v_run, jsonb_build_array(jsonb_build_object('item_id', i1, 'result', 'failed'))) = 0, 'a deleted item can never be flipped back');
  perform pg_temp.ok(app.storage_cleanup_finish(v_run) = 'partial', 'a run with a failed object finishes partial, not completed');
  perform pg_temp.ok(app.storage_cleanup_finish(v_run) = 'partial', 'finishing twice is a no-op');
  perform pg_temp.ok((select state from public.storage_cleanup_items where id = i2::uuid) = 'failed' and (select attempts from public.storage_cleanup_items where id = i2::uuid) = 1, 'failed object stays pending with an attempt count');
  perform pg_temp.ok((select (deleted_count, failed_count) from public.storage_cleanup_runs where id = v_run) = row(1, 1), 'run summary counts');
end $$;

-- Retry: a fresh preview has no new candidates, but the leftover failed object is handed back to the runner.
do $$
declare r jsonb; v_prev jsonb; v_run uuid; i2 text := current_setting('c7.item2'); n integer := 0;
begin
  v_prev := app.storage_cleanup_preview(100);
  perform pg_temp.ok((v_prev ->> 'candidates')::int = 0, 'objects already tombstoned are no longer candidates');
  r := app.storage_cleanup_begin((v_prev ->> 'run_id')::uuid);
  v_run := (r ->> 'run_id')::uuid;
  perform pg_temp.ok(jsonb_array_length(r -> 'pending') = 1 and r -> 'pending' -> 0 ->> 'item_id' = i2, 'retry hands back the failed object');
  -- absent object -> missing
  perform pg_temp.ok(app.storage_cleanup_record(v_run, jsonb_build_array(jsonb_build_object('item_id', i2, 'result', 'missing'))) = 1, 'an object that is already gone is recorded as missing');
  perform pg_temp.ok(app.storage_cleanup_finish(v_run) = 'completed', 'nothing pending: completed');
  perform pg_temp.ok((select (missing_count, failed_count) from public.storage_cleanup_runs where id = v_run) = row(1, 0), 'retry run summary');
  -- Nothing pending now: a further apply has nothing to do.
  v_prev := app.storage_cleanup_preview(100);
  r := app.storage_cleanup_begin((v_prev ->> 'run_id')::uuid);
  perform pg_temp.ok(jsonb_array_length(r -> 'pending') = 0 and (r ->> 'marked')::int = 0, 'repeating the whole cycle is a no-op');
  perform app.storage_cleanup_finish((r ->> 'run_id')::uuid);
end $$;

-- Repeated failures are capped: after 5 attempts the object is abandoned for manual attention, not retried forever.
reset role;
insert into public.attachments (id, organization_id, storage_bucket, storage_path, filename, metadata, deleted_at)
values ('c7f00000-0000-4000-8000-0000000b0099', 'c7f00000-0000-4000-8000-000000000001', 'styling-references', 'c7f00000-0000-4000-8000-000000000001/ref/99.jpg', 'f99',
        jsonb_build_object('kind', 'styling_reference', 'expires_at', to_char(now() - interval '3 days', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')), null);
set local role authenticated;
select pg_temp.claims('c7f00000-0000-4000-8000-000000000021', 'c7f00000-0000-4000-8000-000000000001');
do $$
declare r jsonb; v_prev jsonb; v_item text; k integer;
begin
  for k in 1..5 loop
    v_prev := app.storage_cleanup_preview(100);
    r := app.storage_cleanup_begin((v_prev ->> 'run_id')::uuid);
    v_item := r -> 'pending' -> 0 ->> 'item_id';
    perform app.storage_cleanup_record((r ->> 'run_id')::uuid, jsonb_build_array(jsonb_build_object('item_id', v_item, 'result', 'failed', 'error', 'still failing')));
    perform app.storage_cleanup_finish((r ->> 'run_id')::uuid);
  end loop;
  perform pg_temp.ok((select state from public.storage_cleanup_items where id = v_item::uuid) = 'abandoned', 'after 5 failed attempts the object is abandoned for manual attention');
  v_prev := app.storage_cleanup_preview(100);
  r := app.storage_cleanup_begin((v_prev ->> 'run_id')::uuid);
  perform pg_temp.ok(jsonb_array_length(r -> 'pending') = 0, 'an abandoned object is no longer retried automatically');
  perform app.storage_cleanup_finish((r ->> 'run_id')::uuid);
  perform pg_temp.ok((select status from public.storage_cleanup_runs where id = (r ->> 'run_id')::uuid) = 'partial', 'abandoned objects keep runs visible as partial');
end $$;

-- Lease expiry: a crashed run is abandoned and a new run may start; its leftovers are retried by the next run.
reset role;
insert into public.storage_cleanup_runs (id, organization_id, mode, status, lease_expires_at) values
  ('c7f00000-0000-4000-8000-0000000c0001', 'c7f00000-0000-4000-8000-000000000001', 'apply', 'running', now() - interval '1 minute');
set local role authenticated;
select pg_temp.claims('c7f00000-0000-4000-8000-000000000021', 'c7f00000-0000-4000-8000-000000000001');
do $$
declare r jsonb; v_prev jsonb;
begin
  v_prev := app.storage_cleanup_preview(10);
  r := app.storage_cleanup_begin((v_prev ->> 'run_id')::uuid);
  perform pg_temp.ok((select status from public.storage_cleanup_runs where id = 'c7f00000-0000-4000-8000-0000000c0001') = 'abandoned', 'a run whose lease lapsed is abandoned');
  perform pg_temp.ok((select status from public.storage_cleanup_runs where id = (r ->> 'run_id')::uuid) = 'running', 'and a new run can start');
  perform app.storage_cleanup_finish((r ->> 'run_id')::uuid);
end $$;

-- Org B: only its own candidates; cannot touch A's rows.
select pg_temp.claims('c7f00000-0000-4000-8000-000000000023', 'c7f00000-0000-4000-8000-000000000002');
do $$
declare r jsonb;
begin
  r := app.storage_cleanup_preview(100);
  perform pg_temp.ok((r ->> 'candidates')::int = 1 and exists (select 1 from public.storage_cleanup_items where run_id = (r ->> 'run_id')::uuid and attachment_id = 'c7f00000-0000-4000-8000-0000000b0011'), 'tenant B previews only its own object');
  perform pg_temp.expect($q$select * from app.storage_cleanup_candidates('c7f00000-0000-4000-8000-000000000001', 10)$q$, '42501', 'the eligibility function is not callable by clients');
end $$;

-- Audit and grants.
reset role;
do $$ begin
  if not exists (select 1 from app.audit_log where entity_table = 'storage_cleanup_runs' and organization_id = 'c7f00000-0000-4000-8000-000000000001' and action = 'UPDATE' and diff #>> '{new,status}' = 'partial')
     or not exists (select 1 from app.audit_log where entity_table = 'storage_cleanup_items' and diff #>> '{new,state}' = 'deleted')
     or not exists (select 1 from app.audit_log where entity_table = 'attachments' and diff #>> '{new,metadata,cleanup_run_id}' is not null) then
    raise exception 'FAIL cleanup is not audited end to end'; end if;
  raise notice 'PASS: runs, items and tombstoned attachments are audited';
  if has_function_privilege('anon', 'app.storage_cleanup_preview(integer)', 'execute') or has_function_privilege('public', 'app.storage_cleanup_begin(uuid)', 'execute')
     or has_function_privilege('authenticated', 'app.storage_cleanup_candidates(uuid,integer)', 'execute') or has_function_privilege('authenticated', 'app.storage_cleanup_authorized(boolean)', 'execute')
     or has_table_privilege('authenticated', 'public.storage_cleanup_items', 'update') or has_table_privilege('anon', 'public.storage_cleanup_runs', 'select') then
    raise exception 'FAIL grants'; end if;
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'app' and p.proname like 'storage_cleanup%'
              and (not p.prosecdef or p.proconfig is null or not ('search_path=""' = any (p.proconfig)))) then raise exception 'FAIL definer search_path'; end if;
  raise notice 'PASS: grants and search_path';
end $$;
rollback;
