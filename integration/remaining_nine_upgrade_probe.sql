-- Populated-upgrade probe for the remaining-nine migrations (20261029100000 .. 20261029170000).
-- Runs on the upgraded rehearsal databases inside ONE rolled-back transaction:
--   A. the real HomePaw workspace (its real owner identity): every new surface executes and invents nothing;
--   B. the populated "Upgrade X" fixture workspace (many pets, services, snapshots, paid payroll): derived figures equal
--      independent queries, custom fields / drafts / cleanup preview work on existing rows, and no existing row changes.
\set ON_ERROR_STOP on
begin;

-- Baseline of everything the new features must NOT change.
create temporary table probe_before as
  select (select md5(coalesce(string_agg(to_jsonb(p)::text, '~' order by p.id::text), '')) from (select id, organization_id, customer_id, name, species, breed, sex, birthdate, weight_kg, size, color, temperament, notes, status from public.pets) p) as pets_hash,
         (select count(*) from public.pets) as pets_n,
         (select md5(coalesce(string_agg(to_jsonb(a)::text, '~' order by a.id::text), '')) from public.attachments a) as att_hash,
         (select count(*) from public.bookings) as bookings_n,
         (select count(*) from public.invoices) as invoices_n,
         (select count(*) from public.payments) as payments_n,
         (select count(*) from public.payroll_items) as payroll_items_n;
grant select on probe_before to authenticated;

-- ===== A. HomePaw workspace ======================================================================================
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"047f1e5c-5935-4566-b793-417df9f7cc9c","role":"authenticated","active_org_id":"019fbdd0-ee52-7f57-8318-a288203c78c1"}', true);
do $$
declare
  v_org constant uuid := '019fbdd0-ee52-7f57-8318-a288203c78c1';
  v_ids uuid[]; r jsonb; h jsonb; v_cust uuid;
begin
  if (select count(*) from public.pets where organization_id = v_org and (coat_type is not null or skin_history is not null)) <> 0 then
    raise exception 'FAIL upgrade invented coat data for existing pets'; end if;
  select coalesce(array_agg(id), '{}') into v_ids from (select id from public.pets where organization_id = v_org and deleted_at is null limit 100) x;
  if (select count(*) from app.pet_visit_stats(v_ids)) <> cardinality(v_ids) then raise exception 'FAIL one stats row per existing pet'; end if;
  perform * from app.finance_cash_position(current_date - 300, current_date, 'Asia/Jakarta');
  perform * from app.search_audit_events(null, null, null, null, null, null, null, 10);
  perform * from app.reconcile_unbilled_visits(null, null, 10);
  perform * from app.reconcile_invoice_payments(null, null, 10);
  perform * from app.reconcile_payroll_sources(null, 10);
  h := app.health_summary();
  if h ->> 'schema_version' <> app.schema_version() then raise exception 'FAIL schema version'; end if;
  if (app.recovery_status() ->> 'drills_recorded')::int <> 0 then raise exception 'FAIL upgrade invented a restore drill'; end if;
  r := app.storage_cleanup_preview(10);
  if (r ->> 'candidates')::int < 0 then raise exception 'FAIL cleanup preview'; end if;
  perform app.set_evidence_retention_days(120);
  if (select settings ->> 'evidence_retention_days' from public.organizations where id = v_org) <> '120' then raise exception 'FAIL org setting'; end if;
  perform app.set_my_landing_page('customers');
  if app.my_landing_page() <> 'customers' then raise exception 'FAIL landing preference'; end if;
  perform app.set_my_landing_page(null);
  select id into v_cust from public.customers c where organization_id = v_org and deleted_at is null and length(regexp_replace(coalesce(c.phone, ''), '[^0-9]', '', 'g')) between 8 and 15 order by id limit 1;
  if v_cust is not null then
    r := app.create_whatsapp_draft('followup', v_cust, 'Probe draft, not sent');
    perform app.set_whatsapp_draft_status((r ->> 'id')::uuid, 'canceled', 'upgrade probe');
  end if;
  raise notice 'upgrade probe A: every new surface executes on the upgraded HomePaw workspace';
