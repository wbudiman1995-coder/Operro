# Dynamic size bands, Bundle 4: payroll (SB-06)

Base: `codex/parity-orchestration` after `95ab4bd`. Forward-only migration `20261027100000_size_band_payroll.sql`; no accepted migration was edited. Nothing was deployed, pushed or committed; no remote Supabase/Vercel was touched.

## Decision O4 as implemented

- **New / unpaid / recomputed payroll** resolves each dog's size server-side through the existing authoritative path `app.pet_pricing_key` (weight -> active band; stored size only when it is an active band). `app.payroll_pet_size_key` is a one-line wrapper that keeps the existing payroll semantics: dogs only; cats, custom species and unmeasured dogs with no active stored size have no payroll size and use the flat rate.
- **Approved / paid runs are never recalculated.** `compute_payroll_item` is only reached by the draft-only `recompute_payroll_run`, and that function (unchanged) refuses non-draft runs. The migration contains no `update`/`delete`/`insert` against payroll, booking, invoice, package or pet rows.
- **No `payroll_size_source` setting** was added: the task fixed O4 to live sizing for drafts + frozen results afterwards, so a per-org switch would be unused scope.
- New drafts carry an additive `perDogDetail` array `[{key,label,count,rate,amount}]` inside the frozen breakdown, so a paid result keeps the key/label/rate it was calculated with after a later re-band, rename or archive. Existing breakdown keys and `calculationVersion` are unchanged.

## Matrix validation

- `trg_pcs_validate_size_matrix` / `trg_sps_validate_size_matrix` (insert, or update of the matrix column): a key may be **added or its rate changed** only for an *active dog band of the row's own organization*; rates must be numbers >= 0 (a `null` entry still means "use the flat rate").
- A key whose value is unchanged from the stored row is accepted (grandfathered), so unrelated saves, an upsert of an unchanged matrix and organizations that later archived a band are never broken, and no stored matrix is rewritten.
- The server action loads the caller's organization bands (RLS-scoped, organization from the auth context, never the form), validates the same rule for friendly Indonesian errors, and the trigger re-validates. Blank fields are still omitted, an empty staff matrix is still SQL `NULL` (inherit), and a staff matrix still replaces the organization matrix as a whole.

## Export detail

`payroll_export_detail_rows` now returns `pet_size`/`pet_size_label` (live key + current tenant label, what payroll uses) and `service_size_key`/`service_size_label` (size recorded on the booking line when it was priced; older lines show their key's band label). The XLSX "Ukuran" column shows the label; a new last column "Ukuran saat layanan" shows the booking-line size. Invoice PDFs and the payslip PDF are untouched.

## Hardening that was not asked for explicitly

`compute_payroll_item`, `payroll_eligible_pets` and `payroll_transport_shares` were `security definer` and executable by `authenticated` with a caller-supplied organization id and no check. They are only called from definer code, so direct client EXECUTE is revoked. `payroll_export_detail_rows` (the only one the web app calls) now checks the active organization, membership, the `payroll` module and `payroll.read`. `payroll_missing_invoice_pets`, `payroll_cycle_bounds` and `payroll_working_day_stats` have the same pre-existing gap and were left alone (out of scope).

## Verification

See the session report for exact commands and results. Run `integration/size_band_payroll_smoke.sql` (GATE 7m), the extended `supabase/tests/20261001100000_test_payroll_engine.sql` (GATE 6b), the populated-upgrade rehearsal (`integration/run_populated_upgrade_rehearsal.sh`; log `docs/handoffs/logs/INTEGRATION/sb06-populated-upgrade.log`) and `apps/web/test/payroll-dynamic-size.test.ts`.

## Deferred

Browser QC of the payroll settings form, staff card and exported workbook; showing `perDogDetail` on the staff "Gaji saya" card and payslip PDF; guards on the remaining unguarded payroll read helpers.
