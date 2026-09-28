-- S1 real-Storage-HTTP test fixtures. Local QA / isolated dev stack ONLY —
-- reuses the existing HomePaw Demo org (homepaw_demo.sql) and its real
-- Owner (wbudiman1995@gmail.com) and Groomer/Andi (groomer@homepaw.local)
-- accounts, adding only what those seeds do not already cover: a second
-- branch, an unassigned-groomer persona, a branch-restricted
-- evidence.read_all persona (to prove the new branch-scoping fix), and a
-- payment.manage-only persona with no booking.update. Idempotent — safe to
-- rerun after `supabase db reset`.
do $$
declare
  v_org uuid := 'd0000000-0000-4000-8000-000000000001';
  v_branch_a uuid := 'd0000000-0000-4000-8000-000000000010';
  v_branch_b uuid := 'f1000000-0000-4000-8000-000000000001';
  v_sari_resource uuid := 'd0000000-0000-4000-8000-000000000202';

  v_role_evidence_admin_b uuid := 'f1000000-0000-4000-8000-000000000011';
  v_role_finance_only uuid := 'f1000000-0000-4000-8000-000000000012';
  v_role_groomer_unassigned uuid := 'f1000000-0000-4000-8000-000000000013';

  v_user_evidence_admin_b uuid := 'f1000000-0000-4000-8000-000000000021';
  v_user_finance_only uuid := 'f1000000-0000-4000-8000-000000000022';
  v_user_groomer_unassigned uuid := 'f1000000-0000-4000-8000-000000000023';

  v_membership_evidence_admin_b uuid := 'f1000000-0000-4000-8000-000000000031';
  v_membership_finance_only uuid := 'f1000000-0000-4000-8000-000000000032';
  v_membership_groomer_unassigned uuid := 'f1000000-0000-4000-8000-000000000033';

  v_password text := 'operro-local-qa';
