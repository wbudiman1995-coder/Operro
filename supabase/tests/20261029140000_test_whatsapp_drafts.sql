-- E2.3 WhatsApp draft center: lifecycle, idempotency, opt-out/missing phone, archived sources, permissions, tenancy, audit.
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/20261029140000_test_whatsapp_drafts.sql
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

begin;
insert into public.organizations (id, name, slug, status) values
  ('c5f00000-0000-4000-8000-000000000001', 'WA A', 'wa-a-test', 'active'),
  ('c5f00000-0000-4000-8000-000000000002', 'WA B', 'wa-b-test', 'active');
insert into public.subscriptions (organization_id, status, current_period_start, current_period_end)
  select o, 'active', now() - interval '1 day', now() + interval '1 year'
  from (values ('c5f00000-0000-4000-8000-000000000001'::uuid), ('c5f00000-0000-4000-8000-000000000002'::uuid)) t(o);
insert into public.organization_modules (organization_id, module_id, enabled, source)
  select o, m.id, true, 'override' from public.modules m,
  (values ('c5f00000-0000-4000-8000-000000000001'::uuid), ('c5f00000-0000-4000-8000-000000000002'::uuid)) t(o);
insert into public.branches (id, organization_id, name, is_default, status) values
  ('c5f00000-0000-4000-8000-0000000000e1', 'c5f00000-0000-4000-8000-000000000001', 'Main', true, 'active'),
  ('c5f00000-0000-4000-8000-0000000000e2', 'c5f00000-0000-4000-8000-000000000002', 'Main B', true, 'active');
insert into public.roles (id, organization_id, name) values
  ('c5f00000-0000-4000-8000-000000000011', 'c5f00000-0000-4000-8000-000000000001', 'Pemilik'),
  ('c5f00000-0000-4000-8000-000000000012', 'c5f00000-0000-4000-8000-000000000001', 'FinanceOnly'),
  ('c5f00000-0000-4000-8000-000000000013', 'c5f00000-0000-4000-8000-000000000001', 'CrmReader'),
  ('c5f00000-0000-4000-8000-000000000014', 'c5f00000-0000-4000-8000-000000000002', 'Pemilik');
insert into public.role_permissions (organization_id, role_id, permission_id)
  select 'c5f00000-0000-4000-8000-000000000001', 'c5f00000-0000-4000-8000-000000000011', id from public.permissions
   where key in ('finance.read','customer.read','customer.manage','membership.read','branches.all');
insert into public.role_permissions (organization_id, role_id, permission_id)
  select 'c5f00000-0000-4000-8000-000000000001', 'c5f00000-0000-4000-8000-000000000012', id from public.permissions where key in ('finance.read','branches.all');
insert into public.role_permissions (organization_id, role_id, permission_id)
  select 'c5f00000-0000-4000-8000-000000000001', 'c5f00000-0000-4000-8000-000000000013', id from public.permissions where key in ('customer.read');
insert into public.role_permissions (organization_id, role_id, permission_id)
  select 'c5f00000-0000-4000-8000-000000000002', 'c5f00000-0000-4000-8000-000000000014', id from public.permissions
   where key in ('finance.read','customer.read','customer.manage','membership.read','branches.all');
insert into auth.users (id, email, raw_user_meta_data) values
  ('c5f00000-0000-4000-8000-000000000021', 'owner-a@wa.test', '{}'),
  ('c5f00000-0000-4000-8000-000000000022', 'finance@wa.test', '{}'),
  ('c5f00000-0000-4000-8000-000000000023', 'crm@wa.test', '{}'),
  ('c5f00000-0000-4000-8000-000000000024', 'owner-b@wa.test', '{}');
update public.users set status = 'active' where id::text like 'c5f00000-%';
insert into public.memberships (user_id, organization_id, role_id, status) values
  ('c5f00000-0000-4000-8000-000000000021', 'c5f00000-0000-4000-8000-000000000001', 'c5f00000-0000-4000-8000-000000000011', 'active'),
  ('c5f00000-0000-4000-8000-000000000022', 'c5f00000-0000-4000-8000-000000000001', 'c5f00000-0000-4000-8000-000000000012', 'active'),
  ('c5f00000-0000-4000-8000-000000000023', 'c5f00000-0000-4000-8000-000000000001', 'c5f00000-0000-4000-8000-000000000013', 'active'),
  ('c5f00000-0000-4000-8000-000000000024', 'c5f00000-0000-4000-8000-000000000002', 'c5f00000-0000-4000-8000-000000000014', 'active');

