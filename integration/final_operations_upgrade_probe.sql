-- Populated-upgrade probe for the final parity operations migrations 20261101100000 .. 20261101160000.
-- Runs on the upgraded rehearsal database (real HomePaw demo rows) inside rolled-back transactions, as the real HomePaw owner identity:
-- every new surface must work on populated data, agree with independent queries, and change nothing that persists.
\set ON_ERROR_STOP on
create temporary table ops_before as
  select (select count(*) from public.customers) as customers_n, (select count(*) from public.bookings) as bookings_n,
         (select count(*) from public.invoices) as invoices_n, (select count(*) from public.payments) as payments_n,
         (select count(*) from public.refunds) as refunds_n, (select count(*) from public.expenses) as expenses_n,
         (select count(*) from public.recovery_drills) as drills_n,
         (select md5(coalesce(string_agg(to_jsonb(p)::text, '~' order by p.id::text), '')) from public.payments p) as payments_hash,
         (select md5(coalesce(string_agg(to_jsonb(c)::text, '~' order by c.id::text), '')) from public.customers c) as customers_hash;
grant select on ops_before to authenticated;

begin;
do $$
begin
  if app.schema_version() < '20261101160000' then raise exception 'FAIL schema version is % after the upgrade', app.schema_version(); end if;
  if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'app' and p.proname in (
        'normalize_source_key','record_marketing_spend','reverse_marketing_spend','dashboard_source_roi',
        'set_cash_account_mapping','cash_flow_resolution','cash_on_hand','cash_unmapped_flows',
        'whatsapp_provider_available','set_whatsapp_provider_settings','whatsapp_provider_state',
        'valid_source_labels','set_business_defaults','access_readiness_summary','record_recovery_drill_with_evidence')) <> 15 then
    raise exception 'FAIL an operations function is missing after the upgrade'; end if;
  if (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and c.relname in
        ('marketing_spend_entries','cash_account_mappings','platform_flags','whatsapp_provider_settings','organization_business_defaults')) <> 5 then
    raise exception 'FAIL an operations table is missing after the upgrade'; end if;
  -- the migrations create no data of their own on a populated database, except the seeded closed platform flag
  if (select count(*) from public.marketing_spend_entries) <> 0 or (select count(*) from public.cash_account_mappings) <> 0
     or (select count(*) from public.whatsapp_provider_settings) <> 0 or (select count(*) from public.organization_business_defaults) <> 0 then
    raise exception 'FAIL an operations table holds rows right after the upgrade'; end if;
  if app.whatsapp_provider_available() is not false then raise exception 'FAIL the WhatsApp provider gate is not closed after the upgrade'; end if;
  -- recovery drills recorded before the upgrade stay valid and carry no kind or hash
  if exists (select 1 from public.recovery_drills where drill_kind is not null or archive_manifest_sha256 is not null or evidence_matches_export is not null) then
    raise exception 'FAIL a pre-existing recovery drill acquired evidence fields'; end if;
  -- immutable tables are immutable for the table owner
  begin
    insert into public.marketing_spend_entries(id, organization_id, kind, source_key, source_label, spent_on, amount, currency, request_key)
      values ('c2000000-0000-4000-8000-000000000001', '019fbdd0-ee52-7f57-8318-a288203c78c1', 'spend', 'probe', 'Probe', current_date, 1, 'IDR', gen_random_uuid());
    update public.marketing_spend_entries set amount = 2 where id = 'c2000000-0000-4000-8000-000000000001';
    raise exception 'FAIL a spend entry could be updated';
  exception when restrict_violation then null; end;
  begin
    insert into public.cash_account_mappings(id, organization_id, flow, method, effective_from, request_key)
      values ('c2000000-0000-4000-8000-000000000002', '019fbdd0-ee52-7f57-8318-a288203c78c1', 'payment', 'cash', current_date, gen_random_uuid());
    delete from public.cash_account_mappings where id = 'c2000000-0000-4000-8000-000000000002';
    raise exception 'FAIL a mapping could be deleted';
  exception when restrict_violation then null; end;
  raise notice 'operations objects present, no data created by the migrations, gate closed, immutability holds on populated data';
