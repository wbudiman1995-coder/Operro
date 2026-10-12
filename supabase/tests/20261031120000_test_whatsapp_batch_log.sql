-- P3 WhatsApp batch workflow + manual delivery log: preview, batch create/cancel, append-only events, permissions, tenancy.
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/20261031120000_test_whatsapp_batch_log.sql
\set ON_ERROR_STOP on
create or replace function pg_temp.act_as(u text, o text) returns void language plpgsql as $$
begin perform set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated', 'active_org_id', o)::text, true); end $$;
create or replace function pg_temp.expect(p_sql text, p_state text, p_label text) returns void language plpgsql as $$
begin
  begin execute p_sql; exception when others then
    if sqlstate = p_state then raise notice 'PASS: %', p_label; return; end if;
    raise exception 'FAIL: % (expected %, got % %)', p_label, p_state, sqlstate, sqlerrm;
  end;
  raise exception 'FAIL: % (statement succeeded)', p_label;
end $$;
create or replace function pg_temp.check(p_ok boolean, p_label text) returns void language plpgsql as $$
begin if p_ok is not true then raise exception 'FAIL: %', p_label; end if; raise notice 'PASS: %', p_label; end $$;

begin;
insert into public.organizations (id, name, slug, status) values
  ('e3000000-0000-4000-8000-000000000001', 'WB A', 'wb-a-test', 'active'),
  ('e3000000-0000-4000-8000-000000000002', 'WB B', 'wb-b-test', 'active');
insert into public.subscriptions (organization_id, status, current_period_start, current_period_end)
  select o, 'active', now() - interval '1 day', now() + interval '1 year'
  from (values ('e3000000-0000-4000-8000-000000000001'::uuid), ('e3000000-0000-4000-8000-000000000002'::uuid)) t(o);
insert into public.organization_modules (organization_id, module_id, enabled, source)
  select o, m.id, true, 'override' from public.modules m,
  (values ('e3000000-0000-4000-8000-000000000001'::uuid), ('e3000000-0000-4000-8000-000000000002'::uuid)) t(o);
insert into public.branches (id, organization_id, name, is_default, status) values
  ('e3000000-0000-4000-8000-0000000000e1', 'e3000000-0000-4000-8000-000000000001', 'Main', true, 'active'),
  ('e3000000-0000-4000-8000-0000000000e2', 'e3000000-0000-4000-8000-000000000002', 'Main B', true, 'active');
insert into public.roles (id, organization_id, name) values
  ('e3000000-0000-4000-8000-000000000011', 'e3000000-0000-4000-8000-000000000001', 'Pemilik'),
  ('e3000000-0000-4000-8000-000000000012', 'e3000000-0000-4000-8000-000000000001', 'FinanceOnly'),
  ('e3000000-0000-4000-8000-000000000013', 'e3000000-0000-4000-8000-000000000001', 'CrmReader'),
  ('e3000000-0000-4000-8000-000000000014', 'e3000000-0000-4000-8000-000000000002', 'Pemilik');
insert into public.role_permissions (organization_id, role_id, permission_id)
  select 'e3000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000011', id from public.permissions
   where key in ('finance.read','customer.read','customer.manage','membership.read','branches.all');
insert into public.role_permissions (organization_id, role_id, permission_id)
  select 'e3000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000012', id from public.permissions where key in ('finance.read','branches.all');
insert into public.role_permissions (organization_id, role_id, permission_id)
  select 'e3000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000013', id from public.permissions where key in ('customer.read');
insert into public.role_permissions (organization_id, role_id, permission_id)
  select 'e3000000-0000-4000-8000-000000000002', 'e3000000-0000-4000-8000-000000000014', id from public.permissions
   where key in ('finance.read','customer.read','customer.manage','membership.read','branches.all');
