-- =====================================================================
-- MIGRATION MANIFEST
-- =====================================================================
-- Migration        20261010120000_payroll_export_detail_rpc
-- Purpose          Section 33 (payroll exports): the appointment-level detail
--                  rows the XLSX/CSV export's "Detail Job" sheet needs, on top
--                  of app.payroll_eligible_pets (20261010110000). Returns raw
--                  joined data only -- no money calculation happens here, so
--                  the export can never compute a number independently of
--                  app.compute_payroll_item / the frozen payroll_items
--                  snapshot (brief requirement: one authoritative source).
-- Objects Created  app.payroll_export_detail_rows(uuid, date, date)
-- =====================================================================

begin;

create or replace function app.payroll_export_detail_rows(p_org uuid, p_period_start date, p_period_end date)
returns table(
  booking_id uuid, membership_id uuid, starts_at timestamptz,
  customer_name text, pet_name text, pet_size text, services text,
  service_revenue numeric, invoice_number text, invoice_id uuid, invoice_status text
)
security definer set search_path = app, public
language sql stable as $$
  select
    b.id, ep.membership_id, b.starts_at,
    coalesce(c.display_name, 'Pelanggan'), coalesce(pt.name, 'Hewan'), pt.size,
    string_agg(distinct sc.name, ', ' order by sc.name),
    sum(gjps.unit_price_snapshot * gjps.quantity),
    inv.invoice_number, inv.id, inv.status
  from app.payroll_eligible_pets(p_org, p_period_start, p_period_end) ep
  join public.bookings b on b.organization_id = p_org and b.id = ep.booking_id
  join public.pets pt on pt.organization_id = p_org and pt.id = ep.pet_id
  left join public.customers c on c.organization_id = p_org and c.id = b.customer_id
  join public.grooming_job_pet_services gjps on gjps.organization_id = p_org
    and gjps.grooming_job_pet_id = ep.grooming_job_pet_id and gjps.deleted_at is null
  join public.service_catalog sc on sc.organization_id = p_org and sc.id = gjps.service_id
  left join public.orders ord on ord.organization_id = p_org and ord.booking_id = b.id and ord.deleted_at is null
  left join public.invoices inv on inv.organization_id = p_org and inv.order_id = ord.id and inv.status <> 'void'
  group by b.id, ep.membership_id, b.starts_at, c.display_name, pt.name, pt.size, inv.invoice_number, inv.id, inv.status;
$$;

revoke all on function app.payroll_export_detail_rows(uuid, date, date) from public;
grant execute on function app.payroll_export_detail_rows(uuid, date, date) to authenticated;

notify pgrst, 'reload schema';
commit;
