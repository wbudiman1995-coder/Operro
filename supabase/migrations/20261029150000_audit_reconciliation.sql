-- E2.4 Cross-entity audit viewer + read-only reconciliation (parity #36, #37).
--
-- Nothing here writes. app.audit_log is read through a bounded, capability-aware definer function (the table
-- itself stays private); reconciliation reports compare existing authoritative rows and never repair, create
-- or "explain away" history.
--
-- Audit visibility: the caller needs reports.view AND, per entity table, the capability that already shows that
-- data (finance.read for invoices/payments..., payroll.read for payroll, roles.manage for access tables, ...).
-- Tables with no mapping are visible to the business owner only. Rows that carry a branch are limited to branches
-- the caller can access. UPDATE events return only the fields that changed; secret-looking keys are removed.
begin;

create function app.audit_table_permission(p_table text) returns text
language sql immutable set search_path = '' as $$
  select case
    when p_table in ('customers','pets','customer_addresses','custom_field_definitions','custom_field_values',
                     'customer_onboarding_links','customer_onboarding_submissions','customer_onboarding_settings','whatsapp_drafts',
                     'whatsapp_contact_preferences') then 'customer.read'
    when p_table in ('bookings','booking_resources','grooming_jobs','grooming_job_pets','grooming_job_pet_services','manual_visits','visit_manual_billing',
                     'attendance_records','booking_series') then 'booking.read'
    when p_table in ('invoices','invoice_lines','orders','order_items','payments','refunds','expenses','organization_bank_accounts') then 'finance.read'
    when p_table in ('customer_packages','customer_package_ledger','packages','membership_plans','customer_memberships','package_reservations') then 'membership.read'
    when p_table like 'payroll\_%' escape '\' or p_table in ('staff_payroll_settings','staff_compensation','commission_entries') then 'payroll.read'
    when p_table in ('memberships','roles','role_permissions','users','platform_access_invitations') then 'roles.manage'
    when p_table in ('organizations','organization_size_bands','organization_size_band_settings','organization_pet_types','service_catalog','branches','resources') then 'settings.manage'
    else 'owner' end;
$$;

create function app.audit_table_visible(p_table text) returns boolean
language sql stable security definer set search_path = '' as $$
  select app.has_membership() and (
    case app.audit_table_permission(p_table)
      when 'owner' then app.is_business_owner_member(app.fn_active_organization())
      else app.has_permission(app.audit_table_permission(p_table)) end);
$$;

-- Audit rows are complete JSON serializations of the source table row. Several
-- source tables carry nested JSON (for example `metadata` and `receipt`), so
-- redact secret-looking keys recursively rather than treating the audit row as
-- flat. Arrays are traversed too, and long strings remain bounded.
create function app.audit_redact_value(p_value jsonb) returns jsonb
language plpgsql immutable set search_path = '' as $$
declare v_kind text := jsonb_typeof(p_value);
begin
  if v_kind = 'object' then
    return (
      select coalesce(jsonb_object_agg(e.key, app.audit_redact_value(e.value)), '{}'::jsonb)
      from jsonb_each(p_value) e
      where e.key !~* '(token|secret|password|api_key|credential|hash|signed_url|authorization|external_ref)'
    );
  elsif v_kind = 'array' then
    return (
      select coalesce(jsonb_agg(app.audit_redact_value(e.value) order by e.ord), '[]'::jsonb)
      from jsonb_array_elements(p_value) with ordinality as e(value, ord)
    );
  elsif v_kind = 'string' and length(p_value #>> '{}') > 200 then
    return to_jsonb(left(p_value #>> '{}', 200) || '…');
  end if;
  return p_value;
end $$;
revoke all on function app.audit_redact_value(jsonb) from public, anon, authenticated;

create function app.audit_redact(p_row jsonb) returns jsonb
language sql immutable set search_path = '' as $$
  select app.audit_redact_value(coalesce(p_row, '{}'::jsonb));
$$;

create function app.search_audit_events(
  p_tables text[], p_actor uuid, p_action text, p_from timestamptz, p_to timestamptz,
  p_cursor_at timestamptz, p_cursor_id uuid, p_limit integer default 50
) returns table (
  id uuid, occurred_at timestamptz, actor_id uuid, actor_label text, action text, entity_table text,
  entity_id uuid, branch_id uuid, diff jsonb
)
language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid := app.fn_active_organization();
begin
  if v_org is null or not app.has_membership() or not app.has_permission('reports.view') then
    raise exception 'not_authorized' using errcode = '42501'; end if;
  if (p_action is not null and p_action not in ('INSERT','UPDATE','DELETE'))
     or (p_tables is not null and coalesce(array_length(p_tables, 1), 0) > 30)
     or (p_from is not null and p_to is not null and p_from > p_to)
     or (p_cursor_at is null) <> (p_cursor_id is null) then
    raise exception 'invalid_filter' using errcode = '22023'; end if;
  return query
  select a.id, a.occurred_at, a.actor_id,
         coalesce(nullif(btrim(u.full_name), ''), u.email, case when a.actor_id is null then 'Sistem' else 'Pengguna' end)::text,
         a.action, a.entity_table, a.entity_id, br.branch_id,
         case a.action
           when 'UPDATE' then jsonb_build_object(
             'old', app.audit_redact((select coalesce(jsonb_object_agg(o.key, o.value), '{}'::jsonb) from jsonb_each(coalesce(a.diff -> 'old', '{}')) o
                    where o.key not in ('created_at','created_by','updated_at','updated_by') and (a.diff -> 'new') -> o.key is distinct from o.value)),
             'new', app.audit_redact((select coalesce(jsonb_object_agg(n.key, n.value), '{}'::jsonb) from jsonb_each(coalesce(a.diff -> 'new', '{}')) n
                    where n.key not in ('created_at','created_by','updated_at','updated_by') and (a.diff -> 'old') -> n.key is distinct from n.value)))
           when 'INSERT' then jsonb_build_object('new', app.audit_redact(a.diff -> 'new'))
           else jsonb_build_object('old', app.audit_redact(a.diff -> 'old')) end
    from app.audit_log a
    left join public.users u on u.id = a.actor_id
    cross join lateral (select nullif(coalesce(a.diff #>> '{new,branch_id}', a.diff #>> '{old,branch_id}'), '')::uuid as branch_id) br
   where a.organization_id = v_org
     and (p_tables is null or a.entity_table = any (p_tables))
     and (p_actor is null or a.actor_id = p_actor)
     and (p_action is null or a.action = p_action)
     and (p_from is null or a.occurred_at >= p_from)
     and (p_to is null or a.occurred_at < p_to)
     and (p_cursor_at is null or (a.occurred_at, a.id) < (p_cursor_at, p_cursor_id))
     and app.audit_table_visible(a.entity_table)
     and (br.branch_id is null or app.has_branch(br.branch_id))
   order by a.occurred_at desc, a.id desc
   limit greatest(1, least(coalesce(p_limit, 50), 100));
end $$;

-- ---------------------------------------------------------------------------
-- Reconciliation 1: invoice status vs valid payments (SECURITY INVOKER: RLS, incl. branch isolation, decides what is visible).
--   paid_in_full_not_closed      issued, net valid payments >= total
--   closed_without_full_payment  paid, net valid payments < total
--   void_with_payments           void, net valid payments > 0 (money held against a cancelled invoice)
--   currency_mismatch            a valid payment in another currency than the invoice
-- Valid = payment status 'succeeded'; net = succeeded payments minus succeeded refunds, same currency as the invoice.
-- ---------------------------------------------------------------------------
create function app.reconcile_invoice_payments(p_after_issued timestamptz, p_after_id uuid, p_limit integer default 25)
returns table (
  invoice_id uuid, invoice_number text, customer_name text, branch_id uuid, status text, currency text, total numeric,
  paid_amount numeric, refunded_amount numeric, net_paid numeric, foreign_currency_payments integer, issue text, issued_at timestamptz
)
language plpgsql stable security invoker set search_path = '' as $$
begin
  if app.fn_active_organization() is null or not app.has_membership() or not app.has_permission('finance.read') then
    raise exception 'not_authorized' using errcode = '42501'; end if;
  if (p_after_issued is null) <> (p_after_id is null) then raise exception 'invalid_filter' using errcode = '22023'; end if;
  return query
  select * from (
    select i.id, i.invoice_number::text, coalesce(c.display_name, 'Pelanggan')::text, i.branch_id, i.status::text, i.currency::text, i.total,
           s.paid, s.refunded, s.paid - s.refunded, s.foreign_n,
           (case
              when i.status = 'void' and s.paid - s.refunded > 0 then 'void_with_payments'
              when i.status <> 'void' and s.foreign_n > 0 then 'currency_mismatch'
              when i.status = 'issued' and i.total > 0 and s.paid - s.refunded >= i.total then 'paid_in_full_not_closed'
              when i.status = 'paid' and i.total > 0 and s.paid - s.refunded < i.total then 'closed_without_full_payment'
            end)::text as issue,
           i.issued_at
      from public.invoices i
      left join public.customers c on c.organization_id = i.organization_id and c.id = i.customer_id
      cross join lateral (
        select coalesce(sum(p.amount) filter (where p.status = 'succeeded' and p.currency = i.currency), 0) as paid,
               coalesce((select sum(r.amount) from public.refunds r join public.payments rp on rp.organization_id = r.organization_id and rp.id = r.payment_id
                          where r.organization_id = i.organization_id and rp.invoice_id = i.id and r.status = 'succeeded' and rp.currency = i.currency), 0) as refunded,
               (count(*) filter (where p.status = 'succeeded' and p.currency <> i.currency))::integer as foreign_n
          from public.payments p where p.organization_id = i.organization_id and p.invoice_id = i.id) s
     where i.organization_id = app.fn_active_organization()
       and (p_after_issued is null or (i.issued_at, i.id) < (p_after_issued, p_after_id))
  ) x
  where x.issue is not null
  order by x.issued_at desc, x.id desc
  limit greatest(1, least(coalesce(p_limit, 25), 100));
end $$;

-- ---------------------------------------------------------------------------
-- Reconciliation 1b: completed visits (bookings and off-books visits) with no valid invoice and no active manual
-- billing. A thin SECURITY INVOKER wrapper over the existing visit-register projection (unbilled filter). The
-- register reaches invoices through orders, so a caller who cannot read orders/invoices would see EVERY visit as
-- unbilled; the wrapper refuses instead of reporting that false positive.
-- ---------------------------------------------------------------------------
create function app.reconcile_unbilled_visits(p_after_visit timestamptz, p_after_id uuid, p_limit integer default 25)
returns table (id uuid, session_source text, branch_id uuid, customer_id uuid, customer_name text, visit_at timestamptz, description text)
language plpgsql stable security invoker set search_path = '' as $$
begin
  if app.fn_active_organization() is null or not app.has_membership()
     or not (app.has_permission('booking.read') and app.has_permission('finance.read') and app.has_permission('order.read')) then
    raise exception 'not_authorized' using errcode = '42501'; end if;
  if (p_after_visit is null) <> (p_after_id is null) then raise exception 'invalid_filter' using errcode = '22023'; end if;
  return query
  select v.id, v.session_source, v.branch_id, v.customer_id, v.customer_name, v.visit_at, v.description
    from app.search_visit_register(null, null, 'unbilled', null, true, 'newest', p_after_visit, p_after_id, greatest(1, least(coalesce(p_limit, 25), 100))) v;
end $$;

-- ---------------------------------------------------------------------------
-- Reconciliation 2: published payroll whose source work no longer supports the frozen snapshot.
-- For each published item of an approved/paid run, the live source counts (completed, validly invoiced pets by role)
-- are recomputed with the same engine function and compared with the counts stored in the immutable snapshot
-- (breakdown.meta). Live < snapshot  =>  source_reduced (an invoice was voided or work was removed after payout).
-- Live > snapshot is NOT reported here (that is new, unpaid work, not a broken source). Items whose snapshot has no
-- meta counts are reported as snapshot_without_counts rather than guessed at. Nothing is repaired or written.
-- Scans at most p_scan items per call; scanned_through/has_more let the caller continue.
-- ---------------------------------------------------------------------------
create function app.reconcile_payroll_sources(p_after_item uuid, p_scan integer default 25)
returns table (
  item_id uuid, run_id uuid, branch_id uuid, period_start date, period_end date, run_status text, membership_id uuid, staff_name text,
  snapshot_basic integer, live_basic integer, snapshot_styling integer, live_styling integer, snapshot_botak integer, live_botak integer,
  issue text, scanned_through uuid, has_more boolean
)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_org uuid := app.fn_active_organization();
  v_scan integer := greatest(1, least(coalesce(p_scan, 25), 100));
  r record;
  v_live jsonb;
  v_snap jsonb;
  v_last uuid;
  v_n integer := 0;
  v_more boolean := false;
  v_rows jsonb := '[]'::jsonb;
  v_sb integer; v_ss integer; v_sk integer; v_lb integer; v_ls integer; v_lk integer;
  v_issue text;
begin
  if v_org is null or not app.has_membership() or not app.has_module('payroll') or not app.has_permission('payroll.read') then
    raise exception 'not_authorized' using errcode = '42501'; end if;
  for r in
    select pi.id as item_id, pi.breakdown, pi.membership_id, run.id as run_id, run.branch_id, run.period_start, run.period_end, run.status as run_status,
           coalesce(nullif(btrim(u.full_name), ''), u.email, 'Staf') as staff_name
      from public.payroll_items pi
      join public.payroll_runs run on run.organization_id = pi.organization_id and run.id = pi.payroll_run_id
      join public.payroll_publications pub on pub.organization_id = pi.organization_id and pub.membership_id = pi.membership_id
           and pub.payroll_run_id = pi.payroll_run_id and pub.enabled
      left join public.memberships m on m.organization_id = pi.organization_id and m.id = pi.membership_id
      left join public.users u on u.id = m.user_id
     where pi.organization_id = v_org and run.status in ('approved','paid')
       and (p_after_item is null or pi.id > p_after_item)
       and (run.branch_id is null or app.has_branch(run.branch_id))
     order by pi.id
     limit v_scan + 1
  loop
    v_n := v_n + 1;
    if v_n > v_scan then v_more := true; exit; end if;
    v_last := r.item_id;
    v_snap := r.breakdown -> 'meta';
    v_issue := null;
    v_sb := null; v_ss := null; v_sk := null; v_lb := null; v_ls := null; v_lk := null;
    if jsonb_typeof(v_snap) = 'object' and v_snap ? 'basicCount' and v_snap ? 'stylingCount' and v_snap ? 'botakCount' then
      v_sb := (v_snap ->> 'basicCount')::integer; v_ss := (v_snap ->> 'stylingCount')::integer; v_sk := (v_snap ->> 'botakCount')::integer;
      begin
        v_live := app.compute_payroll_item(v_org, r.membership_id, r.period_start, r.period_end) -> 'meta';
        v_lb := (v_live ->> 'basicCount')::integer; v_ls := (v_live ->> 'stylingCount')::integer; v_lk := (v_live ->> 'botakCount')::integer;
        if v_lb < v_sb or v_ls < v_ss or v_lk < v_sk then v_issue := 'source_reduced'; end if;
      exception when others then
        v_issue := 'source_unavailable';
      end;
    else
      v_issue := 'snapshot_without_counts';
    end if;
    if v_issue is not null then
      v_rows := v_rows || jsonb_build_array(jsonb_build_object(
        'item_id', r.item_id, 'run_id', r.run_id, 'branch_id', r.branch_id, 'period_start', r.period_start, 'period_end', r.period_end,
        'run_status', r.run_status, 'membership_id', r.membership_id, 'staff_name', r.staff_name,
        'snapshot_basic', v_sb, 'live_basic', v_lb, 'snapshot_styling', v_ss, 'live_styling', v_ls, 'snapshot_botak', v_sk, 'live_botak', v_lk,
        'issue', v_issue));
    end if;
  end loop;
  if jsonb_array_length(v_rows) = 0 then
    -- A clean scan still reports how far it got, so the caller can continue.
    return query select null::uuid, null::uuid, null::uuid, null::date, null::date, null::text, null::uuid, null::text,
      null::integer, null::integer, null::integer, null::integer, null::integer, null::integer, null::text, v_last, v_more;
  else
    return query select x.item_id, x.run_id, x.branch_id, x.period_start, x.period_end, x.run_status, x.membership_id, x.staff_name,
      x.snapshot_basic, x.live_basic, x.snapshot_styling, x.live_styling, x.snapshot_botak, x.live_botak, x.issue, v_last, v_more
      from jsonb_to_recordset(v_rows) as x(item_id uuid, run_id uuid, branch_id uuid, period_start date, period_end date, run_status text,
        membership_id uuid, staff_name text, snapshot_basic integer, live_basic integer, snapshot_styling integer, live_styling integer,
        snapshot_botak integer, live_botak integer, issue text);
  end if;
end $$;

revoke all on function app.audit_table_permission(text), app.audit_table_visible(text), app.audit_redact_value(jsonb), app.audit_redact(jsonb),
  app.search_audit_events(text[], uuid, text, timestamptz, timestamptz, timestamptz, uuid, integer),
  app.reconcile_invoice_payments(timestamptz, uuid, integer), app.reconcile_unbilled_visits(timestamptz, uuid, integer), app.reconcile_payroll_sources(uuid, integer)
  from public, anon, authenticated;
grant execute on function app.search_audit_events(text[], uuid, text, timestamptz, timestamptz, timestamptz, uuid, integer),
  app.reconcile_invoice_payments(timestamptz, uuid, integer), app.reconcile_unbilled_visits(timestamptz, uuid, integer), app.reconcile_payroll_sources(uuid, integer) to authenticated;
-- audit_table_permission / audit_table_visible / audit_redact stay internal: only search_audit_events (a definer) calls them.

-- Make the new RPCs visible to PostgREST without waiting for its schema-cache refresh.
notify pgrst, 'reload schema';
commit;