insert into auth.users (id, email, raw_user_meta_data) values
  ('e3000000-0000-4000-8000-000000000021', 'owner-a@wb.test', '{}'),
  ('e3000000-0000-4000-8000-000000000022', 'finance@wb.test', '{}'),
  ('e3000000-0000-4000-8000-000000000023', 'crm@wb.test', '{}'),
  ('e3000000-0000-4000-8000-000000000024', 'owner-b@wb.test', '{}');
update public.users set status = 'active' where id::text like 'e3000000-%';
insert into public.memberships (user_id, organization_id, role_id, status) values
  ('e3000000-0000-4000-8000-000000000021', 'e3000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000011', 'active'),
  ('e3000000-0000-4000-8000-000000000022', 'e3000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000012', 'active'),
  ('e3000000-0000-4000-8000-000000000023', 'e3000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000013', 'active'),
  ('e3000000-0000-4000-8000-000000000024', 'e3000000-0000-4000-8000-000000000002', 'e3000000-0000-4000-8000-000000000014', 'active');

-- Customers a1..a8 (a2 no phone, a3 short phone, a4 archived, a5 opted out), other tenant b1.
insert into public.customers (id, organization_id, display_name, phone, deleted_at) values
  ('e3000000-0000-4000-8000-0000000000a1', 'e3000000-0000-4000-8000-000000000001', 'C1', '081200000001', null),
  ('e3000000-0000-4000-8000-0000000000a2', 'e3000000-0000-4000-8000-000000000001', 'C2 NoPhone', null, null),
  ('e3000000-0000-4000-8000-0000000000a3', 'e3000000-0000-4000-8000-000000000001', 'C3 Short', '12345', null),
  ('e3000000-0000-4000-8000-0000000000a4', 'e3000000-0000-4000-8000-000000000001', 'C4 Archived', '081200000004', now()),
  ('e3000000-0000-4000-8000-0000000000a5', 'e3000000-0000-4000-8000-000000000001', 'C5 OptOut', '081200000005', null),
  ('e3000000-0000-4000-8000-0000000000a6', 'e3000000-0000-4000-8000-000000000001', 'C6', '081200000006', null),
  ('e3000000-0000-4000-8000-0000000000a7', 'e3000000-0000-4000-8000-000000000001', 'C7', '081200000007', null),
  ('e3000000-0000-4000-8000-0000000000a8', 'e3000000-0000-4000-8000-000000000001', 'C8', '081200000008', null),
  ('e3000000-0000-4000-8000-0000000000b1', 'e3000000-0000-4000-8000-000000000002', 'B1', '081299999999', null);
insert into public.whatsapp_contact_preferences (organization_id, customer_id) values
  ('e3000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-0000000000a5');
insert into public.invoices (id, organization_id, branch_id, customer_id, invoice_number, status, currency, subtotal, total, issued_at) values
  ('e3000000-0000-4000-8000-0000000000d1', 'e3000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-0000000000e1', 'e3000000-0000-4000-8000-0000000000a1', 'WB-1', 'issued', 'IDR', 100, 100, now()),
  ('e3000000-0000-4000-8000-0000000000d2', 'e3000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-0000000000e1', 'e3000000-0000-4000-8000-0000000000a6', 'WB-2', 'issued', 'IDR', 100, 100, now()),
  ('e3000000-0000-4000-8000-0000000000d3', 'e3000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-0000000000e1', 'e3000000-0000-4000-8000-0000000000a7', 'WB-3', 'issued', 'IDR', 100, 100, now()),
  ('e3000000-0000-4000-8000-0000000000d4', 'e3000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-0000000000e1', 'e3000000-0000-4000-8000-0000000000a2', 'WB-4', 'issued', 'IDR', 100, 100, now()),
  ('e3000000-0000-4000-8000-0000000000d5', 'e3000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-0000000000e1', 'e3000000-0000-4000-8000-0000000000a5', 'WB-5', 'issued', 'IDR', 100, 100, now()),
  ('e3000000-0000-4000-8000-0000000000d6', 'e3000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-0000000000e1', 'e3000000-0000-4000-8000-0000000000a4', 'WB-6', 'issued', 'IDR', 100, 100, now()),
  ('e3000000-0000-4000-8000-0000000000d7', 'e3000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-0000000000e1', 'e3000000-0000-4000-8000-0000000000a8', 'WB-7', 'void',   'IDR', 100, 100, now()),
  ('e3000000-0000-4000-8000-0000000000d8', 'e3000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-0000000000e1', 'e3000000-0000-4000-8000-0000000000a8', 'WB-8', 'issued', 'IDR', 100, 100, now()),
  ('e3000000-0000-4000-8000-0000000000db', 'e3000000-0000-4000-8000-000000000002', 'e3000000-0000-4000-8000-0000000000e2', 'e3000000-0000-4000-8000-0000000000b1', 'WB-B1', 'issued', 'IDR', 1, 1, now());
