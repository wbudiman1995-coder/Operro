-- Forward fix: a retried app.pay_retention_deposit call double-counted the payout in
-- financial_ledger. payroll_retention_events itself was already idempotent (the unique
-- index on (organization_id, membership_id, kind) makes a second insert fall through to the
-- unique_violation branch and reuse the existing event), but the ledger insert right after
-- that branch ran unconditionally on every call, so a second call for an already-paid
-- deposit -- a double-click, or a client retry after a dropped response -- wrote a second
-- -amount ledger row for a payout that only happened once. Mirrors pay_payroll_run's own
-- already-paid short-circuit: only write the ledger row the first time the event is created.
create or replace function app.pay_retention_deposit(p_membership uuid)
returns public.payroll_retention_events
security definer set search_path = app, public
language plpgsql as $$
declare
  v_org uuid := app.fn_active_organization();
  v_settings public.staff_payroll_settings%rowtype; v_org_settings public.payroll_cycle_settings%rowtype;
  v_hired_at date; v_tenure int; v_term int; v_amount_per_month numeric(14,2);
  v_balance numeric(14,2); v_event public.payroll_retention_events%rowtype; v_is_new boolean := true;
begin
  perform app.assert_tenant_authorized(v_org, 'payroll', 'payroll.approve', null);

  select hired_at into v_hired_at from public.resources
  where organization_id = v_org and membership_id = p_membership and kind = 'staff' and deleted_at is null
  order by created_at limit 1;
  if v_hired_at is null then raise exception 'no_hire_date_on_record' using errcode = 'check_violation'; end if;

  select * into v_settings from public.staff_payroll_settings where organization_id = v_org and membership_id = p_membership;
  select * into v_org_settings from public.payroll_cycle_settings where organization_id = v_org;
  if not coalesce(v_settings.retention_enabled, false) then
    raise exception 'retention_not_enabled_for_member' using errcode = 'check_violation';
  end if;

  v_term := coalesce(v_settings.retention_term_months, v_org_settings.retention_term_months_default);
  v_amount_per_month := coalesce(v_settings.retention_amount_per_month, v_org_settings.retention_amount_per_month_default);
  v_tenure := greatest(0, (extract(year from age(app.org_today(v_org), v_hired_at)) * 12
    + extract(month from age(app.org_today(v_org), v_hired_at)))::int);

  if v_tenure < v_term then
    raise exception 'retention_not_yet_payable:tenure=% term=%', v_tenure, v_term using errcode = 'check_violation';
  end if;
  v_balance := least(v_term, v_tenure) * v_amount_per_month;

  begin
    insert into public.payroll_retention_events (organization_id, membership_id, kind, amount, tenure_months, metadata)
    values (v_org, p_membership, 'payout', v_balance, v_tenure, jsonb_build_object('term_months', v_term, 'amount_per_month', v_amount_per_month))
    returning * into v_event;
  exception when unique_violation then
    v_is_new := false;
    select * into v_event from public.payroll_retention_events
    where organization_id = v_org and membership_id = p_membership and kind = 'payout';
  end;

  if v_is_new then
    insert into public.financial_ledger (organization_id, entry_type, amount, currency, occurred_at)
    select v_org, 'payroll_paid', -v_event.amount, coalesce(sc.currency, 'USD'), v_event.occurred_at
    from public.staff_compensation sc where sc.organization_id = v_org and sc.membership_id = p_membership and sc.is_active
    limit 1;
  end if;

  return v_event;
end; $$;

revoke all on function app.pay_retention_deposit(uuid) from public;
grant execute on function app.pay_retention_deposit(uuid) to authenticated;