insert into public.customers (id, organization_id, display_name, phone, deleted_at) values
  ('c5f00000-0000-4000-8000-0000000000a1', 'c5f00000-0000-4000-8000-000000000001', 'Ok', '0812-3456-7890', null),
  ('c5f00000-0000-4000-8000-0000000000a2', 'c5f00000-0000-4000-8000-000000000001', 'NoPhone', null, null),
  ('c5f00000-0000-4000-8000-0000000000a3', 'c5f00000-0000-4000-8000-000000000001', 'ShortPhone', '12345', null),
  ('c5f00000-0000-4000-8000-0000000000a4', 'c5f00000-0000-4000-8000-000000000001', 'Archived', '081200000004', now()),
  ('c5f00000-0000-4000-8000-0000000000a5', 'c5f00000-0000-4000-8000-000000000001', 'OptOut', '081200000005', null),
  ('c5f00000-0000-4000-8000-0000000000a6', 'c5f00000-0000-4000-8000-000000000001', 'Intl', '+62 811-2222-3333', null),
  ('c5f00000-0000-4000-8000-0000000000b1', 'c5f00000-0000-4000-8000-000000000002', 'Other tenant', '081299999999', null);
insert into public.invoices (id, organization_id, branch_id, customer_id, invoice_number, status, currency, subtotal, total, issued_at) values
  ('c5f00000-0000-4000-8000-0000000000d1', 'c5f00000-0000-4000-8000-000000000001', 'c5f00000-0000-4000-8000-0000000000e1', 'c5f00000-0000-4000-8000-0000000000a1', 'WA-1', 'issued', 'IDR', 100000, 100000, now()),
  ('c5f00000-0000-4000-8000-0000000000d2', 'c5f00000-0000-4000-8000-000000000001', 'c5f00000-0000-4000-8000-0000000000e1', 'c5f00000-0000-4000-8000-0000000000a1', 'WA-2', 'void',   'IDR', 100000, 100000, now()),
  ('c5f00000-0000-4000-8000-0000000000d3', 'c5f00000-0000-4000-8000-000000000001', 'c5f00000-0000-4000-8000-0000000000e1', 'c5f00000-0000-4000-8000-0000000000a5', 'WA-3', 'issued', 'IDR', 100000, 100000, now()),
  ('c5f00000-0000-4000-8000-0000000000d4', 'c5f00000-0000-4000-8000-000000000002', 'c5f00000-0000-4000-8000-0000000000e2', 'c5f00000-0000-4000-8000-0000000000b1', 'WA-B1', 'issued', 'IDR', 1, 1, now());
insert into public.customer_onboarding_links (id, organization_id, token_hash, status) values
  ('c5f00000-0000-4000-8000-0000000000c1', 'c5f00000-0000-4000-8000-000000000001', 'hash-active', 'active'),
  ('c5f00000-0000-4000-8000-0000000000c2', 'c5f00000-0000-4000-8000-000000000001', 'hash-revoked', 'revoked');