insert into public.customer_onboarding_links (id, organization_id, token_hash, status) values
  ('e3000000-0000-4000-8000-0000000000c1', 'e3000000-0000-4000-8000-000000000001', 'hash-active-wb', 'active');

set local role authenticated;
create temp table ids (k text primary key, v uuid);
grant all on ids to authenticated;

-- ===== Single create still works and is logged =========================================================================
select pg_temp.act_as('e3000000-0000-4000-8000-000000000021', 'e3000000-0000-4000-8000-000000000001');
do $$
declare r jsonb;
begin
  r := app.create_whatsapp_draft('invoice', 'e3000000-0000-4000-8000-0000000000d1', 'Halo C1 invoice WB-1');
  insert into ids values ('single', (r ->> 'id')::uuid);
  perform pg_temp.check((select count(*) from public.whatsapp_draft_events where draft_id = (select v from ids where k = 'single') and from_status is null and to_status = 'draft') = 1, 'a single draft logs a creation event');
  perform pg_temp.check((select batch_id from public.whatsapp_drafts where id = (select v from ids where k = 'single')) is null, 'a single draft belongs to no batch');
end $$;

-- ===== Preview ============================================================================================================
do $$
declare n integer; r record;
begin
  create temp table prev on commit drop as
    select * from app.preview_whatsapp_batch('invoice', array[
      'e3000000-0000-4000-8000-0000000000d1'::uuid, 'e3000000-0000-4000-8000-0000000000d2', 'e3000000-0000-4000-8000-0000000000d3', 'e3000000-0000-4000-8000-0000000000d4',
      'e3000000-0000-4000-8000-0000000000d5', 'e3000000-0000-4000-8000-0000000000d6', 'e3000000-0000-4000-8000-0000000000d7', 'e3000000-0000-4000-8000-0000000000db',
      'e3000000-0000-4000-8000-0000000000d2', gen_random_uuid()]);
  perform pg_temp.check((select reason from prev where source_id = 'e3000000-0000-4000-8000-0000000000d1') = 'already_in_queue' and (select existing_draft_id from prev where source_id = 'e3000000-0000-4000-8000-0000000000d1') = (select v from ids where k = 'single'), 'a source with a live draft is "already_in_queue" and points at it');
  perform pg_temp.check((select count(*) from prev where eligible) = 2, 'two sources are eligible (d2 and d3)');
  perform pg_temp.check((select reason from prev where source_id = 'e3000000-0000-4000-8000-0000000000d4') = 'recipient_phone_missing', 'missing phone reported');
  perform pg_temp.check((select reason from prev where source_id = 'e3000000-0000-4000-8000-0000000000d5') = 'recipient_opted_out', 'opt-out reported');
  perform pg_temp.check((select reason from prev where source_id = 'e3000000-0000-4000-8000-0000000000d6') = 'source_archived', 'archived customer reported');
  perform pg_temp.check((select reason from prev where source_id = 'e3000000-0000-4000-8000-0000000000d7') = 'source_not_found', 'void invoice reported as not found');
  perform pg_temp.check((select reason from prev where source_id = 'e3000000-0000-4000-8000-0000000000db') = 'source_not_found', 'another tenant''s invoice reported as not found');
  perform pg_temp.check((select count(*) from prev where reason = 'duplicate_in_request') = 1, 'a repeated id in one request is flagged');
  perform pg_temp.check((select count(*) from prev where reason = 'source_not_found') = 3, 'unknown ids are not found (void, other tenant, random)');
  perform pg_temp.check((select count(*) from public.whatsapp_drafts) = 1, 'preview wrote nothing');
  perform pg_temp.expect($q$select * from app.preview_whatsapp_batch('invoice', array[]::uuid[])$q$, '22023', 'empty preview refused');
  perform pg_temp.expect($q$select * from app.preview_whatsapp_batch('invoice', null)$q$, '22023', 'null preview refused');
  perform pg_temp.expect($q$select * from app.preview_whatsapp_batch('invoice', (select array_agg(gen_random_uuid()) from generate_series(1, 26)))$q$, '22023', 'more than 25 sources refused');
  perform pg_temp.expect($q$select * from app.preview_whatsapp_batch('onboarding', array[gen_random_uuid()])$q$, '42501', 'onboarding cannot be previewed as a batch source (customer.manage holders included)');
  perform pg_temp.expect($q$select * from app.preview_whatsapp_batch('sms', array[gen_random_uuid()])$q$, '42501', 'unknown type refused');
