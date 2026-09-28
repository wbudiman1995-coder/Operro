-- Serialize app.recompute_payroll_run across concurrent first-time inserts.
-- Forward migration: preserve the already-applied 20261010110000 migration.
-- Payroll run exclusion constraints still enforce non-overlapping periods;
-- this lock prevents the two-insert deadlock before a run row exists to lock.
create or replace function app.recompute_payroll_run(p_period_start date, p_period_end date, p_branch uuid default null)
returns uuid
security definer set search_path = app, public
language plpgsql as $$
declare
  v_org uuid := app.fn_active_organization();
  v_run_id uuid;
  v_status text;
  v_currency text;
  m record;
  v_breakdown jsonb;
  v_override record;
  v_custom_total numeric(14,2);
  v_gross numeric(14,2); v_total_gross numeric(14,2) := 0; v_total_net numeric(14,2) := 0;
begin
  perform app.assert_tenant_authorized(v_org, 'payroll', 'payroll.manage', p_branch);
  -- Serialize first-time creation as well as later edits for this org/branch.
  -- Two concurrent inserts can deadlock while checking the exclusion constraint,
  -- before either session reaches the existing-row FOR UPDATE lock.
  perform pg_advisory_xact_lock(
    hashtextextended('payroll_runs:' || v_org::text || ':' || coalesce(p_branch::text, 'all'), 0)
  );
  if p_period_end <= p_period_start then
    raise exception 'invalid_period' using errcode = 'check_violation';
  end if;

  insert into public.payroll_cycle_settings (organization_id)
  values (v_org) on conflict (organization_id) do nothing;

  select id, status, currency into v_run_id, v_status, v_currency from public.payroll_runs
  where organization_id = v_org and coalesce(branch_id, '00000000-0000-0000-0000-000000000000'::uuid)
      = coalesce(p_branch, '00000000-0000-0000-0000-000000000000'::uuid)
    and period_start = p_period_start and period_end = p_period_end
  for update;

  if v_run_id is null then
    -- payroll_runs.currency defaults to 'USD' (0009's original default, written
    -- before this engine existed); a run must instead carry the ORG's real
    -- currency, not that placeholder, since it flows straight into the
    -- financial_ledger entry tg_payroll_ledger writes on pay. Prefer the org's
    -- own declared currency (organizations.settings->>'currency'); fall back to
    -- whatever currency its active staff_compensation rows actually use (the
    -- most common one) when the org never set one; fall back to the table
    -- default only if neither source exists.
    select coalesce(
      (select o.settings ->> 'currency' from public.organizations o where o.id = v_org),
      (select sc.currency from public.staff_compensation sc
       where sc.organization_id = v_org and sc.is_active and sc.deleted_at is null
       group by sc.currency order by count(*) desc limit 1),
      'USD'
    ) into v_currency;
    -- Two concurrent FIRST recomputes for the same not-yet-existing period can both
    -- see "no row" before either commits. excl_payroll_runs_no_overlap still
    -- prevents a duplicate row (the loser's INSERT blocks until the winner
    -- commits, then fails), but a raw exclusion_violation is not the "successful-
    -- looking failed action" the brief warns against either -- catch it and adopt
    -- the winner's already-committed run instead of erroring the loser out.
    begin
      insert into public.payroll_runs (organization_id, branch_id, period_start, period_end, status, currency)
      values (v_org, p_branch, p_period_start, p_period_end, 'draft', v_currency)
      returning id, status into v_run_id, v_status;
    exception when exclusion_violation then
      select id, status, currency into v_run_id, v_status, v_currency from public.payroll_runs
      where organization_id = v_org and coalesce(branch_id, '00000000-0000-0000-0000-000000000000'::uuid)
          = coalesce(p_branch, '00000000-0000-0000-0000-000000000000'::uuid)
        and period_start = p_period_start and period_end = p_period_end
      for update;
      if v_run_id is null then
        raise; -- genuinely not our period after all (e.g. a broader overlapping range) -- surface it
      end if;
      if v_status <> 'draft' then
        raise exception 'run_not_editable:%', v_status using errcode = 'check_violation';
      end if;
    end;
  elsif v_status <> 'draft' then
    raise exception 'run_not_editable:%', v_status using errcode = 'check_violation';
  end if;

  delete from public.payroll_items where organization_id = v_org and payroll_run_id = v_run_id;

  for m in
    select sc.membership_id, sc.currency
    from public.staff_compensation sc
    where sc.organization_id = v_org and sc.is_active and sc.deleted_at is null
      and sc.effective_from <= (p_period_end - 1)
    group by sc.membership_id, sc.currency
  loop
    -- Brief requirement: never sum unlike currencies into an unlabeled total.
    -- A membership paid in a currency other than the run's is a real
    -- configuration problem, not something to silently add together.
    if m.currency <> v_currency then
      raise exception 'currency_mismatch:membership=% run_currency=% staff_currency=%', m.membership_id, v_currency, m.currency
        using errcode = 'check_violation';
    end if;
    v_breakdown := app.compute_payroll_item(v_org, m.membership_id, p_period_start, p_period_end);

    for v_override in
      select component_key, amount from public.payroll_item_overrides
      where organization_id = v_org and payroll_run_id = v_run_id and membership_id = m.membership_id
    loop
      v_breakdown := jsonb_set(v_breakdown, array[v_override.component_key], to_jsonb(v_override.amount));
    end loop;

    select coalesce(sum(amount), 0) into v_custom_total
    from public.payroll_custom_rows
    where organization_id = v_org and payroll_run_id = v_run_id and membership_id = m.membership_id and deleted_at is null;

    v_gross := coalesce((v_breakdown->>'basic')::numeric,0) + coalesce((v_breakdown->>'weekly')::numeric,0)
      + coalesce((v_breakdown->>'noLate')::numeric,0) + coalesce((v_breakdown->>'noSick')::numeric,0)
      + coalesce((v_breakdown->>'styling')::numeric,0) + coalesce((v_breakdown->>'botak')::numeric,0)
      + coalesce((v_breakdown->>'transport')::numeric,0) + coalesce((v_breakdown->>'perDog')::numeric,0)
      + coalesce((v_breakdown->>'daily')::numeric,0) + v_custom_total;

    insert into public.payroll_items
      (organization_id, payroll_run_id, membership_id, base_pay, commission_total, gross_pay, net_pay, breakdown)
    values (v_org, v_run_id, m.membership_id, coalesce((v_breakdown->>'basic')::numeric,0),
      coalesce((v_breakdown->>'styling')::numeric,0) + coalesce((v_breakdown->>'botak')::numeric,0),
      v_gross, v_gross, v_breakdown);

    v_total_gross := v_total_gross + v_gross;
    v_total_net := v_total_net + v_gross;
  end loop;

  update public.payroll_runs set total_gross = v_total_gross, total_net = v_total_net, revision = revision + 1
  where organization_id = v_org and id = v_run_id;

  return v_run_id;
end; $$;

revoke all on function app.recompute_payroll_run(date, date, uuid) from public;
grant execute on function app.recompute_payroll_run(date, date, uuid) to authenticated;
