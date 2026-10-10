-- Populated-upgrade probe for 20261030100000_performance_dashboard.sql.
-- Runs on the upgraded rehearsal database inside ONE rolled-back transaction, as the real HomePaw owner identity:
-- each aggregate must equal an independent query over the same populated rows, finish quickly, and change nothing.
\set ON_ERROR_STOP on
begin;

create temporary table perf_before as
  select (select count(*) from public.bookings) as bookings_n, (select count(*) from public.invoices) as invoices_n,
         (select count(*) from public.payments) as payments_n, (select count(*) from public.refunds) as refunds_n,
         (select count(*) from public.customers) as customers_n,
         (select md5(coalesce(string_agg(settings::text, '~' order by id::text), '')) from public.organizations) as settings_hash;
grant select on perf_before to authenticated;

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"047f1e5c-5935-4566-b793-417df9f7cc9c","role":"authenticated","active_org_id":"019fbdd0-ee52-7f57-8318-a288203c78c1"}', true);
do $$
declare
  v_org constant uuid := '019fbdd0-ee52-7f57-8318-a288203c78c1';
  v_to date := current_date;
  v_from date := current_date - 364;                 -- 365 inclusive days
  v_pto date := current_date - 365;
  v_pfrom date := current_date - 729;
  v_t0 timestamptz := clock_timestamp();
  v_got numeric; v_exp numeric; r record; v_rows integer;
begin
  -- operations: every status bucket equals an independent count by Jakarta-local date
  for r in select * from app.dashboard_operations_performance(v_from, v_to, v_pfrom, v_pto, 'Asia/Jakarta') loop
    select count(*) into v_exp from public.bookings b
     where b.organization_id = v_org and b.deleted_at is null and b.status <> 'draft'
       and (b.starts_at at time zone 'Asia/Jakarta')::date between case when r.period = 'current' then v_from else v_pfrom end and case when r.period = 'current' then v_to else v_pto end;
    if r.completed + r.open_count + r.canceled + r.no_show <> v_exp then
      raise exception 'FAIL operations % total % <> independent %', r.period, r.completed + r.open_count + r.canceled + r.no_show, v_exp; end if;
  end loop;
  -- finance: collected per currency equals an independent sum; void invoices never count as issued
  for r in select * from app.dashboard_finance_performance(v_from, v_to, v_pfrom, v_pto, 'Asia/Jakarta') where period in ('current', 'previous') loop
    select coalesce(sum(p.amount), 0) into v_exp from public.payments p
     where p.organization_id = v_org and p.status = 'succeeded' and p.currency = r.currency
       and (p.paid_at at time zone 'Asia/Jakarta')::date between case when r.period = 'current' then v_from else v_pfrom end and case when r.period = 'current' then v_to else v_pto end;
    if r.collected_total <> v_exp then raise exception 'FAIL collected % % % <> independent %', r.period, r.currency, r.collected_total, v_exp; end if;
    select coalesce(sum(i.total), 0) into v_exp from public.invoices i
     where i.organization_id = v_org and i.status <> 'void' and i.currency = r.currency
       and (i.issued_at at time zone 'Asia/Jakarta')::date between case when r.period = 'current' then v_from else v_pfrom end and case when r.period = 'current' then v_to else v_pto end;
    if r.issued_total <> v_exp then raise exception 'FAIL issued % % % <> independent %', r.period, r.currency, r.issued_total, v_exp; end if;
  end loop;
  select coalesce(sum(outstanding_count), 0) into v_got from app.dashboard_finance_performance(v_from, v_to, v_pfrom, v_pto, 'Asia/Jakarta') where period = 'snapshot';
  select count(*) into v_exp from public.invoices i
   where i.organization_id = v_org and i.status = 'issued'
     and i.total > coalesce((select sum(p.amount) from public.payments p where p.organization_id = v_org and p.invoice_id = i.id and p.status = 'succeeded'), 0);
  if v_got <> v_exp then raise exception 'FAIL outstanding invoices % <> independent %', v_got, v_exp; end if;
  -- sources: new customers equal an independent count; output stays bounded
  select coalesce(sum(new_customers), 0), count(*) into v_got, v_rows from app.dashboard_source_performance(v_from, v_to, v_pfrom, v_pto, 'Asia/Jakarta') where period = 'current';
  select count(*) into v_exp from public.customers c
   where c.organization_id = v_org and c.deleted_at is null and c.status <> 'archived'
     and (c.created_at at time zone 'Asia/Jakarta')::date between v_from and v_to;
  if v_got <> v_exp then raise exception 'FAIL new customers % <> independent %', v_got, v_exp; end if;
  if v_rows > 12 then raise exception 'FAIL source output not bounded: % rows', v_rows; end if;
  if clock_timestamp() - v_t0 > interval '10 seconds' then raise exception 'FAIL aggregates too slow: %', clock_timestamp() - v_t0; end if;
  -- a legacy four-key card payload is still accepted on the upgraded workspace
  perform app.update_dashboard_card_settings('{"booking_today":true,"revenue_today":true,"active_customers":true,"open_tasks":true}'::jsonb);
  raise notice 'performance probe: aggregates equal independent queries on the populated workspace (% )', clock_timestamp() - v_t0;
end $$;

reset role;
do $$
declare b record;
begin
  select * into b from perf_before;
  if (select count(*) from public.bookings) <> b.bookings_n or (select count(*) from public.invoices) <> b.invoices_n
     or (select count(*) from public.payments) <> b.payments_n or (select count(*) from public.refunds) <> b.refunds_n
     or (select count(*) from public.customers) <> b.customers_n then
    raise exception 'FAIL the read-only dashboard changed existing rows'; end if;
  if app.schema_version() <> '20261030100000' then raise exception 'FAIL schema version'; end if;
  raise notice 'PERFORMANCE DASHBOARD POPULATED PROBE PASS';
end $$;
rollback;