end $$;

-- ===== Batch create =======================================================================================================
do $$
declare r jsonb; b uuid; n integer;
begin
  r := app.create_whatsapp_batch('invoice', jsonb_build_array(
    jsonb_build_object('source_id', 'e3000000-0000-4000-8000-0000000000d1', 'message', 'Halo C1'),                  -- existing live draft
    jsonb_build_object('source_id', 'e3000000-0000-4000-8000-0000000000d2', 'message', 'Halo C6 WB-2'),             -- created
    jsonb_build_object('source_id', 'e3000000-0000-4000-8000-0000000000d3', 'message', 'Halo C7 WB-3'),             -- created
    jsonb_build_object('source_id', 'e3000000-0000-4000-8000-0000000000d4', 'message', 'Halo C2'),                  -- no phone
    jsonb_build_object('source_id', 'e3000000-0000-4000-8000-0000000000d5', 'message', 'Halo C5'),                  -- opted out
    jsonb_build_object('source_id', 'e3000000-0000-4000-8000-0000000000d6', 'message', 'Halo C4'),                  -- archived
    jsonb_build_object('source_id', 'e3000000-0000-4000-8000-0000000000d7', 'message', 'Halo C8'),                  -- void
    jsonb_build_object('source_id', 'e3000000-0000-4000-8000-0000000000db', 'message', 'Halo B1'),                  -- other tenant
    jsonb_build_object('source_id', 'e3000000-0000-4000-8000-0000000000d2', 'message', 'dup'),                     -- duplicate in request
    jsonb_build_object('source_id', 'e3000000-0000-4000-8000-0000000000d8', 'message', 'Halo {nama}'),             -- unresolved variable
    jsonb_build_object('source_id', 'not-a-uuid', 'message', 'x'),
    '"scalar"'::jsonb));
  b := (r ->> 'batch_id')::uuid;
  insert into ids values ('batch', b);
  perform pg_temp.check((r ->> 'created')::int = 2 and (r ->> 'existing')::int = 1 and (r ->> 'skipped')::int = 9, 'outcome counts: 2 created, 1 existing, 9 skipped');
  perform pg_temp.check((select count(*) from public.whatsapp_drafts where batch_id = b) = 2, 'only created drafts belong to the batch; the pre-existing draft is untouched');
  perform pg_temp.check((select batch_id from public.whatsapp_drafts where id = (select v from ids where k = 'single')) is null, 'the existing single draft stays out of the batch');
  perform pg_temp.check((select draft_count = 2 and existing_count = 1 and skipped_count = 9 and status = 'open' from public.whatsapp_batches where id = b), 'batch row records the counts');
  perform pg_temp.check((select array_agg(x ->> 'reason' order by x ->> 'reason') filter (where x ->> 'outcome' = 'skipped') from jsonb_array_elements(r -> 'results') x)
    = array['duplicate_in_request','invalid_item','invalid_item','invalid_message','recipient_opted_out','recipient_phone_missing','source_archived','source_not_found','source_not_found'], 'every skip carries its reason');
  perform pg_temp.check((select recipient_phone from public.whatsapp_drafts where source_id = 'e3000000-0000-4000-8000-0000000000d2' and batch_id = b) = '6281200000006', 'recipient phone derived from the customer row, not from the browser');
  -- replay: nothing new, no empty batch
  r := app.create_whatsapp_batch('invoice', jsonb_build_array(
    jsonb_build_object('source_id', 'e3000000-0000-4000-8000-0000000000d2', 'message', 'again'),
    jsonb_build_object('source_id', 'e3000000-0000-4000-8000-0000000000d3', 'message', 'again')));
  perform pg_temp.check(r -> 'batch_id' = 'null'::jsonb and (r ->> 'existing')::int = 2 and (r ->> 'created')::int = 0, 'replaying a batch is idempotent and creates no empty batch');
  perform pg_temp.check((select count(*) from public.whatsapp_batches) = 1, 'still one batch');
  perform pg_temp.check((select message_text from public.whatsapp_drafts where source_id = 'e3000000-0000-4000-8000-0000000000d2' and batch_id = b) = 'Halo C6 WB-2', 'replay did not overwrite the stored text');
  -- bounds
  perform pg_temp.expect($q$select app.create_whatsapp_batch('invoice', '[]'::jsonb)$q$, '22023', 'empty batch refused');
  perform pg_temp.expect($q$select app.create_whatsapp_batch('invoice', '{}'::jsonb)$q$, '22023', 'non-array refused');
  perform pg_temp.expect($q$select app.create_whatsapp_batch('invoice', null)$q$, '22023', 'null refused');
  perform pg_temp.expect($q$select app.create_whatsapp_batch('invoice', (select jsonb_agg(jsonb_build_object('source_id', gen_random_uuid(), 'message', 'x')) from generate_series(1, 26)))$q$, '22023', 'more than 25 items refused');
  perform pg_temp.expect($q$select app.create_whatsapp_batch('onboarding', '[{"source_id":"e3000000-0000-4000-8000-0000000000c1","message":"x"}]'::jsonb)$q$, '22023', 'onboarding invitations cannot be batched (their link is never stored)');
  perform pg_temp.expect($q$select app.create_whatsapp_batch('sms', '[]'::jsonb)$q$, '42501', 'unknown source type refused');