set local role authenticated;
select pg_temp.act_as('c5f00000-0000-4000-8000-000000000021', 'c5f00000-0000-4000-8000-000000000001');
do $$
declare r jsonb; r2 jsonb; v_id uuid; v_status text;
begin
  -- Invoice draft: recipient comes from the customer row, normalised; idempotent per live source.
  r := app.create_whatsapp_draft('invoice', 'c5f00000-0000-4000-8000-0000000000d1', 'Halo Ok, invoice WA-1 Rp100.000');
  if (r ->> 'created')::boolean is not true then raise exception 'FAIL not created'; end if;
  v_id := (r ->> 'id')::uuid;
  if (select recipient_phone from public.whatsapp_drafts where id = v_id) <> '6281234567890' then raise exception 'FAIL phone normalisation'; end if;
  if (select status from public.whatsapp_drafts where id = v_id) <> 'draft' then raise exception 'FAIL initial status'; end if;
  r2 := app.create_whatsapp_draft('invoice', 'c5f00000-0000-4000-8000-0000000000d1', 'different text');
  if (r2 ->> 'id')::uuid <> v_id or (r2 ->> 'created')::boolean then raise exception 'FAIL duplicate draft created for same live source'; end if;
  if (select message_text from public.whatsapp_drafts where id = v_id) <> 'Halo Ok, invoice WA-1 Rp100.000' then raise exception 'FAIL idempotent create overwrote text'; end if;
  raise notice 'PASS: invoice draft, phone normalised from DB, create is idempotent';

  -- International format and followup/renewal sources.
  r := app.create_whatsapp_draft('followup', 'c5f00000-0000-4000-8000-0000000000a6', 'Halo Intl');
  if (select recipient_phone from public.whatsapp_drafts where id = (r ->> 'id')::uuid) <> '6281122223333' then raise exception 'FAIL +62 phone'; end if;
  perform pg_temp.expect($q$select app.create_whatsapp_draft('renewal', 'c5f00000-0000-4000-8000-0000000000a1', 'x')$q$, 'P0002', 'renewal for a non-existent membership refused');

  -- Refusals: void invoice, missing/short phone, archived customer, opted-out, unresolved template, control chars, wrong source type, empty.
  perform pg_temp.expect($q$select app.create_whatsapp_draft('invoice', 'c5f00000-0000-4000-8000-0000000000d2', 'x')$q$, 'P0002', 'void invoice refused');
  perform pg_temp.expect($q$select app.create_whatsapp_draft('followup', 'c5f00000-0000-4000-8000-0000000000a2', 'x')$q$, '22023', 'missing phone refused');
  perform pg_temp.expect($q$select app.create_whatsapp_draft('followup', 'c5f00000-0000-4000-8000-0000000000a3', 'x')$q$, '22023', 'implausible phone refused');
  perform pg_temp.expect($q$select app.create_whatsapp_draft('followup', 'c5f00000-0000-4000-8000-0000000000a4', 'x')$q$, '22023', 'archived customer refused');
  perform pg_temp.expect($q$select app.create_whatsapp_draft('followup', 'c5f00000-0000-4000-8000-0000000000a1', 'Halo {nama}, kami {biz}')$q$, '22023', 'unresolved template variables refused');
  perform pg_temp.expect($q$select app.create_whatsapp_draft('followup', 'c5f00000-0000-4000-8000-0000000000a1', E'bad\x01char')$q$, '22023', 'control character refused');
  perform pg_temp.expect($q$select app.create_whatsapp_draft('followup', 'c5f00000-0000-4000-8000-0000000000a1', repeat('x', 1501))$q$, '22023', 'overlong message refused');
  perform pg_temp.expect($q$select app.create_whatsapp_draft('followup', 'c5f00000-0000-4000-8000-0000000000a1', '   ')$q$, '22023', 'empty message refused');
  perform pg_temp.expect($q$select app.create_whatsapp_draft('sms', 'c5f00000-0000-4000-8000-0000000000a1', 'x')$q$, '42501', 'unknown source type refused');
  raise notice 'PASS: refusals';

  -- Lifecycle: draft -> opened (idempotent) -> marked_sent (terminal).
  v_status := app.set_whatsapp_draft_status(v_id, 'opened');
  v_status := app.set_whatsapp_draft_status(v_id, 'opened');
  if v_status <> 'opened' then raise exception 'FAIL repeated open'; end if;
  v_status := app.set_whatsapp_draft_status(v_id, 'marked_sent', 'dikirim manual');
  if (select status_note from public.whatsapp_drafts where id = v_id) <> 'dikirim manual' then raise exception 'FAIL note'; end if;
  perform pg_temp.expect(format($q$select app.set_whatsapp_draft_status(%L, 'draft')$q$, v_id), '22023', 'marked_sent is terminal');
  perform pg_temp.expect(format($q$select app.set_whatsapp_draft_status(%L, 'canceled')$q$, v_id), '22023', 'cannot cancel after marked_sent');
  if app.set_whatsapp_draft_status(v_id, 'marked_sent') <> 'marked_sent' then raise exception 'FAIL repeated marked_sent not idempotent'; end if;
  -- A terminal draft no longer blocks a new one for the same source.
  r := app.create_whatsapp_draft('invoice', 'c5f00000-0000-4000-8000-0000000000d1', 'Pengingat kedua');
  if (r ->> 'created')::boolean is not true or (r ->> 'id')::uuid = v_id then raise exception 'FAIL new draft after terminal'; end if;
  raise notice 'PASS: lifecycle, idempotent repeats, terminal state, new draft after terminal';

  -- failed -> draft retry -> canceled; invalid jumps rejected.
  v_id := (r ->> 'id')::uuid;
  perform app.set_whatsapp_draft_status(v_id, 'failed', 'nomor tidak aktif');
  perform pg_temp.expect(format($q$select app.set_whatsapp_draft_status(%L, 'opened')$q$, v_id), '22023', 'failed cannot jump to opened');
  perform pg_temp.expect(format($q$select app.set_whatsapp_draft_status(%L, 'marked_sent')$q$, v_id), '22023', 'failed cannot jump to marked_sent');
  perform app.set_whatsapp_draft_status(v_id, 'draft');
  perform app.set_whatsapp_draft_status(v_id, 'canceled');
  perform pg_temp.expect(format($q$select app.set_whatsapp_draft_status(%L, 'draft')$q$, v_id), '22023', 'canceled is terminal');
  perform pg_temp.expect(format($q$select app.set_whatsapp_draft_status(%L, 'delivered')$q$, v_id), '22023', 'provider-style status rejected');
  perform pg_temp.expect(format($q$select app.set_whatsapp_draft_status(%L, 'read')$q$, v_id), '22023', 'read-receipt status rejected');
  perform pg_temp.expect(format($q$select app.set_whatsapp_draft_status(%L, 'opened', %L)$q$, v_id, repeat('n', 301)), '22023', 'overlong note rejected');
  raise notice 'PASS: failed/retry/cancel transitions';

  -- Opt-out cancels live drafts, blocks new ones and blocks opening/marking existing ones.
  r := app.create_whatsapp_draft('invoice', 'c5f00000-0000-4000-8000-0000000000d3', 'Halo OptOut');
  v_id := (r ->> 'id')::uuid;
  if app.set_whatsapp_opt_out('c5f00000-0000-4000-8000-0000000000a5', true) <> 1 then raise exception 'FAIL opt-out did not cancel the live draft'; end if;
  if (select status from public.whatsapp_drafts where id = v_id) <> 'canceled' then raise exception 'FAIL draft not canceled by opt-out'; end if;
  perform pg_temp.expect($q$select app.create_whatsapp_draft('followup', 'c5f00000-0000-4000-8000-0000000000a5', 'x')$q$, '22023', 'opted-out customer cannot get a draft');
  perform app.set_whatsapp_opt_out('c5f00000-0000-4000-8000-0000000000a5', false);
  r := app.create_whatsapp_draft('followup', 'c5f00000-0000-4000-8000-0000000000a5', 'Halo lagi');
  perform app.set_whatsapp_opt_out('c5f00000-0000-4000-8000-0000000000a5', true);
  if (select status from public.whatsapp_drafts where id = (r ->> 'id')::uuid) <> 'canceled' then raise exception 'FAIL second opt-out'; end if;
  raise notice 'PASS: opt-out cancels, blocks creation, can be reversed';