begin
  -- Second branch, for the cross-branch denial matrix.
  insert into public.branches (id, organization_id, name, status, timezone, is_default, address, settings)
  values (v_branch_b, v_org, 'HomePaw Branch B (test fixture)', 'active', 'Asia/Jakarta', false, '{"city":"Test"}', '{"fixture":"s1_storage_test"}')
  on conflict (id) do update set status = 'active', deleted_at = null;

  -- Auth users (same direct-insert technique as supabase/seed.sql, which
  -- this local stack already relies on for its own QA logins).
  insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, is_super_admin, created_at, updated_at, confirmation_token, recovery_token, email_change_token_new, email_change)
  values
    ('00000000-0000-0000-0000-000000000000', v_user_evidence_admin_b, 'authenticated', 'authenticated', 'evidence-admin-b@test.local', extensions.crypt(v_password, extensions.gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}', '{"full_name":"Evidence Admin B (fixture)"}', false, now(), now(), '', '', '', ''),
    ('00000000-0000-0000-0000-000000000000', v_user_finance_only, 'authenticated', 'authenticated', 'finance-only@test.local', extensions.crypt(v_password, extensions.gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}', '{"full_name":"Finance Only (fixture)"}', false, now(), now(), '', '', '', ''),
    ('00000000-0000-0000-0000-000000000000', v_user_groomer_unassigned, 'authenticated', 'authenticated', 'groomer-unassigned@test.local', extensions.crypt(v_password, extensions.gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}', '{"full_name":"Unassigned Groomer (fixture)"}', false, now(), now(), '', '', '', '')
  on conflict (id) do nothing;

  insert into auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
  values
    (v_user_evidence_admin_b, v_user_evidence_admin_b, v_user_evidence_admin_b::text, jsonb_build_object('sub', v_user_evidence_admin_b::text, 'email', 'evidence-admin-b@test.local'), 'email', now(), now(), now()),
    (v_user_finance_only, v_user_finance_only, v_user_finance_only::text, jsonb_build_object('sub', v_user_finance_only::text, 'email', 'finance-only@test.local'), 'email', now(), now(), now()),
    (v_user_groomer_unassigned, v_user_groomer_unassigned, v_user_groomer_unassigned::text, jsonb_build_object('sub', v_user_groomer_unassigned::text, 'email', 'groomer-unassigned@test.local'), 'email', now(), now(), now())
  on conflict (provider_id, provider) do nothing;

  -- Roles: narrow, purpose-built, none reusing the Owner's wildcard grant.
  insert into public.roles (id, organization_id, name, description, is_system) values
    (v_role_evidence_admin_b, v_org, 'Evidence Admin (Branch B only, fixture)', 'evidence.read_all but NOT branches.all — proves evidence.read_all is branch-scoped', true),
    (v_role_finance_only, v_org, 'Finance Only (fixture)', 'payment.manage/validate/finance.read, deliberately no booking.update', true),
    (v_role_groomer_unassigned, v_org, 'Groomer (unassigned, fixture)', 'same shape as the real Groomer role, for a resource not assigned to the test booking', true)
  on conflict (id) do update set name = excluded.name, deleted_at = null;

  delete from public.role_permissions where role_id in (v_role_evidence_admin_b, v_role_finance_only, v_role_groomer_unassigned) and organization_id = v_org;
  insert into public.role_permissions (role_id, permission_id, organization_id)
  select v_role_evidence_admin_b, p.id, v_org from public.permissions p where p.key in ('evidence.read_all', 'booking.read')
  union all
  select v_role_finance_only, p.id, v_org from public.permissions p where p.key in ('payment.manage', 'payment.validate', 'finance.read')
  union all
  select v_role_groomer_unassigned, p.id, v_org from public.permissions p where p.key in ('booking.read', 'booking.update', 'booking.complete');

  insert into public.memberships (id, user_id, organization_id, role_id, status) values
    (v_membership_evidence_admin_b, v_user_evidence_admin_b, v_org, v_role_evidence_admin_b, 'active'),
    (v_membership_finance_only, v_user_finance_only, v_org, v_role_finance_only, 'active'),
    (v_membership_groomer_unassigned, v_user_groomer_unassigned, v_org, v_role_groomer_unassigned, 'active')
  on conflict (user_id, organization_id) do update set role_id = excluded.role_id, status = 'active', deleted_at = null;

  -- Branch restriction: evidence-admin-b -> Branch B ONLY (not the branch
  -- the test booking/evidence live in). finance-only and
  -- groomer-unassigned -> Branch A (same branch as the evidence — the
  -- thing being tested for them is capability, not branch).
  insert into public.membership_branch_access (membership_id, branch_id, organization_id) values
    (v_membership_evidence_admin_b, v_branch_b, v_org),
    (v_membership_finance_only, v_branch_a, v_org),
    (v_membership_groomer_unassigned, v_branch_a, v_org)
  on conflict (membership_id, branch_id) do nothing;

  -- Sari (an existing resource with no membership_id — homepaw_demo.sql
  -- leaves her unlinked) becomes the "unassigned groomer" persona's own
  -- resource: a real groomer, real branch, just not assigned to booking 501.
  update public.resources set membership_id = v_membership_groomer_unassigned where id = v_sari_resource and organization_id = v_org;
end $$;

-- =====================================================================
-- Attachment metadata rows for the two test objects the Node script
-- (apps/web/scripts/s1-storage-auth-check.mjs) exercises via real Storage
-- HTTP calls. Inserted here (superuser, bypasses RLS/grants) rather than
-- via the service_role PostgREST client, because service_role lacks USAGE
-- on the `app` schema (fn_uuid_v7() default, audit triggers) — the same
-- privilege boundary the app's own server actions never hit because they
-- always run as `authenticated`, not `service_role`.
-- =====================================================================
do $$
declare
  v_org uuid := 'd0000000-0000-4000-8000-000000000001';
  v_booking uuid := 'd0000000-0000-4000-8000-000000000501';
  v_gjp uuid := 'd0000000-0000-4000-8000-000000000601';
  v_invoice uuid := 'd0000000-0000-4000-8000-000000001102';
  v_evidence_attachment uuid := 'f1000000-0000-4000-8000-000000000041';
  v_proof_attachment uuid := 'f1000000-0000-4000-8000-000000000042';
  v_evidence_path text := 'd0000000-0000-4000-8000-000000000001/d0000000-0000-4000-8000-000000000501/d0000000-0000-4000-8000-000000000601/s1-check-evidence.jpg';
  v_proof_path text := 'd0000000-0000-4000-8000-000000000001/payments/f1000000-0000-4000-8000-0000000000aa.jpg';
begin
  insert into public.attachments (id, organization_id, storage_bucket, storage_path, filename, mime_type, size_bytes, metadata)
  values (v_evidence_attachment, v_org, 'attachments', v_evidence_path, 's1-check-evidence.jpg', 'image/jpeg', 631, jsonb_build_object('category', 'before', 'grooming_job_pet_id', v_gjp))
  on conflict (id) do update set deleted_at = null, metadata = excluded.metadata;
  insert into public.attachment_links (organization_id, attachment_id, subject_type, subject_id)
  values (v_org, v_evidence_attachment, 'booking', v_booking)
  on conflict (attachment_id, subject_type, subject_id) do nothing;

  insert into public.attachments (id, organization_id, storage_bucket, storage_path, filename, mime_type, size_bytes, metadata)
  values (v_proof_attachment, v_org, 'attachments', v_proof_path, 's1-check-proof.jpg', 'image/jpeg', 631, jsonb_build_object('category', 'payment_proof'))
  on conflict (id) do update set deleted_at = null, metadata = excluded.metadata;
  insert into public.attachment_links (organization_id, attachment_id, subject_type, subject_id)
  values (v_org, v_proof_attachment, 'invoice', v_invoice)
  on conflict (attachment_id, subject_type, subject_id) do nothing;

  -- Rerunnable: clear any prior test payment against DEMO-INV-002.
  delete from public.payments where organization_id = v_org and invoice_id = v_invoice;
  update public.invoices set status = 'issued' where organization_id = v_org and id = v_invoice;
end $$;
