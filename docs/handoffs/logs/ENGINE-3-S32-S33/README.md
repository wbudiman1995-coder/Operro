# Engine 3 (S32-S33) evidence log

## samples/

Real files produced by the actual export builders (`apps/web/src/lib/payroll-export.ts`
`buildPayrollWorkbook` / `buildPayrollCsv` / `buildPayslipPdf`), not hand-crafted or renamed —
verified with `file(1)`:

- `sample_payroll_cycle_export.xlsx` — `Microsoft Excel 2007+` (real OOXML/ZIP, magic bytes
  `50 4b 03 04`). Summary / Detail Job / Missing & Review sheets.
- `sample_payroll_cycle_export.csv` — `CSV ASCII text`.
- `sample_payslip.pdf` — `PDF document, version 1.3, 1 page(s)` (magic bytes `%PDF-1.3`).

Generated from a fixed, hand-built `PayrollExportData` object matching the actual QA-seed
groomer's real paid-cycle numbers verified earlier in this session (basic 3,000,000 + no-late
300,000 + no-sick 300,000 = 3,600,000 total, status PAID), via a throwaway `tsx` script run
directly against `payroll-export.ts` (not through the Next.js dev server) — the script and its
`server-only` module shim were deleted immediately after; they are reproducible by writing an
equivalent script if needed, not by re-running anything committed here.

**These same three formats were ALSO independently verified live through the real dev server**
in this session (not just this offline generation): `fetch()` calls from an authenticated browser
session against `GET /payroll/export?format=xlsx|csv|pdf` all returned 200 with matching magic
bytes, correct `Content-Type`/`Content-Disposition` headers, and — for the CSV — a data row that
matched the on-screen UI numbers and the `GATE 6b` psql-level numbers exactly. See
`docs/handoffs/ENGINE-3-S32-S33-HANDOFF.md` Section 6/9 checkpoint notes for that verification's
narrative and exact byte counts/timestamps.

## Reproducing the deterministic calculation-engine test evidence

The authoritative, independently-computed-expected-values test suite lives at
`supabase/tests/20261001100000_test_payroll_engine.sql` (33 assertions covering styling tiers,
botak stacking, the transport-split bugfix, per-pet size matrix, the full lifecycle, retention,
and cross-tenant isolation) and is registered as `GATE 6b` in `run_all_gates.sh`. Run it against
any Postgres 16+ instance with all migrations through `20261001120000` applied:

```
psql -v ON_ERROR_STOP=1 -f supabase/tests/20261001100000_test_payroll_engine.sql
```

It wraps its entire fixture in `begin;...rollback;`, so it never persists data — safe to run
against any disposable database repeatedly.

## Not included here

Browser screenshots are not saved as files in this log — this session's browser tool returns
screenshots inline to the assistant, with no file-system bridge to save them into the repo. The
handoff document's Section 6/9 narrates each verified browser interaction (page renders, button
clicks, resulting state) in enough detail to reproduce; a future session with screenshot-saving
capability should add real PNGs here for the four still-open Section 8/Checkpoint-4 items
(mobile 375px, retention boundary UI, cross-tenant UI, the two self-review passes).
