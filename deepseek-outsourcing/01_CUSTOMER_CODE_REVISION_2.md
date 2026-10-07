# Assignment 01 — revision 2: make the customer-code submission integrable

Revise your latest customer-code response. Return a complete replacement submission against Operro commit `8bef156aa745aa958c329adeae66b2cba7cf0ccf`; do not return a patch against either of your earlier proposed patches.

The overall persisted, tenant-scoped `CUST-NNN` design and the proposed user-facing call sites remain accepted in principle. Codex review rejected the latest submission because it cannot be applied safely and contains a boundary defect. Fix every item below without expanding into CRM bulk editing, customer/pet editing, or custom fields.

## Mandatory corrections

1. **Return a mechanically valid, complete patch.** The submitted diff is corrupt: 27 of 35 hunk headers report incorrect old/new line counts. `git apply --check --recount` still fails against the supplied commit. The `customer-database.tsx` removal/addition line is truncated after the changed cell instead of containing the complete original one-line JSX statement. Do not abbreviate, elide, wrap, or truncate any diff line. Generate the final diff from actual complete files if possible. Your handoff must report the exact result of `git apply --check`; if you cannot run it, explicitly say it was not run and also return the complete contents of every changed/new file in clearly named code blocks as a fallback.
2. **Do not truncate codes after 999.** PostgreSQL `lpad('1000', 3, '0')` returns `100`, which collides with `CUST-100`. Both the backfill and insert allocator must pad to a *minimum* width of three while preserving all digits, so sequence 999 is followed by `CUST-1000`. Use `bigint` for the parsed/next numeric value. Add a real SQL regression assertion for the 999→1000 boundary; a regex-only TypeScript assertion is insufficient.
3. **Add a genuine populated-upgrade regression.** Build a disposable pre-migration state with multiple existing customers in at least two organizations, including tied `created_at` values, apply `20261022110000_customer_codes.sql`, and assert deterministic `(created_at, id)` ordering, per-org restart at `CUST-001`, `NOT NULL`, uniqueness, preserved soft-deleted reservations, and unchanged booking/invoice/package/payroll data. Reuse the repository's PostgreSQL 16/bootstrap patterns. Do not edit an older migration.
4. **Strengthen cross-tenant RLS proof.** The proposed smoke test checks an org-B read of org A but does not attempt a cross-org write. As an authenticated org-B principal, attempt an insert or update using org A's ID and assert SQLSTATE `42501`; then verify as the fixture owner that org A was unchanged. Keep the authorized manager and read-only helper cases.
5. **Make the concurrency gate portable in this repository.** Windows checkouts use `core.autocrlf=true`, and the existing Gate 8 copies shell fixtures to a temporary directory and strips `\r` before running them. Follow that established pattern for the new harness, including cleanup and `run_as_postgres`/connection handling. Do not invoke a newly checked-out `.sh` directly in a way that can fail solely because it has CRLF endings.
6. **Actually wire the focused contract test into validation.** `apps/web/test/customer-code-contract.test.ts` was created but the proposed full gate never executes it. Add an explicit focused-test command to the gate or an existing invoked script. Update the existing search/profile test where appropriate rather than relying only on source-text regex checks.
7. **Keep documentation accurate.** Update `search.ts` comments that currently describe two customer result sets so they describe name, phone, and code. Preserve the existing safe bound `.ilike()` approach and organization filter.
8. **Preserve all prior revision requirements.** Caller-supplied nonblank codes must be rejected; empty/whitespace values may be treated as absent. Codes remain immutable, unique per organization, reserved after soft deletion, assigned only when a real customer row is created, and must not modify historical booking/invoice/package/payroll snapshots. All listed UI/search/export/invoice call sites must use the persisted code, with no synthesized UUID-derived `CUS-...` left in application source.

## Required response

Return, in this order:

1. A short correction table mapping each mandatory item above to exact files/tests.
2. One complete unified Git patch relative to `operro/`, with valid hunk counts and no truncated lines.
3. As a fallback after the patch, complete contents of every changed or new file, each under its exact repository path. This fallback is mandatory if you could not run `git apply --check` yourself.
4. Raw validation results. Never claim PostgreSQL, concurrency, typecheck, lint, build, browser, or `git apply --check` success unless actually executed.
5. Updated populated-upgrade and browser-QC checklists.

Migration version `20261022110000_customer_codes.sql` remains reserved. Do not change that version, edit older migrations, deploy, or touch production.
