-- =====================================================================
-- Sections 27-30 backend integration test (consolidated from
-- .holdback/smoke*.sql fragments produced during draft development).
--
-- Prerequisites (documented, not assumed):
--   - The full baseline migration lineage (20260721000100 .. 20260924140000)
--     PLUS the four sections-27-30 migrations (20260927100000 ..
--     20260930100000) already applied to the target database.
--   - Run as a superuser (or any role that can `set role authenticated` and
--     insert fixture rows bypassing RLS) against a disposable database —
--     this test creates and tears down its OWN fixtures under a dedicated
--     test organization, so it does not depend on and does not mutate the
--     homepaw_demo.sql seed data.
--   - Postgres 15+ (uses `pg_advisory_xact_lock`, already required by the
--     migrations themselves).
--
-- Run (from repo root, against the isolated dev stack or a throwaway DB):
--   docker exec -i <db-container> psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 -f supabase/tests/S27-S30/test_backend.sql
--
-- The whole file runs inside ONE transaction and ROLLS BACK at the end
-- (see the final `rollback;`), so it never leaves fixture data behind and
-- can be re-run from the same baseline as many times as needed. A failing
-- assertion raises an exception, aborts the transaction, and ON_ERROR_STOP
-- makes psql exit non-zero — there is no "skip a failing prefix" path.
-- =====================================================================
\set ON_ERROR_STOP on
begin;

-- Test-local override of auth.uid(): the real Supabase platform provides a
-- working auth.uid() that resolves the JWT's 'sub' claim (never checked into
-- this repo's migrations — it ships with the platform). The bare-Postgres
-- gate harness's own stub (integration/gate_bootstrap_extensions.sql)
-- deliberately hard-codes it to NULL, which is fine for the EXISTING gate
-- tests (they never feed an actor column into a NOT-NULL/CHECK constraint)
-- but trips this suite's chk_visit_manual_billing_undo the first time an
-- RPC's auth.uid()-sourced actor column actually has to be non-null.
-- CREATE OR REPLACE FUNCTION is transactional DDL, so this override is
-- rolled back with everything else at the bottom of this file — it never
-- persists, and it is harmless on the real Supabase stack (temporarily
-- shadows the platform's own definition for the lifetime of this
-- transaction, restored automatically on rollback).
create or replace function auth.uid() returns uuid language sql stable as $$
  select (nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'sub')::uuid
$$;