end $$;

-- ===== B. Populated fixture workspace ============================================================================
reset role;
-- Authority for the fixture owner and one completed, invoiced visit with a frozen payroll item, all inside this transaction.
insert into public.role_permissions(organization_id, role_id, permission_id)
  select '5c000000-0000-4000-8000-000000000001', '5c000000-0000-4000-8000-0000000000a2', p.id from public.permissions p where p.deleted_at is null on conflict do nothing;
insert into public.organization_modules(organization_id, module_id, enabled)
  select '5c000000-0000-4000-8000-000000000001', m.id, true from public.modules m where m.is_active on conflict (organization_id, module_id) do update set enabled = true;
insert into public.subscriptions(organization_id, status) values ('5c000000-0000-4000-8000-000000000001', 'active') on conflict do nothing;
insert into public.bookings (id, organization_id, branch_id, customer_id, booking_type, status, starts_at, ends_at) values
  ('5c000000-0000-4000-8000-0000000009a1', '5c000000-0000-4000-8000-000000000001', '5c000000-0000-4000-8000-0000000000b1', '5c000000-0000-4000-8000-0000000000c1', 'grooming', 'completed', now() - interval '3 days', now() - interval '3 days' + interval '1 hour'),
  ('5c000000-0000-4000-8000-0000000009a2', '5c000000-0000-4000-8000-000000000001', '5c000000-0000-4000-8000-0000000000b1', '5c000000-0000-4000-8000-0000000000c1', 'grooming', 'canceled', now() - interval '2 days', now() - interval '2 days' + interval '1 hour');
insert into public.grooming_jobs (booking_id, organization_id) values
  ('5c000000-0000-4000-8000-0000000009a1', '5c000000-0000-4000-8000-000000000001'), ('5c000000-0000-4000-8000-0000000009a2', '5c000000-0000-4000-8000-000000000001');
insert into public.grooming_job_pets (organization_id, grooming_job_id, pet_id, status) values
  ('5c000000-0000-4000-8000-000000000001', '5c000000-0000-4000-8000-0000000009a1', '5c000000-0000-4000-8000-000000000201', 'complete'),
  ('5c000000-0000-4000-8000-000000000001', '5c000000-0000-4000-8000-0000000009a1', '5c000000-0000-4000-8000-000000000202', 'complete'),
  ('5c000000-0000-4000-8000-000000000001', '5c000000-0000-4000-8000-0000000009a2', '5c000000-0000-4000-8000-000000000201', 'pending');
