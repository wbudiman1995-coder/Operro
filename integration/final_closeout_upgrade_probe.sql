-- Populated-upgrade probe for the final parity closeout migrations 20261031100000 .. 20261031160000.
-- Runs on the upgraded rehearsal database (real HomePaw demo rows) inside ONE rolled-back transaction, as the real HomePaw owner
-- identity: every new surface must work on populated data, agree with independent queries, and change nothing that persists.
\set ON_ERROR_STOP on
create temporary table closeout_before as
  select (select count(*) from public.customers) as customers_n, (select count(*) from public.bookings) as bookings_n,
         (select count(*) from public.invoices) as invoices_n, (select count(*) from public.payments) as payments_n,
         (select count(*) from public.whatsapp_drafts) as drafts_n,
         (select md5(coalesce(string_agg(settings::text, '~' order by id::text), '')) from public.organizations) as org_settings_hash,
         (select md5(coalesce(string_agg(settings::text, '~' order by id::text), '')) from public.branches) as branch_settings_hash;
grant select on closeout_before to authenticated;

begin;
do $$
begin
  if app.schema_version() < '20261031160000' then raise exception 'FAIL schema version is % after the upgrade', app.schema_version(); end if;
  -- objects of every slice exist
  if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'app' and p.proname in (
        'dashboard_operational_alerts','create_cash_account','record_cash_movement','reverse_cash_movement','set_cash_account_archived','cash_register_position',
        'preview_whatsapp_batch','create_whatsapp_batch','cancel_whatsapp_batch','whatsapp_resolve_recipient',
        'org_export_scope','org_export_purge_candidates','org_export_mark_purged','org_export_record_verification',
        'set_branch_calendar_hours','set_storage_cleanup_schedule','storage_cleanup_schedule_state')) <> 17 then
    raise exception 'FAIL a closeout function is missing after the upgrade'; end if;
  if (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and c.relname in
        ('cash_accounts','cash_movements','whatsapp_batches','whatsapp_draft_events','storage_cleanup_schedules')) <> 5 then
    raise exception 'FAIL a closeout table is missing after the upgrade'; end if;
  -- the WhatsApp event backfill gives every pre-existing draft exactly one creation event
  if (select count(*) from public.whatsapp_draft_events) <> (select count(*) from public.whatsapp_drafts) then
    raise exception 'FAIL whatsapp event backfill: % events for % drafts', (select count(*) from public.whatsapp_draft_events), (select count(*) from public.whatsapp_drafts); end if;
  -- the immutable tables really are immutable for the table owner
  begin
    insert into public.cash_accounts(id, organization_id, name, kind, currency) values ('c1000000-0000-4000-8000-000000000001', '019fbdd0-ee52-7f57-8318-a288203c78c1', 'probe', 'cash', 'IDR');
    insert into public.cash_movements(id, organization_id, account_id, kind, direction, amount, currency, occurred_on, request_key)
      values ('c1000000-0000-4000-8000-000000000002', '019fbdd0-ee52-7f57-8318-a288203c78c1', 'c1000000-0000-4000-8000-000000000001', 'opening_balance', 'in', 1, 'IDR', current_date, gen_random_uuid());
    update public.cash_movements set amount = 2 where id = 'c1000000-0000-4000-8000-000000000002';
    raise exception 'FAIL a cash movement could be updated';
  exception when restrict_violation then null; end;
  raise notice 'closeout objects present, backfill consistent, immutability holds on populated data';
end $$;
rollback;

begin;
-- independent per-table counts, computed as the table owner (a bare PostgreSQL database has no client grants on some tables)
create temporary table closeout_indep as
  select s.table_name as t,
         (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from public.%I where organization_id = %L', s.table_name, '019fbdd0-ee52-7f57-8318-a288203c78c1'), false, true, '')))[1]::text::bigint as n
    from app.organization_export_table_specs s;
grant select on closeout_indep to authenticated;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"047f1e5c-5935-4566-b793-417df9f7cc9c","role":"authenticated","active_org_id":"019fbdd0-ee52-7f57-8318-a288203c78c1"}', true);
do $$
declare
  v_org constant uuid := '019fbdd0-ee52-7f57-8318-a288203c78c1';
  v_branch uuid; v_token timestamptz; v_scope jsonb; v_n bigint; v_exp bigint; r record; v_acct uuid; v_mov uuid; v_t0 timestamptz := clock_timestamp(); v_pay0 bigint;