end $$;

-- ===== Delivery log =======================================================================================================
do $$
declare b uuid := (select v from ids where k = 'batch'); d2 uuid; d3 uuid; n integer;
begin
  select id into d2 from public.whatsapp_drafts where batch_id = b and source_id = 'e3000000-0000-4000-8000-0000000000d2';
  select id into d3 from public.whatsapp_drafts where batch_id = b and source_id = 'e3000000-0000-4000-8000-0000000000d3';
  insert into ids values ('d2', d2), ('d3', d3);
  perform pg_temp.check((select count(*) from public.whatsapp_draft_events where batch_id = b and from_status is null and to_status = 'draft') = 2, 'each batch draft logged its creation with the batch id');
  perform app.set_whatsapp_draft_status(d2, 'opened');
  perform app.set_whatsapp_draft_status(d2, 'opened');
  perform app.set_whatsapp_draft_status(d2, 'failed', 'WhatsApp tidak terbuka');
  perform app.set_whatsapp_draft_status(d2, 'draft', 'coba lagi');
  perform app.set_whatsapp_draft_status(d2, 'marked_sent', 'dikirim manual');
  perform pg_temp.check((select array_agg(coalesce(from_status, '-') || '>' || to_status order by occurred_at, id) from public.whatsapp_draft_events where draft_id = d2)
    = array['->draft','draft>opened','opened>failed','failed>draft','draft>marked_sent'], 'the log records each real transition once (the repeated open is a no-op) including the retry');
  perform pg_temp.check((select note from public.whatsapp_draft_events where draft_id = d2 and to_status = 'failed') = 'WhatsApp tidak terbuka', 'the user-reported note is logged');
  perform pg_temp.check((select actor_id from public.whatsapp_draft_events where draft_id = d2 and to_status = 'opened') = 'e3000000-0000-4000-8000-000000000021', 'the actor is the authenticated user');
  perform pg_temp.check(not exists (select 1 from public.whatsapp_draft_events where to_status not in ('draft','opened','marked_sent','failed','canceled')), 'no provider-style status exists in the log');
  -- opt-out cancellation is logged like any other change
  perform app.set_whatsapp_opt_out('e3000000-0000-4000-8000-0000000000a7', true);
  perform pg_temp.check((select to_status from public.whatsapp_draft_events where draft_id = d3 order by occurred_at desc, id desc limit 1) = 'canceled', 'an opt-out cancellation lands in the log');
  perform pg_temp.check((select status_note from public.whatsapp_drafts where id = d3) = 'Pelanggan berhenti menerima pesan WhatsApp', 'with its reason');
  perform app.set_whatsapp_opt_out('e3000000-0000-4000-8000-0000000000a7', false);
