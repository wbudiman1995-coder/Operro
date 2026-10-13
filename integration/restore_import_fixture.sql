-- Synthetic source data for the restore rehearsal (integration/run_restore_import_rehearsal.sh, apps/web/test/restore-import-rehearsal.test.ts).
-- Runs as the database owner in a throw-away database that has every migration applied. No real person, e-mail, phone or provider appears.
-- Organization F1..01 is the one archived and restored; F1..02 exists only so the rehearsal can prove tenant isolation.
\set ON_ERROR_STOP on
begin;
insert into public.organizations (id, name, slug, status) values
  ('f1000000-0000-4000-8000-000000000001', 'Restore Source', 'restore-source', 'active'),
  ('f1000000-0000-4000-8000-000000000002', 'Restore Neighbour', 'restore-neighbour', 'active');

insert into public.branches (id, organization_id, name, is_default, status) values
  ('f1000000-0000-4000-8000-0000000000b1', 'f1000000-0000-4000-8000-000000000001', 'North', true, 'active'),
  ('f1000000-0000-4000-8000-0000000000b2', 'f1000000-0000-4000-8000-000000000001', 'South', false, 'active'),
  ('f1000000-0000-4000-8000-0000000000b3', 'f1000000-0000-4000-8000-000000000002', 'Neighbour main', true, 'active');

-- 450 customers: more than two export chunks (200 rows each) so chunk boundaries are exercised.
insert into public.customers (id, organization_id, display_name, phone, source, status, created_at)
select ('f1000000-0000-4000-8000-' || lpad(to_hex(0x100000 + g), 12, '0'))::uuid, 'f1000000-0000-4000-8000-000000000001',
       'Pelanggan ' || g, '0812000' || lpad(g::text, 5, '0'), (array['Instagram','Teman','Google'])[1 + g % 3], 'active', timestamptz '2026-09-01 03:00Z' + (g || ' minutes')::interval
  from generate_series(1, 450) g;
insert into public.customers (id, organization_id, display_name, phone, source, status) values
  ('f1000000-0000-4000-8000-0000000fffc1', 'f1000000-0000-4000-8000-000000000002', 'Tetangga 1', '08129990001', 'Instagram', 'active'),
  ('f1000000-0000-4000-8000-0000000fffc2', 'f1000000-0000-4000-8000-000000000002', 'Tetangga 2', '08129990002', 'Teman', 'active');

insert into public.tax_rates (id, organization_id, name, rate_percent) values
  ('f1000000-0000-4000-8000-0000000000e1', 'f1000000-0000-4000-8000-000000000001', 'PPN', 11);
insert into public.packages (id, organization_id, name, total_sessions, price, currency) values
  ('f1000000-0000-4000-8000-0000000000f1', 'f1000000-0000-4000-8000-000000000001', 'Paket 4x', 4, 400000, 'IDR');

insert into public.invoices (id, organization_id, branch_id, customer_id, invoice_number, status, currency, subtotal, total, issued_at, due_at) values
  ('f1000000-0000-4000-8000-0000000000a1', 'f1000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-0000000000b1', ('f1000000-0000-4000-8000-' || lpad(to_hex(0x100001), 12, '0'))::uuid, 'RST-001', 'issued', 'IDR', 300000, 300000, '2026-09-05 03:00Z', '2026-09-20 03:00Z'),
  ('f1000000-0000-4000-8000-0000000000a2', 'f1000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-0000000000b2', ('f1000000-0000-4000-8000-' || lpad(to_hex(0x100002), 12, '0'))::uuid, 'RST-002', 'issued', 'IDR', 150000, 150000, '2026-09-06 03:00Z', null),
  ('f1000000-0000-4000-8000-0000000000a3', 'f1000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-0000000000b1', ('f1000000-0000-4000-8000-' || lpad(to_hex(0x100003), 12, '0'))::uuid, 'RST-003', 'issued', 'USD', 40, 40, '2026-09-07 03:00Z', null);
insert into public.payments (id, organization_id, branch_id, invoice_id, customer_id, method, amount, currency, status, paid_at) values
  ('f1000000-0000-4000-8000-0000000000c1', 'f1000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-0000000000b1', 'f1000000-0000-4000-8000-0000000000a1', ('f1000000-0000-4000-8000-' || lpad(to_hex(0x100001), 12, '0'))::uuid, 'cash', 200000, 'IDR', 'succeeded', '2026-09-08 03:00Z'),
  ('f1000000-0000-4000-8000-0000000000c2', 'f1000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-0000000000b2', 'f1000000-0000-4000-8000-0000000000a2', ('f1000000-0000-4000-8000-' || lpad(to_hex(0x100002), 12, '0'))::uuid, 'bank_transfer', 150000, 'IDR', 'succeeded', '2026-09-09 03:00Z'),
  ('f1000000-0000-4000-8000-0000000000c3', 'f1000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-0000000000b1', 'f1000000-0000-4000-8000-0000000000a3', ('f1000000-0000-4000-8000-' || lpad(to_hex(0x100003), 12, '0'))::uuid, 'card', 40, 'USD', 'succeeded', '2026-09-10 03:00Z');
