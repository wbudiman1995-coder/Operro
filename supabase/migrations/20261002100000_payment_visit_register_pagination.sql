-- Sections 27-30 final closeout — real server-side filtering/pagination for
-- the payment register (P4) and visit register (C7). The previous fix only
-- raised client-side caps (5000/3000 rows) while FinancePage/VisitsPage kept
-- passing no real filters and the browser filtered an already-fetched,
-- capped snapshot in memory. That does not satisfy "server filters/
-- pagination must not silently discard matching history" — a match past
-- the cap was still invisible no matter how high the cap goes.
--
-- Both functions below are plain `language sql stable` with NO
-- `security definer` — they run with the CALLING user's own privileges, so
-- every underlying table's existing RLS (org isolation, branch_isolation
-- via app.has_branch, and the finance.read / booking.read capability
-- policies) applies exactly as it already does to the app's direct
-- `.from(...).select(...)` calls today. No new authorization logic is
-- introduced or duplicated here — this is intentional: a hand-rolled
-- permission check in a SECURITY DEFINER function would be a second place
-- for authorization bugs to diverge from the real policies.
--
-- Pagination is keyset-based (cursor = the last row's own sort key), not
-- offset-based: an offset page silently skips or duplicates rows when the
-- underlying set changes between page loads, which is exactly the
-- correctness property being fixed here. (paid_at, id) / (visit_at, id) is
-- a stable, unique tie-breaker — paid_at/visit_at alone is not unique.
begin;

-- =====================================================================
-- Payment register (P4)
-- =====================================================================
create or replace function app.search_payment_register(
  p_stage text,
  p_service_month text,
  p_search text,
  p_cursor_paid_at timestamptz,
  p_cursor_id uuid,
  p_page_size integer
) returns table (
  id uuid, invoice_id uuid, invoice_number text, billing_mode text,
  customer_id uuid, customer_name text, customer_phone text,
  method text, amount numeric, status text, payment_stage text,
  proof_attachment_id uuid,
  screenshot_confirmed_at timestamptz, screenshot_confirmed_by uuid,
  bank_validated_at timestamptz, bank_validated_by uuid,
  paid_at timestamptz, service_month text
)
language sql stable as $$
  with scoped as (
    select
      p.id, p.invoice_id, i.invoice_number, i.billing_mode,
      p.customer_id, coalesce(c.display_name, 'Pelanggan') as customer_name, c.phone as customer_phone,
      p.method, p.amount, p.status, p.payment_stage,
      p.proof_attachment_id, p.screenshot_confirmed_at, p.screenshot_confirmed_by,
      p.bank_validated_at, p.bank_validated_by, p.paid_at,
      to_char(coalesce(b.starts_at, i.issued_at, p.paid_at) at time zone coalesce(br.timezone, 'Asia/Jakarta'), 'YYYY-MM') as service_month
    from public.payments p
    left join public.invoices i on i.organization_id = p.organization_id and i.id = p.invoice_id
    left join public.orders o on o.organization_id = i.organization_id and o.id = i.order_id
    left join public.bookings b on b.organization_id = o.organization_id and b.id = o.booking_id
    left join public.branches br on br.organization_id = p.organization_id and br.id = p.branch_id
    left join public.customers c on c.organization_id = p.organization_id and c.id = p.customer_id
    where p.organization_id = app.fn_active_organization()
  )
  select id, invoice_id, invoice_number, billing_mode, customer_id, customer_name, customer_phone,
    method, amount, status, payment_stage, proof_attachment_id, screenshot_confirmed_at, screenshot_confirmed_by,
    bank_validated_at, bank_validated_by, paid_at, service_month
  from scoped
  where (p_stage is null or p_stage = '' or payment_stage = p_stage)
    and (p_service_month is null or p_service_month = '' or service_month = p_service_month)
    and (p_search is null or p_search = '' or invoice_number ilike '%' || p_search || '%' or customer_name ilike '%' || p_search || '%')
    and (p_cursor_paid_at is null or (paid_at, id) < (p_cursor_paid_at, p_cursor_id))
  order by paid_at desc, id desc
  limit greatest(1, least(coalesce(p_page_size, 25), 200));
$$;

revoke all on function app.search_payment_register(text,text,text,timestamptz,uuid,integer) from public;
grant execute on function app.search_payment_register(text,text,text,timestamptz,uuid,integer) to authenticated;

-- Stage totals over the SAME month/search scope, deliberately ignoring the
-- stage filter itself (documented UX convention: stage cards let you
-- compare stages while narrowing by month/search) — computed over every
-- matching row, not just the current page, so switching stage never
-- changes what the OTHER cards report and totals never lag behind a truncated
-- client-side view.
create or replace function app.payment_register_stage_totals(
  p_service_month text,
  p_search text
) returns table (payment_stage text, total_amount numeric, row_count bigint)
language sql stable as $$
  with scoped as (
    select
      p.payment_stage, p.amount,
      coalesce(c.display_name, 'Pelanggan') as customer_name, i.invoice_number,
      to_char(coalesce(b.starts_at, i.issued_at, p.paid_at) at time zone coalesce(br.timezone, 'Asia/Jakarta'), 'YYYY-MM') as service_month
    from public.payments p
    left join public.invoices i on i.organization_id = p.organization_id and i.id = p.invoice_id
    left join public.orders o on o.organization_id = i.organization_id and o.id = i.order_id
    left join public.bookings b on b.organization_id = o.organization_id and b.id = o.booking_id
    left join public.branches br on br.organization_id = p.organization_id and br.id = p.branch_id
    left join public.customers c on c.organization_id = p.organization_id and c.id = p.customer_id
    where p.organization_id = app.fn_active_organization()
  )
  select payment_stage, sum(amount), count(*)
  from scoped
  where (p_service_month is null or p_service_month = '' or service_month = p_service_month)
    and (p_search is null or p_search = '' or invoice_number ilike '%' || p_search || '%' or customer_name ilike '%' || p_search || '%')
  group by payment_stage;
$$;

revoke all on function app.payment_register_stage_totals(text,text) from public;
grant execute on function app.payment_register_stage_totals(text,text) to authenticated;

-- =====================================================================
-- Visit register (C7)
-- =====================================================================
create or replace function app.search_visit_register(
  p_customer_id uuid,
  p_pet_id uuid,
  p_invoiced_status text,
  p_search text,
  p_include_bookings boolean,
  p_sort text,
  p_cursor_visit_at timestamptz,
  p_cursor_id uuid,
  p_page_size integer
) returns table (
  id uuid, session_source text, branch_id uuid, customer_id uuid, customer_name text,
  pet_names text[], pet_ids uuid[], fulfillment_mode text, visit_at timestamptz, description text,
  invoiced_status text, invoice_id uuid, invoice_number text,
  manual_billing_id uuid, manual_billing_amount numeric, manual_billing_note text, manual_billing_billed_at timestamptz,
  can_delete boolean
)
language sql stable as $$
  with booking_rows as (
    select
      b.id, 'booking'::text as session_source, b.branch_id, b.customer_id,
      coalesce(c.display_name, 'Pelanggan') as customer_name,
      coalesce(array_agg(distinct pt.name) filter (where pt.name is not null), '{}'::text[]) as pet_names,
      coalesce(array_agg(distinct gjp.pet_id) filter (where gjp.pet_id is not null), '{}'::uuid[]) as pet_ids,
      b.fulfillment_mode, b.starts_at as visit_at, 'Booking selesai'::text as description,
      case when inv.id is not null then 'invoiced' when vmb.id is not null then 'manually_billed' else 'unbilled' end as invoiced_status,
      inv.id as invoice_id, inv.invoice_number,
      vmb.id as manual_billing_id, vmb.amount as manual_billing_amount, vmb.note as manual_billing_note, vmb.billed_at as manual_billing_billed_at,
      false as can_delete
    from public.bookings b
    join public.customers c on c.organization_id = b.organization_id and c.id = b.customer_id
    left join public.grooming_job_pets gjp on gjp.organization_id = b.organization_id and gjp.grooming_job_id = b.id and gjp.deleted_at is null
    left join public.pets pt on pt.organization_id = b.organization_id and pt.id = gjp.pet_id
    left join public.orders o on o.organization_id = b.organization_id and o.booking_id = b.id and o.status <> 'canceled' and o.deleted_at is null
    left join public.invoices inv on inv.organization_id = o.organization_id and inv.order_id = o.id and inv.status <> 'void'
    left join public.visit_manual_billing vmb on vmb.organization_id = b.organization_id and vmb.source_type = 'booking' and vmb.source_id = b.id and vmb.undone_at is null
    where b.organization_id = app.fn_active_organization() and b.status = 'completed' and b.deleted_at is null
      and p_include_bookings
      and (p_customer_id is null or b.customer_id = p_customer_id)
    group by b.id, c.display_name, b.branch_id, b.customer_id, b.fulfillment_mode, b.starts_at, inv.id, inv.invoice_number, vmb.id, vmb.amount, vmb.note, vmb.billed_at
  ),
  manual_rows as (
    select
      mv.id, 'manual'::text as session_source, mv.branch_id, mv.customer_id,
      coalesce(c.display_name, 'Pelanggan') as customer_name,
      case when pt.name is not null then array[pt.name] else '{}'::text[] end as pet_names,
      case when mv.pet_id is not null then array[mv.pet_id] else '{}'::uuid[] end as pet_ids,
      mv.fulfillment_mode, mv.visit_at, mv.description,
      case when inv.id is not null then 'invoiced' when vmb.id is not null then 'manually_billed' else 'unbilled' end as invoiced_status,
      inv.id as invoice_id, inv.invoice_number,
      vmb.id as manual_billing_id, vmb.amount as manual_billing_amount, vmb.note as manual_billing_note, vmb.billed_at as manual_billing_billed_at,
      (inv.id is null and vmb.id is null) as can_delete
    from public.manual_visits mv
    join public.customers c on c.organization_id = mv.organization_id and c.id = mv.customer_id
    left join public.pets pt on pt.organization_id = mv.organization_id and pt.id = mv.pet_id
    left join public.invoices inv on inv.organization_id = mv.organization_id and inv.id = mv.invoice_id and inv.status <> 'void'
    left join public.visit_manual_billing vmb on vmb.organization_id = mv.organization_id and vmb.source_type = 'manual_visit' and vmb.source_id = mv.id and vmb.undone_at is null
    where mv.organization_id = app.fn_active_organization() and mv.deleted_at is null
      and (p_customer_id is null or mv.customer_id = p_customer_id)
  ),
  combined as (
    select * from booking_rows
    union all
    select * from manual_rows
  )
  select id, session_source, branch_id, customer_id, customer_name, pet_names, pet_ids,
    fulfillment_mode, visit_at, description, invoiced_status, invoice_id, invoice_number,
    manual_billing_id, manual_billing_amount, manual_billing_note, manual_billing_billed_at, can_delete
  from combined
  where (p_pet_id is null or p_pet_id = any(pet_ids))
    and (p_invoiced_status is null or p_invoiced_status = '' or p_invoiced_status = 'all' or invoiced_status = p_invoiced_status)
    and (p_search is null or p_search = ''
      or customer_name ilike '%' || p_search || '%'
      or description ilike '%' || p_search || '%'
      or exists (select 1 from unnest(pet_names) n where n ilike '%' || p_search || '%'))
    and (
      p_cursor_visit_at is null
      or (p_sort = 'oldest' and (visit_at, id) > (p_cursor_visit_at, p_cursor_id))
      or (p_sort is distinct from 'oldest' and (visit_at, id) < (p_cursor_visit_at, p_cursor_id))
    )
  order by
    case when p_sort = 'oldest' then visit_at end asc,
    case when p_sort = 'oldest' then id end asc,
    case when p_sort is distinct from 'oldest' then visit_at end desc,
    case when p_sort is distinct from 'oldest' then id end desc
  limit greatest(1, least(coalesce(p_page_size, 25), 200));
$$;

revoke all on function app.search_visit_register(uuid,uuid,text,text,boolean,text,timestamptz,uuid,integer) from public;
grant execute on function app.search_visit_register(uuid,uuid,text,text,boolean,text,timestamptz,uuid,integer) to authenticated;

notify pgrst, 'reload schema';
commit;