create or replace function pg_temp.ok(cond boolean, label text) returns void language plpgsql as $$
begin if cond then raise notice 'PASS: %', label; else raise exception 'FAIL: %', label; end if; end $$;
create or replace function pg_temp.act_as(u uuid, o uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', u, 'active_org_id', o)::text, true);
  set local role authenticated;
end $$;
create or replace function pg_temp.as_superuser() returns void language plpgsql as $$
begin reset role; perform set_config('request.jwt.claims','{}',true); end $$;

-- =====================================================================
-- FIXTURES — dedicated test organization, isolated from any seed data.
-- =====================================================================
do $$
declare
  v_org       constant uuid := 'aa000000-0000-4000-8000-000000000001';
  v_branch    constant uuid := 'aa000000-0000-4000-8000-000000000002';
  v_owner_u   constant uuid := 'aa000000-0000-4000-8000-000000000010';
  v_groomer_u constant uuid := 'aa000000-0000-4000-8000-000000000011';
  v_owner_role    constant uuid := 'aa000000-0000-4000-8000-000000000020';
  v_groomer_role  constant uuid := 'aa000000-0000-4000-8000-000000000021';
  v_owner_mem     constant uuid := 'aa000000-0000-4000-8000-000000000030';
  v_groomer_mem   constant uuid := 'aa000000-0000-4000-8000-000000000031';
  v_groomer_res   constant uuid := 'aa000000-0000-4000-8000-000000000040';
  v_customer1 constant uuid := 'aa000000-0000-4000-8000-000000000050';
  v_customer2 constant uuid := 'aa000000-0000-4000-8000-000000000051';
  v_pet1      constant uuid := 'aa000000-0000-4000-8000-000000000060';
  v_service   constant uuid := 'aa000000-0000-4000-8000-000000000070';
  v_booking_completed constant uuid := 'aa000000-0000-4000-8000-000000000080';
  v_booking_confirmed  constant uuid := 'aa000000-0000-4000-8000-000000000081';
  v_gjp       constant uuid := 'aa000000-0000-4000-8000-000000000090';
  v_invoice   constant uuid := 'aa000000-0000-4000-8000-0000000000a0';
  v_package   constant uuid := 'aa000000-0000-4000-8000-0000000000b0';
begin
  insert into public.organizations (id,name,slug,status,vertical,settings) values
    (v_org,'S2730 Test Org','s2730-test-org','active','grooming','{"currency":"IDR"}');
  insert into public.branches (id,organization_id,name,is_default,status,timezone) values
    (v_branch,v_org,'Main','true','active','Asia/Jakarta');
  insert into public.subscriptions (organization_id,status) values (v_org,'active');
  insert into public.organization_modules (organization_id,module_id,enabled)
    select v_org, m.id, true from public.modules m;

  insert into auth.users (id) values (v_owner_u),(v_groomer_u) on conflict (id) do nothing;
  insert into public.users (id,full_name,email,status) values
    (v_owner_u,'Test Owner','owner@s2730.test','active'),
    (v_groomer_u,'Test Groomer','groomer@s2730.test','active')
  on conflict (id) do update set full_name = excluded.full_name;

  -- Owner role: the ONLY real "new org/role provisioning" pattern this
  -- codebase has today (supabase/seeds/homepaw_demo.sql:31-32) — grant every
  -- CURRENT permission. This proves finding 7's "new organizations are
  -- unaffected" claim independently of the mutable demo seed.
  insert into public.roles (id,organization_id,name,is_system) values (v_owner_role,v_org,'Owner',true);
  insert into public.role_permissions (organization_id,role_id,permission_id)
    select v_org, v_owner_role, p.id from public.permissions p;

  -- Groomer role: narrow, hand-picked permission set, created AFTER this
  -- migration exists — proves the new permissions do NOT leak into a
  -- deliberately-narrow role (finding 7's "without broadening
  -- groomer/receptionist access").
  insert into public.roles (id,organization_id,name,is_system) values (v_groomer_role,v_org,'Groomer',false);
  insert into public.role_permissions (organization_id,role_id,permission_id)
    select v_org, v_groomer_role, p.id from public.permissions p
    where p.key in ('booking.read','booking.create','booking.update','customer.read');

  insert into public.memberships (id,organization_id,user_id,role_id,status) values
    (v_owner_mem,v_org,v_owner_u,v_owner_role,'active'),
    (v_groomer_mem,v_org,v_groomer_u,v_groomer_role,'active');
  insert into public.membership_branch_access (organization_id,membership_id,branch_id) values
    (v_org,v_owner_mem,v_branch),(v_org,v_groomer_mem,v_branch);

  insert into public.resources (id,organization_id,branch_id,membership_id,kind,name,status) values
    (v_groomer_res,v_org,v_branch,v_groomer_mem,'staff','Test Groomer','active');

  insert into public.customers (id,organization_id,display_name,phone) values
    (v_customer1,v_org,'Customer One','081200000001'),
    (v_customer2,v_org,'Customer Two','081200000002');
  insert into public.pets (id,organization_id,customer_id,name) values (v_pet1,v_org,v_customer1,'Bono');
  insert into public.service_catalog (id,organization_id,name,base_price,currency,duration_minutes,is_active) values
    (v_service,v_org,'Bath','150000','IDR',60,true);
  insert into public.packages (id,organization_id,name,total_sessions,price,currency) values
    (v_package,v_org,'Bath x3',3,'400000','IDR');

  insert into public.bookings (id,organization_id,branch_id,customer_id,booking_type,status,fulfillment_mode,starts_at,ends_at) values
    (v_booking_completed,v_org,v_branch,v_customer1,'grooming','completed','in_store',now()-interval '1 day',now()-interval '1 day'+interval '1 hour'),
    (v_booking_confirmed,v_org,v_branch,v_customer1,'grooming','confirmed','in_store',now()+interval '1 day',now()+interval '1 day'+interval '1 hour');
  insert into public.grooming_jobs (booking_id,organization_id) values (v_booking_completed,v_org);
  insert into public.grooming_job_pets (id,organization_id,grooming_job_id,pet_id,assigned_resource_id,status) values
    (v_gjp,v_org,v_booking_completed,v_pet1,v_groomer_res,'complete');

  insert into public.orders (id,organization_id,branch_id,customer_id,status,currency,subtotal,total) values
    ('aa000000-0000-4000-8000-0000000000c0',v_org,v_branch,v_customer1,'confirmed','IDR',150000,150000);
  insert into public.invoices (id,organization_id,branch_id,customer_id,order_id,invoice_number,status,currency,subtotal,total,issued_at) values
    (v_invoice,v_org,v_branch,v_customer1,'aa000000-0000-4000-8000-0000000000c0','TEST-INV-001','issued','IDR',150000,150000,now());
  insert into public.invoice_lines (organization_id,invoice_id,item_type,name_snapshot,quantity,unit_price,line_total) values
    (v_org,v_invoice,'service','Bath',1,150000,150000);
end $$;

-- =====================================================================
-- SECTION 30 — visit register
-- =====================================================================
do $$ begin perform pg_temp.act_as('aa000000-0000-4000-8000-000000000010','aa000000-0000-4000-8000-000000000001'); end $$;
do $$
declare v_visit record;
begin
  select * into v_visit from app.create_manual_visit(
    'aa000000-0000-4000-8000-000000000002','aa000000-0000-4000-8000-000000000050',null,
    'in_store', now() - interval '2 days', 'Walk-in nail trim', 'paid cash');
  perform pg_temp.ok(v_visit.id is not null, 'S30: create_manual_visit inserts a row');

  begin
    perform app.create_manual_visit('aa000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000000',null,'in_store',now(),'x',null);
    perform pg_temp.ok(false, 'S30: create_manual_visit should reject unknown customer');
  exception when others then
    perform pg_temp.ok(sqlerrm ilike '%customer_not_found%', 'S30: create_manual_visit rejects unknown customer');
  end;

  perform app.mark_visit_manually_billed('manual_visit', v_visit.id, 50000, 'cash on the spot');
  begin
    perform app.create_invoice_from_manual_visit(v_visit.id, now(), null, 50000, null, gen_random_uuid());
    perform pg_temp.ok(false, 'S30: create_invoice_from_manual_visit should block while manual billing active');
  exception when others then
    perform pg_temp.ok(sqlerrm ilike '%visit_has_active_manual_billing%', 'S30: create_invoice_from_manual_visit blocked by active manual billing');
  end;

  begin
    perform app.mark_visit_manually_billed('manual_visit', v_visit.id, 10000, 'again');
    perform pg_temp.ok(false, 'S30: double manual billing should be rejected');
  exception when others then
    perform pg_temp.ok(sqlerrm ilike '%already_manually_billed%', 'S30: second manual billing on same visit rejected');
  end;

  perform app.undo_manual_billing((select id from public.visit_manual_billing where source_type='manual_visit' and source_id=v_visit.id and undone_at is null), 'redo as invoice');
  perform app.delete_manual_visit(v_visit.id);
  perform pg_temp.ok((select deleted_at is not null from public.manual_visits where id = v_visit.id), 'S30: manual visit soft-deleted after billing undone');

  -- idempotent invoice-from-visit: same request_key returns the same row
  declare v_visit2 record; v_inv1 record; v_inv2 record; v_key uuid := gen_random_uuid();
  begin
    select * into v_visit2 from app.create_manual_visit('aa000000-0000-4000-8000-000000000002','aa000000-0000-4000-8000-000000000050',null,'home',now(),'Home visit','');
    select * into v_inv1 from app.create_invoice_from_manual_visit(v_visit2.id, now(), null, 75000, null, v_key);
    select * into v_inv2 from app.create_invoice_from_manual_visit(v_visit2.id, now(), null, 75000, null, v_key);
    perform pg_temp.ok(v_inv1.id = v_inv2.id, 'S30: create_invoice_from_manual_visit is idempotent on request_key');
  end;
end $$;

do $$
begin
  begin
    perform app.mark_visit_manually_billed('booking', 'aa000000-0000-4000-8000-000000000081', 50000, 'test');
    perform pg_temp.ok(false, 'S30: manual billing on a non-completed booking should be rejected');
  exception when others then
    perform pg_temp.ok(sqlerrm ilike '%booking_not_completed%', 'S30: manual billing rejects non-completed booking');
  end;
  perform app.mark_visit_manually_billed('booking', 'aa000000-0000-4000-8000-000000000080', 150000, 'paid by hand');
  perform pg_temp.ok((select count(*) from public.visit_manual_billing where source_type='booking' and source_id='aa000000-0000-4000-8000-000000000080' and undone_at is null) = 1,
    'S30: manual billing recorded for completed booking with no active order');
end $$;

-- =====================================================================
-- SECTION 29 — payment control workflow
-- =====================================================================
do $$
declare v_pay record; v_proof uuid; v_key uuid := gen_random_uuid();
begin
  -- proof attachment, properly linked to the invoice (the fixed linkage check)
  insert into public.attachments (id, organization_id, storage_bucket, storage_path, filename, mime_type, uploaded_by)
  values (gen_random_uuid(), 'aa000000-0000-4000-8000-000000000001', 'attachments', 'aa000000-0000-4000-8000-000000000001/proof.jpg', 'proof.jpg', 'image/jpeg', 'aa000000-0000-4000-8000-000000000010')
  returning id into v_proof;
  insert into public.attachment_links (organization_id, attachment_id, subject_type, subject_id)
  values ('aa000000-0000-4000-8000-000000000001', v_proof, 'invoice', 'aa000000-0000-4000-8000-0000000000a0');

  -- bank_transfer WITHOUT proof must be rejected (finding 3)
  begin
    perform app.record_payment('aa000000-0000-4000-8000-0000000000a0','bank_transfer',150000,'TRX-X',null,gen_random_uuid());
    perform pg_temp.ok(false, 'S29: bank_transfer payment without proof should be rejected');
  exception when others then
    perform pg_temp.ok(sqlerrm ilike '%proof_required_for_bank_transfer%', 'S29: bank_transfer without proof rejected');
  end;

  -- an unrelated attachment (not linked to this invoice) must NOT work as proof (finding 3)
  declare v_unlinked uuid;
  begin
    insert into public.attachments (id, organization_id, storage_bucket, storage_path, filename, mime_type, uploaded_by)
    values (gen_random_uuid(), 'aa000000-0000-4000-8000-000000000001', 'attachments', 'aa000000-0000-4000-8000-000000000001/unrelated.jpg', 'unrelated.jpg', 'image/jpeg', 'aa000000-0000-4000-8000-000000000010')
    returning id into v_unlinked;
    begin
      perform app.record_payment('aa000000-0000-4000-8000-0000000000a0','bank_transfer',150000,'TRX-X',v_unlinked,gen_random_uuid());
      perform pg_temp.ok(false, 'S29: unlinked attachment must not count as proof');
    exception when others then
      perform pg_temp.ok(sqlerrm ilike '%proof_attachment_not_linked_to_invoice%', 'S29: unlinked attachment rejected as proof');
    end;
  end;

  select * into v_pay from app.record_payment('aa000000-0000-4000-8000-0000000000a0','bank_transfer',150000,'TRX-1',v_proof,v_key);
  perform pg_temp.ok(v_pay.payment_stage = 'awaiting_screenshot', 'S29: bank_transfer payment starts awaiting_screenshot');
  perform pg_temp.ok(v_pay.status = 'succeeded', 'S29: payment status unaffected by review stage');
  perform pg_temp.ok((select status from public.invoices where id='aa000000-0000-4000-8000-0000000000a0') = 'paid', 'S29: invoice marked paid once succeeded payments cover total');
  perform pg_temp.ok((select count(*) from public.attachment_links where attachment_id=v_proof and subject_type='payment' and subject_id=v_pay.id)=1, 'S29: proof attachment also linked to the payment record');

  perform pg_temp.ok((select count(*) from app.record_payment('aa000000-0000-4000-8000-0000000000a0','bank_transfer',150000,'TRX-1',v_proof,v_key))=1, 'S29: retry with same request_key returns one row');
  perform pg_temp.ok((select count(*) from public.payments where request_key=v_key)=1, 'S29: retry did not insert a duplicate payment');

  begin
    perform app.record_payment('aa000000-0000-4000-8000-0000000000a0','bank_transfer',999,'TRX-1',v_proof,v_key);
    perform pg_temp.ok(false, 'S29: changed-input retry should be rejected');
  exception when others then
    perform pg_temp.ok(sqlerrm ilike '%request_key_reused_with_different_inputs%', 'S29: changed-input retry rejected');
  end;

  begin
    perform app.validate_payment_bank_account(v_pay.id);
    perform pg_temp.ok(false, 'S29: cannot bank-validate before screenshot confirmation');
  exception when others then
    perform pg_temp.ok(sqlerrm ilike '%invalid_stage_transition%', 'S29: bank validation blocked before screenshot confirmation');
  end;

  perform app.confirm_payment_screenshot(v_pay.id);
  perform pg_temp.ok((select payment_stage from public.payments where id=v_pay.id)='screenshot_confirmed', 'S29: screenshot confirmation advances stage');
  perform app.validate_payment_bank_account(v_pay.id);
  perform pg_temp.ok((select payment_stage from public.payments where id=v_pay.id)='bank_validated', 'S29: bank validation reaches terminal stage');

  begin
    update public.payments set external_ref='tampered' where id=v_pay.id;
    perform pg_temp.ok(false, 'S29: direct UPDATE on a validated payment should be blocked');
  exception when others then
    -- Blocked at the privilege layer now (finding 4's revoke), which is a
    -- STRONGER guarantee than reaching the freeze trigger at all.
    perform pg_temp.ok(sqlerrm ilike '%permission denied%', 'S29: validated payment is immutable against direct UPDATE (blocked before the trigger even runs)');
  end;

  -- Prove the freeze trigger ALSO independently blocks this (defense in
  -- depth), by attempting the same edit as the function owner (bypasses the
  -- privilege revoke, still must hit the trigger).
  perform pg_temp.as_superuser();
  begin
    update public.payments set external_ref='tampered' where id=v_pay.id;
    perform pg_temp.ok(false, 'S29: freeze trigger should independently block editing a validated payment');
  exception when others then
    perform pg_temp.ok(sqlerrm ilike '%locked%', 'S29: freeze trigger independently blocks editing a validated payment even bypassing the privilege revoke');
  end;
  perform pg_temp.act_as('aa000000-0000-4000-8000-000000000010','aa000000-0000-4000-8000-000000000001');

  -- finding 4: direct table INSERT must be impossible even with payment.manage
  begin
    insert into public.payments (organization_id,branch_id,invoice_id,customer_id,method,amount,currency,status)
    values ('aa000000-0000-4000-8000-000000000001','aa000000-0000-4000-8000-000000000002','aa000000-0000-4000-8000-0000000000a0','aa000000-0000-4000-8000-000000000050','cash',1,'IDR','succeeded');
    perform pg_temp.ok(false, 'S29: direct table INSERT into payments should be impossible');
  exception when others then
    perform pg_temp.ok(sqlerrm ilike '%permission denied%', 'S29: direct table INSERT into payments blocked at the privilege layer');
  end;
end $$;

-- finding 6: single-shot overpayment must not fight tg_invoices_freeze
do $$
declare v_order2 uuid := gen_random_uuid(); v_inv2 uuid := gen_random_uuid(); v_pay record;
begin
  insert into public.orders (id,organization_id,branch_id,customer_id,status,currency,subtotal,total)
  values (v_order2,'aa000000-0000-4000-8000-000000000001','aa000000-0000-4000-8000-000000000002','aa000000-0000-4000-8000-000000000050','confirmed','IDR',100000,100000);
  insert into public.invoices (id,organization_id,branch_id,customer_id,order_id,invoice_number,status,currency,subtotal,total,issued_at)
  values (v_inv2,'aa000000-0000-4000-8000-000000000001','aa000000-0000-4000-8000-000000000002','aa000000-0000-4000-8000-000000000050',v_order2,'TEST-INV-002','issued','IDR',100000,100000,now());
  select * into v_pay from app.record_payment(v_inv2,'cash',150000,'CASH-OVER',null,gen_random_uuid());
  perform pg_temp.ok((select status from public.invoices where id=v_inv2)='paid', 'S29: overpayment still marks invoice paid');
  perform pg_temp.ok((select (metadata->>'overpaid_amount')::numeric from public.invoices where id=v_inv2)=50000, 'S29: overpaid_amount recorded without tripping tg_invoices_freeze');
end $$;

-- finding 5: historical stage honesty
do $$ begin perform pg_temp.as_superuser(); end $$;
do $$
declare v_legacy uuid := gen_random_uuid();
begin
  insert into public.payments (id,organization_id,branch_id,customer_id,method,amount,currency,status,paid_at,created_at)
  values (v_legacy,'aa000000-0000-4000-8000-000000000001','aa000000-0000-4000-8000-000000000002','aa000000-0000-4000-8000-000000000050','bank_transfer',100000,'IDR','succeeded',now(),now());
  perform pg_temp.ok((select payment_stage from public.payments where id=v_legacy)='not_applicable',
    'S29: a payment inserted after this migration still defaults to not_applicable unless recorded via record_payment (documents the default; app code never inserts directly any more)');
end $$;

-- package-purchase payment path (finding 4's other direct-insert site)
do $$ begin perform pg_temp.act_as('aa000000-0000-4000-8000-000000000010','aa000000-0000-4000-8000-000000000001'); end $$;
do $$
declare v_pay record;
begin
  select * into v_pay from app.record_package_purchase_payment(
    'aa000000-0000-4000-8000-000000000002','aa000000-0000-4000-8000-000000000050','aa000000-0000-4000-8000-0000000000b0',
    'cash', 400000, 'IDR', gen_random_uuid());
  perform pg_temp.ok(v_pay.payment_stage = 'not_applicable', 'S29: cash package-purchase payment recorded via RPC');
end $$;

-- =====================================================================
-- SECTION 27 — invoice documents (branding / bank accounts / notes)
-- =====================================================================
do $$
declare v_invoice record;
begin
  perform app.upsert_organization_bank_account(null,'BCA','1234567890','Test Org',true,1);
  perform app.upsert_organization_bank_account(null,'BNI','0987654321','Test Org',false,2);
  perform pg_temp.ok((select count(*) from public.organization_bank_accounts where organization_id='aa000000-0000-4000-8000-000000000001' and deleted_at is null)=2, 'S27: two bank accounts stored');
  begin
    perform app.upsert_organization_bank_account(null,'Mandiri','111','X',false,3);
    perform pg_temp.ok(false, 'S27: a third bank account should be rejected');
  exception when others then
    perform pg_temp.ok(sqlerrm ilike '%bank_account_limit_reached%', 'S27: bank account cap of 2 enforced');
  end;

  perform app.update_invoice_document_settings('Tepercaya',null,'Syarat...', 'Lunas {number}','Outstanding {number}','Langganan {number}');
  perform pg_temp.ok((select settings->'documents'->>'tagline' from public.organizations where id='aa000000-0000-4000-8000-000000000001')='Tepercaya', 'S27: branding tagline persisted');

  select * into v_invoice from public.invoices where id='aa000000-0000-4000-8000-0000000000a0';
  perform app.update_invoice_customer_notes(v_invoice.id, v_invoice.revision, 'Bulu sedikit kusut.');
  perform pg_temp.ok(false, 'S27: notes edit on a PAID invoice should be rejected (invoice_locked)');
exception when others then
  perform pg_temp.ok(sqlerrm ilike '%invoice_locked%', 'S27: customer-notes edit correctly rejected once invoice is paid');
end $$;

-- =====================================================================
-- SECTION 28 — grooming evidence (authorization logic, no live Storage here)
-- =====================================================================
do $$
declare v_delete_result record;
begin
  -- unassigned groomer cannot delete evidence for a job they are not assigned to;
  -- build a throwaway attachment linked to the completed booking's job-pet row.
  declare v_att uuid;
  begin
    insert into public.attachments (id, organization_id, storage_bucket, storage_path, filename, mime_type, uploaded_by, metadata)
    values (gen_random_uuid(), 'aa000000-0000-4000-8000-000000000001', 'attachments',
      'aa000000-0000-4000-8000-000000000001/aa000000-0000-4000-8000-000000000080/aa000000-0000-4000-8000-000000000090/x.jpg',
      'x.jpg', 'image/jpeg', 'aa000000-0000-4000-8000-000000000010',
      jsonb_build_object('category','before','grooming_job_pet_id','aa000000-0000-4000-8000-000000000090'))
    returning id into v_att;
    insert into public.attachment_links (organization_id, attachment_id, subject_type, subject_id)
    values ('aa000000-0000-4000-8000-000000000001', v_att, 'booking', 'aa000000-0000-4000-8000-000000000080');

    -- assigned groomer (v_groomer_res membership) CAN delete it
    perform pg_temp.act_as('aa000000-0000-4000-8000-000000000011','aa000000-0000-4000-8000-000000000001');
    select * into v_delete_result from app.delete_grooming_evidence(v_att);
    perform pg_temp.ok(v_delete_result.storage_path is not null, 'S28: assigned groomer can delete their own evidence upload');
  end;

  -- a SECOND, unrelated groomer (not assigned to this job) must be denied
  declare v_att2 uuid; v_other_u uuid := 'aa000000-0000-4000-8000-0000000000e0'; v_other_mem uuid := 'aa000000-0000-4000-8000-0000000000e1'; v_other_res uuid := 'aa000000-0000-4000-8000-0000000000e2';
  begin
    perform pg_temp.as_superuser();
    insert into auth.users (id) values (v_other_u) on conflict (id) do nothing;
    insert into public.users (id,full_name,email,status) values (v_other_u,'Other Groomer','other@s2730.test','active') on conflict (id) do update set full_name=excluded.full_name;
    insert into public.memberships (id,organization_id,user_id,role_id,status) values (v_other_mem,'aa000000-0000-4000-8000-000000000001',v_other_u,'aa000000-0000-4000-8000-000000000021','active');
    insert into public.membership_branch_access (organization_id,membership_id,branch_id) values ('aa000000-0000-4000-8000-000000000001',v_other_mem,'aa000000-0000-4000-8000-000000000002');
    insert into public.resources (id,organization_id,branch_id,membership_id,kind,name,status) values (v_other_res,'aa000000-0000-4000-8000-000000000001','aa000000-0000-4000-8000-000000000002',v_other_mem,'staff','Other Groomer','active');

    insert into public.attachments (id, organization_id, storage_bucket, storage_path, filename, mime_type, uploaded_by, metadata)
    values (gen_random_uuid(), 'aa000000-0000-4000-8000-000000000001', 'attachments',
      'aa000000-0000-4000-8000-000000000001/aa000000-0000-4000-8000-000000000080/aa000000-0000-4000-8000-000000000090/y.jpg',
      'y.jpg', 'image/jpeg', 'aa000000-0000-4000-8000-000000000010',
      jsonb_build_object('category','after','grooming_job_pet_id','aa000000-0000-4000-8000-000000000090'))
    returning id into v_att2;

    perform pg_temp.act_as(v_other_u,'aa000000-0000-4000-8000-000000000001');
    begin
      perform app.delete_grooming_evidence(v_att2);
      perform pg_temp.ok(false, 'S28: unassigned groomer must be denied deleting another job''s evidence');
    exception when others then
      perform pg_temp.ok(sqlerrm ilike '%not_authorized%', 'S28: unassigned groomer denied deleting evidence for a job they are not assigned to');
    end;
  end;
end $$;

-- =====================================================================
-- Finding 7 — permission provisioning: narrow role must NOT gain the new
-- permissions; wildcard-provisioned Owner role DOES have them.
-- =====================================================================
do $$
begin
  perform pg_temp.ok(
    (select bool_and(exists(select 1 from public.role_permissions rp join public.permissions p on p.id=rp.permission_id where rp.role_id='aa000000-0000-4000-8000-000000000020' and p.key=perm))
     from unnest(array['payment.validate','evidence.read_all']) as perm),
    'Finding 7: wildcard-provisioned Owner role (the only real new-org pattern) has both new permissions');
  perform pg_temp.ok(
    not exists(select 1 from public.role_permissions rp join public.permissions p on p.id=rp.permission_id where rp.role_id='aa000000-0000-4000-8000-000000000021' and p.key in ('payment.validate','evidence.read_all')),
    'Finding 7: narrow Groomer role created after this migration does NOT gain payment.validate/evidence.read_all');
end $$;

do $$ begin perform pg_temp.as_superuser(); end $$;
select 'S27-S30 BACKEND TEST SUITE COMPLETE' as result;
rollback;