end $$;

-- Archived source after drafting: cannot be opened/marked sent, can be canceled.
reset role;
insert into public.whatsapp_drafts(id, organization_id, source_type, source_id, customer_id, recipient_phone, message_text)
values ('c5f00000-0000-4000-8000-0000000000f1', 'c5f00000-0000-4000-8000-000000000001', 'followup', 'c5f00000-0000-4000-8000-0000000000a4',
        'c5f00000-0000-4000-8000-0000000000a4', '6281200000004', 'stale');
set local role authenticated;
select pg_temp.act_as('c5f00000-0000-4000-8000-000000000021', 'c5f00000-0000-4000-8000-000000000001');
do $$ begin
  perform pg_temp.expect($q$select app.set_whatsapp_draft_status('c5f00000-0000-4000-8000-0000000000f1', 'opened')$q$, '22023', 'draft of an archived customer cannot be opened');
  perform pg_temp.expect($q$select app.set_whatsapp_draft_status('c5f00000-0000-4000-8000-0000000000f1', 'marked_sent')$q$, '22023', 'draft of an archived customer cannot be marked sent');
  perform app.set_whatsapp_draft_status('c5f00000-0000-4000-8000-0000000000f1', 'canceled', 'arsip');
  raise notice 'PASS: archived source can only be canceled';