insert into public.refunds (id, organization_id, payment_id, amount, status, refunded_at) values
  ('f1000000-0000-4000-8000-0000000000d1', 'f1000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-0000000000c1', 20000, 'succeeded', '2026-09-12 03:00Z');
insert into public.expenses (id, organization_id, branch_id, description, amount, currency, incurred_at) values
  ('f1000000-0000-4000-8000-0000000000e2', 'f1000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-0000000000b1', 'Listrik', 150000, 'IDR', '2026-09-11'),
  ('f1000000-0000-4000-8000-0000000000e3', 'f1000000-0000-4000-8000-000000000001', null, 'Sewa pusat', 900000, 'IDR', '2026-09-11');
insert into public.financial_ledger (organization_id, branch_id, entry_type, amount, currency, occurred_at) values
  ('f1000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-0000000000b1', 'payroll_paid', -500000, 'IDR', '2026-09-15 03:00Z');

-- The append-only history the restore must preserve exactly.
insert into public.cash_accounts (id, organization_id, branch_id, name, kind, currency) values
  ('f1000000-0000-4000-8000-0000000000c9', 'f1000000-0000-4000-8000-000000000001', null, 'Kas toko', 'cash', 'IDR'),
  ('f1000000-0000-4000-8000-0000000000ca', 'f1000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-0000000000b1', 'BCA North', 'bank', 'IDR');
insert into public.cash_movements (id, organization_id, account_id, kind, direction, amount, currency, occurred_on, counterparty, memo, reversal_of, request_key) values
  ('f1000000-0000-4000-8000-0000000000e4', 'f1000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-0000000000c9', 'opening_balance', 'in', 1000000, 'IDR', '2026-09-01', null, 'Saldo awal', null, 'f1000000-0000-4000-8000-0000000fa001'),
  ('f1000000-0000-4000-8000-0000000000e5', 'f1000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-0000000000c9', 'capital_contribution', 'in', 500000, 'IDR', '2026-09-02', 'Pemilik', null, null, 'f1000000-0000-4000-8000-0000000fa002');
insert into public.cash_movements (id, organization_id, account_id, kind, direction, amount, currency, occurred_on, counterparty, memo, reversal_of, request_key) values
  ('f1000000-0000-4000-8000-0000000000e6', 'f1000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-0000000000c9', 'reversal', 'out', 500000, 'IDR', '2026-09-03', 'Pemilik', 'Salah catat', 'f1000000-0000-4000-8000-0000000000e5', 'f1000000-0000-4000-8000-0000000fa003');
insert into public.marketing_spend_entries (id, organization_id, kind, source_key, source_label, spent_on, amount, currency, note, reversal_of, request_key) values
  ('f1000000-0000-4000-8000-0000000000f2', 'f1000000-0000-4000-8000-000000000001', 'spend', 'instagram', 'Instagram', '2026-09-03', 100000, 'IDR', 'Iklan minggu 1', null, 'f1000000-0000-4000-8000-0000000fb001'),
  ('f1000000-0000-4000-8000-0000000000f3', 'f1000000-0000-4000-8000-000000000001', 'spend', 'google', 'Google', '2026-09-04', 25, 'USD', null, null, 'f1000000-0000-4000-8000-0000000fb002');
insert into public.marketing_spend_entries (id, organization_id, kind, source_key, source_label, spent_on, amount, currency, note, reversal_of, request_key) values
  ('f1000000-0000-4000-8000-0000000000f4', 'f1000000-0000-4000-8000-000000000001', 'reversal', 'google', 'Google', '2026-09-04', 25, 'USD', 'Salah mata uang', 'f1000000-0000-4000-8000-0000000000f3', 'f1000000-0000-4000-8000-0000000fb003');
insert into public.cash_account_mappings (id, organization_id, flow, method, branch_id, account_id, effective_from, request_key) values
  ('f1000000-0000-4000-8000-0000000000f5', 'f1000000-0000-4000-8000-000000000001', 'payment', 'cash', null, 'f1000000-0000-4000-8000-0000000000c9', '2026-09-01', 'f1000000-0000-4000-8000-0000000fc001'),
  ('f1000000-0000-4000-8000-0000000000f6', 'f1000000-0000-4000-8000-000000000001', 'payment', 'bank_transfer', 'f1000000-0000-4000-8000-0000000000b1', 'f1000000-0000-4000-8000-0000000000ca', '2026-09-01', 'f1000000-0000-4000-8000-0000000fc002');
commit;