end $$;

-- ===== Cancel batch ======================================================================================================
do $$
declare r jsonb; b2 uuid; n integer; d4 uuid;
begin
  r := app.create_whatsapp_batch('invoice', jsonb_build_array(
    jsonb_build_object('source_id', 'e3000000-0000-4000-8000-0000000000d3', 'message', 'Halo C7 lagi'),
    jsonb_build_object('source_id', 'e3000000-0000-4000-8000-0000000000d8', 'message', 'Halo C8 WB-8')));
  b2 := (r ->> 'batch_id')::uuid;
  insert into ids values ('batch2', b2);
  perform pg_temp.check((r ->> 'created')::int = 2, 'a new batch of two (d3 had been canceled, so it can be drafted again)');
  perform app.set_whatsapp_draft_status((select id from public.whatsapp_drafts where batch_id = b2 and source_id = 'e3000000-0000-4000-8000-0000000000d3'), 'opened');
  select id into d4 from public.whatsapp_drafts where batch_id = b2 and source_id = 'e3000000-0000-4000-8000-0000000000d8';
  perform app.set_whatsapp_draft_status(d4, 'failed');
  n := app.cancel_whatsapp_batch(b2);
  perform pg_temp.check(n = 2, 'cancel handles opened and failed drafts');
  perform pg_temp.check((select count(*) from public.whatsapp_drafts where batch_id = b2 and status = 'canceled' and status_note = 'Batch dibatalkan') = 2, 'every live draft canceled with a reason');
  perform pg_temp.check((select status = 'canceled' and canceled_count = 2 and canceled_by is not null and canceled_at is not null from public.whatsapp_batches where id = b2), 'the batch records who canceled and how many');
  perform pg_temp.check(app.cancel_whatsapp_batch(b2) = 0, 'canceling twice is a no-op');
  n := app.cancel_whatsapp_batch((select v from ids where k = 'batch'));
  perform pg_temp.check(n = 0 and (select status from public.whatsapp_drafts where id = (select v from ids where k = 'd2')) = 'marked_sent', 'a draft already marked as sent is never changed by a cancel');
  perform pg_temp.expect($q$select app.cancel_whatsapp_batch(gen_random_uuid())$q$, 'P0002', 'unknown batch not found');
  perform pg_temp.expect($q$select app.cancel_whatsapp_batch(null)$q$, '42501', 'null batch refused');