end $$;

-- Onboarding: no recipient, no secret.
do $$
declare r jsonb;
begin
  r := app.create_whatsapp_draft('onboarding', 'c5f00000-0000-4000-8000-0000000000c1', 'Halo! Isi data lewat link pendaftaran sekali pakai dari halaman Onboarding.');
  if (select recipient_phone from public.whatsapp_drafts where id = (r ->> 'id')::uuid) is not null then raise exception 'FAIL onboarding has a recipient'; end if;
  perform pg_temp.expect($q$select app.create_whatsapp_draft('onboarding', 'c5f00000-0000-4000-8000-0000000000c2', 'x')$q$, 'P0002', 'revoked onboarding link refused');
  perform pg_temp.expect($q$select app.create_whatsapp_draft('onboarding', 'c5f00000-0000-4000-8000-0000000000c1', 'https://operro.example/join/AbCdEfGhIjKlMnOpQrStUv')$q$, '22023', 'single-use link secret is never stored');
  raise notice 'PASS: onboarding draft has no recipient and refuses to store the link secret';
end $$;

-- Permissions per source.
select pg_temp.act_as('c5f00000-0000-4000-8000-000000000022', 'c5f00000-0000-4000-8000-000000000001');
do $$ declare v_vis integer; begin
  select count(*) into v_vis from public.whatsapp_drafts;
  if v_vis = 0 or exists (select 1 from public.whatsapp_drafts where source_type <> 'invoice') then raise exception 'FAIL finance-only user sees non-invoice drafts (% rows)', v_vis; end if;
  perform pg_temp.expect($q$select app.create_whatsapp_draft('followup', 'c5f00000-0000-4000-8000-0000000000a1', 'x')$q$, '42501', 'finance-only cannot create follow-up drafts');
  perform pg_temp.expect($q$select app.create_whatsapp_draft('onboarding', 'c5f00000-0000-4000-8000-0000000000c1', 'x')$q$, '42501', 'finance-only cannot create onboarding drafts');
  perform pg_temp.expect($q$select app.set_whatsapp_opt_out('c5f00000-0000-4000-8000-0000000000a1', true)$q$, '42501', 'only customer.manage can change opt-out');
  perform pg_temp.expect($q$select app.set_whatsapp_draft_status((select id from public.whatsapp_drafts limit 1), 'draft')$q$, '22023', 'status rules apply to visible drafts (marked_sent is terminal)');
  perform pg_temp.expect($q$select app.set_whatsapp_draft_status(null, 'opened')$q$, '22023', 'null draft id rejected');
  raise notice 'PASS: finance-only role: invoice drafts only';
end $$;
select pg_temp.act_as('c5f00000-0000-4000-8000-000000000023', 'c5f00000-0000-4000-8000-000000000001');
do $$ begin
  if exists (select 1 from public.whatsapp_drafts where source_type <> 'followup') or not exists (select 1 from public.whatsapp_drafts where source_type = 'followup') then
    raise exception 'FAIL crm reader visibility'; end if;
  perform pg_temp.expect($q$select app.create_whatsapp_draft('invoice', 'c5f00000-0000-4000-8000-0000000000d1', 'x')$q$, '42501', 'crm reader cannot create invoice drafts');
  if app.set_whatsapp_draft_status((select id from public.whatsapp_drafts where source_type = 'followup' and status = 'draft' limit 1), 'opened') <> 'opened' then
    raise exception 'FAIL crm user could not open a follow-up draft'; end if;
  perform pg_temp.expect($q$select app.set_whatsapp_draft_status('c5f00000-0000-4000-8000-0000000000d9', 'opened')$q$, 'P0002', 'a draft this role cannot see (or that does not exist) is not found');
  perform pg_temp.expect($q$update public.whatsapp_drafts set status = 'marked_sent'$q$, '42501', 'direct DML denied');
  perform pg_temp.expect($q$insert into public.whatsapp_drafts(organization_id, source_type, source_id, message_text) values ('c5f00000-0000-4000-8000-000000000001','invoice','c5f00000-0000-4000-8000-0000000000d1','x')$q$, '42501', 'direct insert denied');
  raise notice 'PASS: crm reader: follow-up drafts only';
