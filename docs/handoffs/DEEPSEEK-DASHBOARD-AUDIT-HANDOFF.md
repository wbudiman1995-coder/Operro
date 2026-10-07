# DeepSeek dashboard comparison and audit-visibility handoff

Date: 7 October 2026 (Asia/Jakarta)

## Base and scope

- Branch: `codex/parity-orchestration`
- Base commit: `95ab4bddea34397975961ca956b533b4ec739c33`
- Audit sections reviewed: #1 Dashboard analytics and #36 Audit history.
- Honest status after this slice: both remain **Partial**. The dashboard now has a bounded day-over-day comparison, but configurable cards and acquisition ROI remain absent. Audit history now has clearer invoice/customer review surfaces, but there is still no cross-entity audit register or filters.
- No commit, deployment, remote database action, or migration was created. Accepted `20261023*` migrations were not touched.

## Evidence before changes

- `apps/web/src/components/dashboard-shell.tsx` showed only current-day values and unconditional cards/quick links.
- `apps/web/src/lib/pilot-data.ts::loadDashboardData` queried bookings, payments, customers, tasks, and upcoming bookings for every dashboard caller. It was tenant-filtered but did not apply server-resolved branch grants or capability-specific query denial.
- Revenue already had one authoritative definition: succeeded `payments` plus active `visit_manual_billing`. No ROI or profit source exists.
- `app.list_audit_events` was already tenant-scoped by active organization and entity id; the frontend used it only on invoice detail.
- Customer 360 already had a read-only operational timeline but still stated that database audit history was not exposed.

## Changes made

- Added `apps/web/src/lib/dashboard-read-model.ts` with a pure capability/branch read plan, branch-timezone day boundaries, persisted-amount summing, and comparison direction.
- Extended `loadDashboardData` to:
  - fetch today and yesterday bookings/revenue;
  - query a domain only when its capability is granted;
  - apply exact server-resolved branch ids to branch-owned tables;
  - return `null` for restricted metrics rather than a misleading zero;
  - retain the existing missing-manual-billing warning and never infer revenue from invoices, catalog prices, or booking snapshots.
- Updated `/dashboard` to resolve branch grants and an accessible reporting timezone server-side.
- Updated dashboard cards, upcoming bookings, and quick actions to render capability-aware restricted/empty states. Added a finance-authorized review link to the existing invoice/audit path.
- Reused `AuditHistoryPanel` for Customer 360 History after `customer.read` authorization and added customer-facing audit field labels. Invoice detail now shows an explicit empty audit state instead of silently hiding the panel.
- Ignored audit metadata (`created_at/by`, `updated_at/by`) in owner-facing changed-field labels.

## Files in this slice

- `apps/web/src/app/dashboard/page.tsx`
- `apps/web/src/components/dashboard-shell.tsx`
- `apps/web/src/lib/dashboard-read-model.ts` (new)
- `apps/web/src/lib/pilot-data.ts`
- `apps/web/src/components/audit-history-panel.tsx`
- `apps/web/src/lib/audit-diff.ts`
- `apps/web/src/lib/customer-360.ts` (History capability mapping only for this slice)
- `apps/web/src/app/customers/[customerId]/page.tsx` (audit review integration only for this slice)
- `apps/web/src/app/invoices/[invoiceId]/page.tsx`
- `apps/web/test/dashboard-read-model.test.ts` (new)
- `apps/web/test/audit-diff.test.ts`

The shared tree acquired concurrent customer/pet-edit changes in the same Customer 360 files during verification. They were preserved and are not part of this slice.

## Verification

### Passed

- `npm exec --workspace apps/web -- tsx --test test/dashboard-read-model.test.ts test/audit-diff.test.ts`
  - 10 tests, 10 passed, 0 failed.
  - Covers capability denial, exact branch grants, tenant query filters, persisted-only revenue, timezone boundaries, audit field labels, and the Customer 360 audit gate.
- Latest focused rerun used `node ../../node_modules/tsx/dist/cli.mjs --test test/dashboard-read-model.test.ts test/audit-diff.test.ts` after the shared `.bin` directory disappeared: 10 tests, 10 passed, 0 failed.
- `npm run typecheck --workspace apps/web`
  - Passed before the concurrent customer/pet test appeared in the shared tree.
- `npm run lint --workspace apps/web -- --max-warnings=0`
  - Passed after removing the stale `Link` import left by the concurrent Customer 360 edit and before the shared dependency tree became incomplete.
- `git diff --check -- <slice files>`
  - Passed (only Git CRLF conversion notices).
- `npm run build --workspace apps/web`
  - Next.js compilation passed in 4.9 seconds.

### Blocked or not run

- A later full typecheck and the build's TypeScript phase failed in the unrelated, concurrently added `apps/web/test/customer-pet-edit.test.ts:58` because a union containing optional `undefined` fields was passed to `Record<string, string | string[] | Blob>`. This slice did not modify that test.
- During the final rerun, the shared `node_modules/.bin` directory and parts of installed packages disappeared. A lockfile-disabled restore (`npm install --package-lock=false --ignore-scripts --no-audit --no-fund`) failed with Windows `ENOTEMPTY`/`EPERM` on in-use dependency directories. Focused tests remained runnable and passed via the direct `tsx` entrypoint, but the latest lint/typecheck could not be treated as valid because ESLint/Next dependencies were incomplete. No package manifest or lockfile changed.
- Database audit-isolation test `supabase/tests/20261021110000_test_audit_event_access.sql` was inspected and already asserts cross-tenant denial, but could not be rerun because Docker is not installed/available on this host.
- Browser QC was not run. Still required: owner with all branches, a branch-restricted role, a role without `finance.read`, and Customer 360 History with and without `customer.read`.

## Security and truthfulness notes

- Organization id comes from `requireActiveWorkspace`; branch ids come from `loadBranchAccess`. Browser input is not used for either scope.
- Restricted metrics are `null` and render as restricted, not as zero.
- Revenue is only the sum of persisted succeeded payments and active manual-billing rows. Missing manual-billing storage produces an explicit incomplete warning.
- No financial, invoice, package, payroll, or audit history is mutated.

## Deferred next work

- Configurable dashboard-card preferences need an approved, user-and-tenant-safe preference model.
- Acquisition ROI needs an agreed cost source and attribution rules; customer `source` alone is insufficient and no value should be invented.
- Cross-entity audit review needs a separately designed, bounded RPC with entity filters and capability mapping.
- Browser role/branch QC should be completed after the concurrent Customer 360 work restores a green shared-tree typecheck/build.