begin
  select count(*) into v_pay0 from public.payments;
  -- P4: the scope report agrees with independent counts for every allowlisted table, and covers every tenant table exactly once
  v_scope := app.org_export_scope();
  for r in select x ->> 'table' as t, (x ->> 'row_count')::bigint as n from jsonb_array_elements(v_scope -> 'included') x loop
    select n into v_exp from closeout_indep where t = r.t;
    if r.n <> v_exp then raise exception 'FAIL scope count for %: % <> independent %', r.t, r.n, v_exp; end if;
  end loop;
  if jsonb_array_length(v_scope -> 'included') < 50 then raise exception 'FAIL expected the extended allowlist, got % tables', jsonb_array_length(v_scope -> 'included'); end if;
  if exists (select 1 from jsonb_array_elements(v_scope -> 'included') a join jsonb_array_elements(v_scope -> 'uncovered') b on a ->> 'table' = b ->> 'table') then
    raise exception 'FAIL a table is both covered and uncovered'; end if;
  if not exists (select 1 from jsonb_array_elements(v_scope -> 'uncovered') x where x ->> 'table' = 'customer_onboarding_links' and x ->> 'class' = 'secret') then
    raise exception 'FAIL token table not reported as secret'; end if;
  if (app.org_export_purge_candidates()) <> '[]'::jsonb then raise exception 'FAIL a fresh workspace has purge candidates'; end if;

  -- P2: a cash-control register round trip on the populated workspace (rolled back)
  v_acct := app.create_cash_account('Probe kas', 'cash', 'IDR', null);
  v_mov := app.record_cash_movement(v_acct, 'capital_contribution', 500000, current_date, 'Probe', null, null, null, gen_random_uuid());
  perform app.record_cash_movement(v_acct, 'cash_out', 120000, current_date, null, null, null, null, gen_random_uuid());
  select balance into v_exp from app.cash_register_position() where account_id = v_acct;
  if v_exp <> 380000 then raise exception 'FAIL register balance % <> 380000', v_exp; end if;
  perform app.reverse_cash_movement(v_mov, 'Probe pembalikan', current_date, gen_random_uuid());
  select balance into v_exp from app.cash_register_position() where account_id = v_acct;
  if v_exp <> -120000 then raise exception 'FAIL register balance after reversal % <> -120000', v_exp; end if;
  if (select count(*) from public.payments) <> v_pay0 then raise exception 'FAIL the register wrote to payments'; end if;

  -- P1: the alert reader works on populated data for the owner and agrees with independent counts
  select coalesce(sum(item_count), 0) into v_n from app.dashboard_operational_alerts(array['overdue_invoices']);
  select count(*) into v_exp from public.invoices i where i.organization_id = v_org and i.status = 'issued' and i.due_at < now()
     and i.total - coalesce((select sum(p.amount) from public.payments p where p.organization_id = v_org and p.invoice_id = i.id and p.status = 'succeeded'), 0) > 0;
  if v_n <> v_exp then raise exception 'FAIL overdue invoices % <> independent %', v_n, v_exp; end if;
  select coalesce(sum(item_count), 0) into v_n from app.dashboard_operational_alerts(array['stale_open_bookings']);
  select count(*) into v_exp from public.bookings b where b.organization_id = v_org and b.deleted_at is null and b.status in ('requested','confirmed','in_progress')
     and b.starts_at < now() - interval '24 hours' and b.starts_at >= now() - interval '90 days';
  if v_n <> v_exp then raise exception 'FAIL stale bookings % <> independent %', v_n, v_exp; end if;
  select coalesce(sum(item_count), 0) into v_n from app.dashboard_operational_alerts(array['expiring_packages']);
  select count(*) into v_exp from public.customer_packages cp where cp.organization_id = v_org and cp.deleted_at is null and cp.status = 'active' and cp.sessions_remaining > 0
     and cp.expires_at >= now() and cp.expires_at < now() + interval '7 days';
  if v_n <> v_exp then raise exception 'FAIL expiring packages % <> independent %', v_n, v_exp; end if;
  perform * from app.dashboard_operational_alerts(array['maintenance_problems']);

  -- P5: calendar hours on the real default branch: set, siblings kept, reset (rolled back)
  select id, updated_at into v_branch, v_token from public.branches where organization_id = v_org and is_default and deleted_at is null;
  perform app.set_branch_calendar_hours(v_branch, 480, 1200, v_token);
  if (select settings #>> '{schedule,dayStartMinutes}' from public.branches where id = v_branch) <> '480' then raise exception 'FAIL calendar hours not stored'; end if;

  -- P3: batch preview over real invoices / customers (nothing is created by a preview)
  select count(*) into v_exp from public.whatsapp_drafts;
  perform * from app.preview_whatsapp_batch('followup', coalesce((select array_agg(id) from (select id from public.customers where organization_id = v_org and deleted_at is null limit 25) c), array[gen_random_uuid()]));
  if (select count(*) from public.whatsapp_drafts) <> v_exp then raise exception 'FAIL a preview created drafts'; end if;

  -- P7 / P8: consent is off, health carries the new signals
  if (app.storage_cleanup_schedule_state() ->> 'enabled')::boolean then raise exception 'FAIL cleanup consent is on by default'; end if;
  if not (app.health_summary() -> 'exports' ? 'purge_candidates') or not (app.health_summary() -> 'cleanup' ? 'schedule_consent') then raise exception 'FAIL health summary lacks the new signals'; end if;
  if clock_timestamp() - v_t0 > interval '20 seconds' then raise exception 'FAIL the closeout surfaces took % on the populated workspace', clock_timestamp() - v_t0; end if;
  raise notice 'closeout surfaces agree with independent queries on the populated HomePaw workspace (% s)', extract(epoch from clock_timestamp() - v_t0);
end $$;
rollback;

-- nothing the probe did persisted
do $$
declare b record;
begin
  select * into b from closeout_before;
  if (select count(*) from public.customers) <> b.customers_n or (select count(*) from public.bookings) <> b.bookings_n
     or (select count(*) from public.invoices) <> b.invoices_n or (select count(*) from public.payments) <> b.payments_n
     or (select count(*) from public.whatsapp_drafts) <> b.drafts_n then raise exception 'FAIL the probe changed a row count'; end if;
  if (select md5(coalesce(string_agg(settings::text, '~' order by id::text), '')) from public.organizations) <> b.org_settings_hash
     or (select md5(coalesce(string_agg(settings::text, '~' order by id::text), '')) from public.branches) <> b.branch_settings_hash then raise exception 'FAIL the probe changed settings'; end if;
  if exists (select 1 from public.cash_accounts where name = 'Probe kas') then raise exception 'FAIL probe data persisted (cash account)'; end if;
end $$;
select 'FINAL CLOSEOUT POPULATED PROBE PASS';