end $$;
rollback;

begin;
-- Synthetic activity inside this rolled-back transaction: the HomePaw workspace holds few customers and payments, so six synthetic sourced
-- customers created inside the probe window, six payments (two currencies, three methods, one pending) and one refund are added. Existing rows
-- are never modified.
do $$
declare
  v_org constant uuid := '019fbdd0-ee52-7f57-8318-a288203c78c1';
  v_branch uuid; v_ids uuid[] := array[
    'c2000000-0000-4000-8000-0000000000c1', 'c2000000-0000-4000-8000-0000000000c2', 'c2000000-0000-4000-8000-0000000000c3',
    'c2000000-0000-4000-8000-0000000000c4', 'c2000000-0000-4000-8000-0000000000c5', 'c2000000-0000-4000-8000-0000000000c6']::uuid[];
begin
  select id into v_branch from public.branches where organization_id = v_org and deleted_at is null order by is_default desc limit 1;
  if v_branch is null then raise exception 'FAIL the HomePaw workspace has no branch'; end if;
  insert into public.customers (id, organization_id, display_name, source, status, created_at)
  select v_ids[g], v_org, 'Probe ' || g, (array['Instagram','  instagram ','Teman','Google','Teman','Instagram'])[g], 'active', now() - interval '5 days'
    from generate_series(1, 6) g;
  insert into public.payments (id, organization_id, branch_id, customer_id, method, amount, currency, status, paid_at) values
    ('c2000000-0000-4000-8000-0000000000d1', v_org, v_branch, v_ids[1], 'cash', 200000, 'IDR', 'succeeded', now() - interval '3 days'),
    ('c2000000-0000-4000-8000-0000000000d2', v_org, v_branch, v_ids[2], 'bank_transfer', 350000, 'IDR', 'succeeded', now() - interval '3 days'),
    ('c2000000-0000-4000-8000-0000000000d3', v_org, v_branch, v_ids[3], 'card', 120000, 'IDR', 'succeeded', now() - interval '2 days'),
    ('c2000000-0000-4000-8000-0000000000d4', v_org, v_branch, v_ids[4], 'cash', 80000, 'IDR', 'pending', now() - interval '2 days'),
    ('c2000000-0000-4000-8000-0000000000d5', v_org, v_branch, v_ids[5], 'card', 25, 'USD', 'succeeded', now() - interval '2 days'),
    ('c2000000-0000-4000-8000-0000000000d6', v_org, v_branch, v_ids[6], 'cash', 40000, 'IDR', 'succeeded', now() - interval '1 day');
  insert into public.refunds (organization_id, payment_id, amount, status, refunded_at)
  values (v_org, 'c2000000-0000-4000-8000-0000000000d1', 50000, 'succeeded', now() - interval '1 day');
end $$;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"047f1e5c-5935-4566-b793-417df9f7cc9c","role":"authenticated","active_org_id":"019fbdd0-ee52-7f57-8318-a288203c78c1"}', true);
do $$
declare
  v_org constant uuid := '019fbdd0-ee52-7f57-8318-a288203c78c1';
  v_end date; v_start date; r record; v_n integer; v_exp numeric; v_got numeric; v_acct uuid; v_eff date; v_state record; v_version integer;
  v_status jsonb; v_h jsonb;