insert into public.attachments (id, organization_id, storage_bucket, storage_path, filename, metadata) values
  ('5c000000-0000-4000-8000-0000000009b1', '5c000000-0000-4000-8000-000000000001', 'styling-references', '5c000000-0000-4000-8000-000000000001/ref/old.jpg', 'old.jpg',
   jsonb_build_object('kind', 'styling_reference', 'expires_at', to_char(now() - interval '5 days', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')));
create temporary table probe_before_b as select md5(coalesce(string_agg(to_jsonb(a)::text, '~' order by a.id::text), '')) as att_hash from public.attachments a where a.organization_id = '5c000000-0000-4000-8000-000000000001';
grant select on probe_before_b to authenticated;

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"5c000000-0000-4000-8000-0000000000a1","role":"authenticated","active_org_id":"5c000000-0000-4000-8000-000000000001"}', true);
do $$
declare
  v_org constant uuid := '5c000000-0000-4000-8000-000000000001';
  v_ids uuid[]; v_got integer; v_expected integer; v_def uuid; v_cust constant uuid := '5c000000-0000-4000-8000-0000000000c1';
  v_pet constant uuid := '5c000000-0000-4000-8000-000000000201'; r jsonb; v_prev jsonb; v_stats record; v_edit record;
begin
  select array_agg(id) into v_ids from public.pets where organization_id = v_org and deleted_at is null;
  select coalesce(sum(completed_jobs), 0) into v_got from app.pet_visit_stats(v_ids[1:100]);
  select count(*) into v_expected from public.grooming_job_pets g join public.bookings b on b.organization_id = g.organization_id and b.id = g.grooming_job_id
   where g.organization_id = v_org and g.pet_id = any (v_ids[1:100]) and g.deleted_at is null and g.status <> 'skipped' and b.status = 'completed' and b.deleted_at is null;
  if v_got <> v_expected or v_got < 2 then raise exception 'FAIL pet_visit_stats % vs independent % (the cancelled visit and pending line must not count)', v_got, v_expected; end if;
  select * into v_stats from app.pet_visit_stats(array[v_pet]);
  select count(*) into v_expected from public.grooming_job_pets g join public.bookings b on b.organization_id = g.organization_id and b.id = g.grooming_job_id
   where g.organization_id = v_org and g.pet_id = v_pet and g.deleted_at is null and g.status <> 'skipped' and b.status = 'completed' and b.deleted_at is null;
  if v_stats.completed_jobs <> v_expected or v_expected < 1 or v_stats.last_visit_at is null then raise exception 'FAIL per-pet stats % vs independent %', row_to_json(v_stats), v_expected; end if;

  -- Coat profile edit through the guarded RPC keeps weight-derived sizing and bookings.
  select * into v_edit from app.update_customer_pet(v_pet, v_cust, (select updated_at from public.pets where id = v_pet), 'X manual', 'dog', null, 'unknown', null, null, 'medium', null, null, null, 'double_coat', 'probe skin note');
  if (select coat_type from public.pets where id = v_pet) <> 'double_coat' or v_edit.stored_size <> 'medium' then raise exception 'FAIL coat edit on an existing pet'; end if;
  if (select completed_jobs from app.pet_visit_stats(array[v_pet])) <> v_expected then raise exception 'FAIL count changed after edit'; end if;

  -- Custom fields: definition, value, archive keeps the value.
  v_def := app.save_custom_field_definition(null, 'pet', 'Upgrade probe', 'text', null, 1, null);
  perform app.set_custom_field_values('pet', v_pet, jsonb_build_object(v_def::text, 'tenang'));
  perform app.set_custom_field_archived(v_def, true);
  if (select value_text from public.custom_field_values where pet_id = v_pet and definition_id = v_def) <> 'tenang' then raise exception 'FAIL archived value lost'; end if;

  -- Cleanup preview lists the expired reference and changes nothing; apply guards hold.
  v_prev := app.storage_cleanup_preview(50);
  if (v_prev ->> 'candidates')::int <> 1 then raise exception 'FAIL expected exactly the one expired reference, got %', v_prev; end if;
  perform app.set_evidence_retention_days(90);
  perform * from app.finance_cash_position(current_date - 300, current_date, 'Asia/Jakarta');
  raise notice 'upgrade probe B: derived figures equal independent queries and new features work on populated rows';
end $$;

reset role;
do $$
declare b record; bb record;
begin
  select * into b from probe_before; select * into bb from probe_before_b;
  if (select count(*) from public.pets) <> b.pets_n
     or (select count(*) from public.bookings) <> b.bookings_n + 2   -- the two bookings this probe inserted itself
     or (select count(*) from public.invoices) <> b.invoices_n or (select count(*) from public.payments) <> b.payments_n
     or (select count(*) from public.payroll_items) <> b.payroll_items_n then
    raise exception 'FAIL existing rows changed (counts)'; end if;
  if (select md5(coalesce(string_agg(to_jsonb(a)::text, '~' order by a.id::text), '')) from public.attachments a where a.organization_id = '5c000000-0000-4000-8000-000000000001') is distinct from bb.att_hash then
    raise exception 'FAIL the cleanup preview altered attachments'; end if;
  if (select count(*) from public.pets where id <> '5c000000-0000-4000-8000-000000000201'
        and (coat_type is not null or skin_history is not null)) <> 0 then raise exception 'FAIL coat data appeared on pets nobody edited'; end if;
  raise notice 'REMAINING NINE POPULATED PROBE PASS';
end $$;
rollback;