end $$;

-- ===== Permissions: per-source capability =================================================================================
select pg_temp.act_as('e3000000-0000-4000-8000-000000000022', 'e3000000-0000-4000-8000-000000000001');
do $$ begin
  perform pg_temp.check((select count(*) from public.whatsapp_batches) = 2, 'finance-only role sees invoice batches');
  perform pg_temp.check((select count(*) from public.whatsapp_draft_events) > 0, 'and their events');
  perform pg_temp.expect($q$select * from app.preview_whatsapp_batch('followup', array[gen_random_uuid()])$q$, '42501', 'finance-only cannot preview follow-up batches');
  perform pg_temp.expect($q$select app.create_whatsapp_batch('followup', '[{"source_id":"e3000000-0000-4000-8000-0000000000a1","message":"x"}]'::jsonb)$q$, '42501', 'finance-only cannot create follow-up batches');
  perform pg_temp.check(app.cancel_whatsapp_batch((select v from ids where k = 'batch2')) = 0, 'finance-only may cancel an invoice batch (already canceled: no-op)');
end $$;
select pg_temp.act_as('e3000000-0000-4000-8000-000000000023', 'e3000000-0000-4000-8000-000000000001');
do $$ begin
  perform pg_temp.check((select count(*) from public.whatsapp_batches) = 0 and (select count(*) from public.whatsapp_draft_events) = 0, 'crm reader sees no invoice batches or events');
  perform pg_temp.expect($q$select * from app.preview_whatsapp_batch('invoice', array[gen_random_uuid()])$q$, '42501', 'crm reader cannot preview invoice batches');
  perform pg_temp.expect($q$select app.cancel_whatsapp_batch((select v from ids where k = 'batch'))$q$, 'P0002', 'crm reader cannot reach an invoice batch');
  perform pg_temp.check(jsonb_array_length((app.create_whatsapp_batch('followup', '[{"source_id":"e3000000-0000-4000-8000-0000000000a1","message":"Halo C1"},{"source_id":"e3000000-0000-4000-8000-0000000000a2","message":"Halo C2"}]'::jsonb)) -> 'results') = 2, 'crm reader batches follow-ups');
end $$;

-- ===== Tenant isolation / direct DML ======================================================================================
select pg_temp.act_as('e3000000-0000-4000-8000-000000000024', 'e3000000-0000-4000-8000-000000000002');
do $$ begin
  perform pg_temp.check((select count(*) from public.whatsapp_batches) = 0 and (select count(*) from public.whatsapp_draft_events) = 0, 'tenant B sees nothing of tenant A');
  perform pg_temp.expect($q$select app.cancel_whatsapp_batch((select v from ids where k = 'batch'))$q$, 'P0002', 'tenant B cannot cancel tenant A''s batch');
  perform pg_temp.check((app.create_whatsapp_batch('invoice', '[{"source_id":"e3000000-0000-4000-8000-0000000000d1","message":"x"}]'::jsonb) ->> 'skipped')::int = 1, 'tenant B cannot draft tenant A''s invoice (skipped as not found)');
  perform pg_temp.check((app.create_whatsapp_batch('invoice', '[{"source_id":"e3000000-0000-4000-8000-0000000000db","message":"Halo B1"}]'::jsonb) ->> 'created')::int = 1, 'tenant B batches its own invoice');
end $$;
select pg_temp.act_as('e3000000-0000-4000-8000-000000000021', 'e3000000-0000-4000-8000-000000000002');
do $$ begin
  perform pg_temp.expect($q$select app.create_whatsapp_batch('invoice', '[{"source_id":"e3000000-0000-4000-8000-0000000000db","message":"x"}]'::jsonb)$q$, '42501', 'forged active organization refused');
  perform pg_temp.expect($q$select * from app.preview_whatsapp_batch('invoice', array[gen_random_uuid()])$q$, '42501', 'forged active organization refused for preview');