end $$;

-- Tenant isolation.
select pg_temp.act_as('c5f00000-0000-4000-8000-000000000024', 'c5f00000-0000-4000-8000-000000000002');
do $$ declare r jsonb; begin
  if (select count(*) from public.whatsapp_drafts) <> 0 then raise exception 'FAIL org B sees org A drafts'; end if;
  perform pg_temp.expect($q$select app.create_whatsapp_draft('invoice', 'c5f00000-0000-4000-8000-0000000000d1', 'x')$q$, 'P0002', 'cannot draft for another tenant''s invoice');
  perform pg_temp.expect($q$select app.create_whatsapp_draft('followup', 'c5f00000-0000-4000-8000-0000000000a1', 'x')$q$, 'P0002', 'cannot draft for another tenant''s customer');
  perform pg_temp.expect($q$select app.set_whatsapp_draft_status('c5f00000-0000-4000-8000-0000000000f1', 'canceled')$q$, 'P0002', 'cannot change another tenant''s draft');
  perform pg_temp.expect($q$select app.set_whatsapp_opt_out('c5f00000-0000-4000-8000-0000000000a1', true)$q$, 'P0002', 'cannot opt out another tenant''s customer');
  r := app.create_whatsapp_draft('invoice', 'c5f00000-0000-4000-8000-0000000000d4', 'Halo B');
  if (r ->> 'created')::boolean is not true then raise exception 'FAIL org B own draft'; end if;
  raise notice 'PASS: tenant isolation';
end $$;
select pg_temp.act_as('c5f00000-0000-4000-8000-000000000024', 'c5f00000-0000-4000-8000-000000000001');
do $$ begin
  perform pg_temp.expect($q$select app.create_whatsapp_draft('invoice', 'c5f00000-0000-4000-8000-0000000000d1', 'x')$q$, '42501', 'forged active organization refused');
end $$;

-- Audit entries and grants.
reset role;
do $$ begin
  if (select count(*) from app.audit_log where entity_table = 'whatsapp_drafts' and organization_id = 'c5f00000-0000-4000-8000-000000000001' and action = 'INSERT') < 4
     or (select count(*) from app.audit_log where entity_table = 'whatsapp_drafts' and action = 'UPDATE'
          and diff #>> '{new,status}' = 'marked_sent' and diff #>> '{old,status}' = 'opened') < 1
     or (select count(*) from app.audit_log where entity_table = 'whatsapp_contact_preferences' and organization_id = 'c5f00000-0000-4000-8000-000000000001') < 3 then
    raise exception 'FAIL status changes / opt-outs are not audited'; end if;
  if not exists (select 1 from app.audit_log where entity_table = 'whatsapp_drafts' and diff #>> '{new,status_changed_by}' = 'c5f00000-0000-4000-8000-000000000021') then
    raise exception 'FAIL audit does not carry the acting user'; end if;
  if has_function_privilege('anon', 'app.create_whatsapp_draft(text,uuid,text)', 'execute') or has_function_privilege('public', 'app.set_whatsapp_draft_status(uuid,text,text)', 'execute')
     or has_function_privilege('anon', 'app.set_whatsapp_opt_out(uuid,boolean)', 'execute') or has_function_privilege('authenticated', 'app.whatsapp_normalize_phone(text)', 'execute')
     or has_table_privilege('authenticated', 'public.whatsapp_drafts', 'update') or has_table_privilege('anon', 'public.whatsapp_drafts', 'select') then
    raise exception 'FAIL grants'; end if;
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'app'
              and p.proname in ('create_whatsapp_draft','set_whatsapp_draft_status','set_whatsapp_opt_out','whatsapp_source_permitted','tg_write_audit_pk')
              and (not p.prosecdef or p.proconfig is null or not ('search_path=""' = any (p.proconfig)))) then
    raise exception 'FAIL definer search_path'; end if;
  raise notice 'PASS: audit entries (inserts, status changes with actor, opt-outs) and grants';
end $$;
rollback;