begin
  -- ===== Stream 5: typed defaults on a populated organization ===================================================================
  if app.set_business_defaults(array['Instagram', 'Teman', 'Google'], 7, 0) <> 1 then raise exception 'FAIL business defaults first write'; end if;
  begin perform app.set_business_defaults(array['x'], 1, 0); raise exception 'FAIL a stale business defaults write was accepted';
  exception when sqlstate '40001' then null; end;
  if (select invoice_due_days from public.organization_business_defaults) <> 7 then raise exception 'FAIL business defaults not stored'; end if;

  -- ===== Stream 1: spend and the source return agree with an independent computation =============================================
  v_end := current_date;
  v_start := v_end - 365;
  perform app.record_marketing_spend('Instagram', v_end, 100000, 'IDR', 'probe', gen_random_uuid());
  perform app.record_marketing_spend('  instagram ', v_end, 50000, 'IDR', null, gen_random_uuid());
  select count(*) into v_n from app.dashboard_source_roi(v_start, v_end);
  if v_n >= 51 then raise notice 'ROI probe skipped the sum comparison: % rows exceed the 50-row cap', v_n;
  else
    for r in
      select currency, sum(collected) as got_collected, sum(refunded) as got_refunded, sum(spend) as got_spend from app.dashboard_source_roi(v_start, v_end) group by currency
    loop
      -- independent: payments of customers created in the window with a non-empty source, paid in the window, succeeded, by currency
      select coalesce(sum(p.amount), 0) into v_exp
        from public.payments p
        join public.customers c on c.organization_id = p.organization_id
         and c.id = coalesce((select i.customer_id from public.invoices i where i.organization_id = p.organization_id and i.id = p.invoice_id), p.customer_id)
       where p.organization_id = v_org and p.status = 'succeeded' and p.currency = r.currency
         and p.paid_at >= (v_start::timestamp at time zone 'Asia/Jakarta') and p.paid_at < ((v_end + 1)::timestamp at time zone 'Asia/Jakarta')
         and c.deleted_at is null and c.status <> 'archived' and btrim(coalesce(c.source, '')) <> ''
         and c.created_at >= (v_start::timestamp at time zone 'Asia/Jakarta') and c.created_at < ((v_end + 1)::timestamp at time zone 'Asia/Jakarta');
      if v_exp <> r.got_collected then raise exception 'FAIL ROI collected % : function % vs independent % (%)', r.currency, r.got_collected, v_exp, v_n; end if;
    end loop;
    if (select coalesce(sum(cohort_customers), 0) from app.dashboard_source_roi(v_start, v_end)) < 6 then
      raise exception 'FAIL the ROI probe saw fewer than the six synthetic sourced customers (window % .. %): %', v_start, v_end, (select jsonb_agg(to_jsonb(x)) from app.dashboard_source_roi(v_start, v_end) x); end if;
    -- the synthetic data fixes these exact figures regardless of what else the workspace holds
    if (select coalesce(sum(collected), 0) from app.dashboard_source_roi(v_start, v_end) where currency = 'IDR' and source_key in ('instagram', 'teman')) < 590000
       or (select coalesce(sum(refunded), 0) from app.dashboard_source_roi(v_start, v_end) where currency = 'IDR' and source_key = 'instagram') < 50000 then
      raise exception 'FAIL the synthetic payments or refund are missing from the return'; end if;
    raise notice 'ROI probe: window % .. %, % currency/source rows, cohort customers %, collected IDR %', v_start, v_end, v_n,
      (select coalesce(sum(cohort_customers), 0) from app.dashboard_source_roi(v_start, v_end)), (select coalesce(sum(collected), 0) from app.dashboard_source_roi(v_start, v_end) where currency = 'IDR');
    if coalesce((select sum(spend) from app.dashboard_source_roi(v_start, v_end) where currency = 'IDR' and source_key = 'instagram'), 0) <> 150000 then
      raise exception 'FAIL the two Instagram spend entries (one differently cased) did not net into one source'; end if;
  end if;

  -- ===== Stream 2: mappings and the mapped position agree with independent sums ==============================================
  select min((p.paid_at at time zone 'Asia/Jakarta')::date) into v_eff from public.payments p where p.organization_id = v_org and p.status = 'succeeded' and p.currency = 'IDR';
  if v_eff is null then raise exception 'FAIL no succeeded IDR payment exists for the mapping probe'; end if;
  if v_eff is not null then
    v_acct := app.create_cash_account('Probe kas', 'cash', 'IDR', null);
    perform app.set_cash_account_mapping('payment', 'cash', null, v_acct, v_eff, gen_random_uuid());
    select * into v_state from app.cash_on_hand(current_date) where account_id = v_acct;
    select coalesce(sum(p.amount), 0) into v_exp from public.payments p
     where p.organization_id = v_org and p.status = 'succeeded' and p.currency = 'IDR' and p.method = 'cash' and (p.paid_at at time zone 'Asia/Jakarta')::date >= v_eff and (p.paid_at at time zone 'Asia/Jakarta')::date <= current_date;
    if v_state.payments_in <> v_exp then raise exception 'FAIL mapped cash payments: function % vs independent %', v_state.payments_in, v_exp; end if;
    -- everything mapped nowhere (other methods) is reported, not dropped
    select coalesce(sum(total_amount), 0) into v_got from app.cash_unmapped_flows(current_date) where kind = 'payment' and reason = 'not_mapped' and currency = 'IDR';
    select coalesce(sum(p.amount), 0) into v_exp from public.payments p
     where p.organization_id = v_org and p.status = 'succeeded' and p.currency = 'IDR' and p.method <> 'cash' and (p.paid_at at time zone 'Asia/Jakarta')::date >= v_eff and (p.paid_at at time zone 'Asia/Jakarta')::date <= current_date;
    if v_got <> v_exp then raise exception 'FAIL unmapped payments: function % vs independent %', v_got, v_exp; end if;
    raise notice 'mapping probe: effective %, mapped cash payments %, unmapped other-method payments %', v_eff, v_state.payments_in, v_got;
  else
    raise notice 'mapping probe skipped: the demo data holds no succeeded IDR payment';
  end if;

  -- ===== Stream 3: the provider boundary is closed on a populated organization ===================================================
  select * into v_state from app.whatsapp_provider_state();
  if v_state.platform_available is not false or v_state.enabled is not false or v_state.provider <> 'none' then raise exception 'FAIL provider boundary is not closed by default'; end if;
  begin perform app.set_whatsapp_provider_settings('meta_cloud', '123456789012', null, true, true, 0); raise exception 'FAIL enabling the provider was accepted';
  exception when sqlstate '22023' then null; end;

  -- ===== Streams 6-8: gates and shapes ========================================================================================
  begin perform app.access_readiness_summary(); raise exception 'FAIL a business owner read the platform readiness summary';
  exception when sqlstate '42501' then null; end;
  begin perform app.record_recovery_drill_with_evidence(current_date, 'partial', 'disposable_project', null, null, null, null, 'other', null, null); raise exception 'FAIL a business owner recorded a drill';
  exception when sqlstate '42501' then null; end;
  v_status := app.recovery_status();
  if not (v_status ? 'drills_with_matching_evidence') or v_status -> 'detail' <> 'null'::jsonb then raise exception 'FAIL recovery status shape (a business owner must get counts and no platform detail)'; end if;
  v_h := app.health_summary();
  if not (v_h -> 'cleanup' ? 'unapplied_preview_candidates' and v_h -> 'cleanup' ? 'last_dry_run_at' and v_h -> 'cleanup' ? 'last_completed_apply_at') then raise exception 'FAIL health cleanup signals missing'; end if;
  if (v_h::text ~* '(token|secret|password|credential|service_role)') then raise exception 'FAIL health summary exposes a credential-like word'; end if;
  raise notice 'operations surfaces agree with independent queries on the populated HomePaw workspace';
end $$;
rollback;

-- nothing persisted
do $$
declare b record;
begin
  select * into b from ops_before;
  if b.customers_n <> (select count(*) from public.customers) or b.payments_n <> (select count(*) from public.payments) or b.invoices_n <> (select count(*) from public.invoices)
     or b.refunds_n <> (select count(*) from public.refunds) or b.expenses_n <> (select count(*) from public.expenses) or b.drills_n <> (select count(*) from public.recovery_drills)
     or b.payments_hash <> (select md5(coalesce(string_agg(to_jsonb(p)::text, '~' order by p.id::text), '')) from public.payments p)
     or b.customers_hash <> (select md5(coalesce(string_agg(to_jsonb(c)::text, '~' order by c.id::text), '')) from public.customers c)
     or (select count(*) from public.marketing_spend_entries) + (select count(*) from public.cash_account_mappings) + (select count(*) from public.organization_business_defaults) <> 0 then
    raise exception 'FAIL the probe changed persistent data'; end if;
end $$;
select 'FINAL OPERATIONS POPULATED PROBE PASS' as result;