end $$;
select pg_temp.act_as('e3000000-0000-4000-8000-000000000021', 'e3000000-0000-4000-8000-000000000001');
do $$ begin
  perform pg_temp.expect($q$update public.whatsapp_draft_events set note = 'x'$q$, '42501', 'clients cannot UPDATE the log');
  perform pg_temp.expect($q$delete from public.whatsapp_draft_events$q$, '42501', 'clients cannot DELETE from the log');
  perform pg_temp.expect($q$insert into public.whatsapp_draft_events(organization_id, draft_id, source_type, to_status) values (app.fn_active_organization(), gen_random_uuid(), 'invoice', 'draft')$q$, '42501', 'clients cannot INSERT into the log');
  perform pg_temp.expect($q$update public.whatsapp_batches set status = 'canceled'$q$, '42501', 'clients cannot UPDATE batches');
  perform pg_temp.expect($q$insert into public.whatsapp_batches(organization_id, source_type) values (app.fn_active_organization(), 'invoice')$q$, '42501', 'clients cannot INSERT batches');
  perform pg_temp.expect($q$update public.whatsapp_drafts set batch_id = null$q$, '42501', 'clients cannot move drafts between batches');
end $$;

-- ===== Structure / grants ==================================================================================================
reset role;
do $$
declare f text; v_def boolean; v_cfg text[];
begin
  perform pg_temp.expect($q$update public.whatsapp_draft_events set note = 'x'$q$, '23001', 'even the table owner cannot UPDATE a log entry');
  perform pg_temp.check((select count(*) from public.whatsapp_draft_events where batch_id is not null) >= 6, 'batch id is carried on the events');
  foreach f in array array['preview_whatsapp_batch','create_whatsapp_batch','cancel_whatsapp_batch','create_whatsapp_draft','whatsapp_resolve_recipient','tg_whatsapp_draft_event'] loop
    select p.prosecdef, p.proconfig into v_def, v_cfg from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'app' and p.proname = f;
    perform pg_temp.check(v_def and v_cfg && array['search_path=""', 'search_path='], f || ' is SECURITY DEFINER with an empty search_path');
  end loop;
  perform pg_temp.check(not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
     where n.nspname = 'app' and p.proname in ('preview_whatsapp_batch','create_whatsapp_batch','cancel_whatsapp_batch','create_whatsapp_draft','whatsapp_resolve_recipient','tg_whatsapp_draft_event','tg_whatsapp_events_append_only')
       and (a.grantee = 0 or a.grantee = 'anon'::regrole)), 'anon and PUBLIC cannot execute any of them');
  perform pg_temp.check(not has_function_privilege('authenticated', 'app.whatsapp_resolve_recipient(uuid,text,uuid)', 'execute'), 'the shared eligibility rule is not client-callable');
  perform pg_temp.check(not has_table_privilege('authenticated', 'public.whatsapp_draft_events', 'insert') and not has_table_privilege('anon', 'public.whatsapp_batches', 'select'), 'clients hold SELECT only on the new tables; anon nothing');
  perform pg_temp.check((select relrowsecurity from pg_class where oid = 'public.whatsapp_batches'::regclass) and (select relrowsecurity from pg_class where oid = 'public.whatsapp_draft_events'::regclass), 'RLS on both new tables');
  perform pg_temp.check((select count(*) from app.audit_log where entity_table = 'whatsapp_batches' and action in ('INSERT','UPDATE')) >= 3, 'batch creation and cancellation are audited');
  perform pg_temp.check(not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('app','public') and p.prosrc ~* '(http_post|net\.http|pg_net|wa\.me/send|api\.whatsapp|graph\.facebook)'), 'no function calls a network or WhatsApp API');
  perform pg_temp.check(app.schema_version() >= '20261031120000', 'schema version moved to (or past) this migration');
end $$;
rollback;
