# Operational/platform HomePaw parity quick wins

- Reviewed: 5 October 2026
- Combined branch: `codex/homepaw-parity-reviewed`
- Combined base: `7f12316` (reviewed customer-code quick win)
- Engine 2 source reviewed: `b5ef95d` from `claude/parity-ops-quickwins`

This review covers parity sections #31, #34, #36, #37, #38, #39, #41, #43 and #44. The Engine 2 commit was not accepted verbatim: its #41 expectation predated `20261022100000_platform_owner_workspace_access.sql`, its SQL fixture did not run against the repository's minimal Auth gate schema, and its finance pagination could silently stop at 200 rows.

## Status table

| # | Area | Existing/current behavior | Remaining gap | Size/risk |
|---|---|---|---|---|
| 31 | Financial operations | Payment register, expenses/refunds, and now a permission-checked XLSX containing the filtered payment register plus a clearly labeled all-expenses sheet | No complete capital/cash-on-hand workflow or broader accounting export suite | MEDIUM/LARGE; accounting definitions and refund treatment must be agreed first |
| 34 | WhatsApp center | Per-record invoice/follow-up drafts and editable templates | No unified batch delivery center or delivery log | LARGE; requires consent, provider, rate-limit, delivery-state and audit decisions |
| 36 | Audit history | Existing immutable audit store/RPC, Customer timeline, and now labeled invoice actor/change history | No filtered cross-entity review workspace | MEDIUM; current change is honestly invoice-scoped |
| 37 | Operational reconciliation | Package/session reconciliation | No unified visit/invoice/payment/payroll discrepancy view | LARGE; should begin read-only and never auto-repair history |
| 38 | Export/ownership | CRM, payroll, complaints and finance data exports | No restorable organization archive containing configuration and real Storage objects | LARGE; cannot be called a backup until restore is proven |
| 39 | Business configuration | Branding, banks, service areas and access controls | Remaining HomePaw settings are not consolidated or all behaviorally verified | SMALL/MEDIUM per validated setting |
| 41 | Accounts/permissions | Business owner and Operro platform owner can manage the Admin checklist; tenant Admin cannot; `Bantuan Operro` is barred from payroll and finance | Live multi-organization invitation/role QC remains | QC; server/RLS contract is now executable in the full gate |
| 43 | Storage/maintenance | Organization file meter, whole-project database meter, cleanup and manual requests | No defensible per-organization database-byte accounting, scheduled cleanup or automated billing | LARGE; provider usage must not be misrepresented |
| 44 | Reliability/safeguards | RLS, immutable financial snapshots, audit history and migration/test gates | Monitoring/recovery UI and real recovery exercises remain | MEDIUM/LARGE; define alert ownership and recovery objectives first |

## Completed changes

### #31 — filtered finance XLSX

- Added `/finance/export`, deriving the active organization server-side and requiring `finance.read` before any data load.
- Carries the payment register's current `stage`, `month` and search filters; invalid stage/month parameters return `400` instead of unexpectedly exporting unfiltered data.
- Reuses the existing keyset-paginated `loadPaymentRegister` path. It requests 199 rows because the underlying RPC's 200-row ceiling must leave one sentinel row for `hasMore` detection.
- Fails explicitly on a missing cursor or after the 100-page bound instead of silently returning an incomplete workbook.
- Adds currency columns for both payments and expenses. Payment currencies are looked up by the already-authorized payment IDs with an explicit organization predicate.
- Labels the expense sheet `Pengeluaran - Semua` so users do not mistake payment-register filters for expense filters.
- Centralizes spreadsheet-cell safety: formula-like strings are prefixed while numbers remain numeric Excel cells.

### #36 — invoice audit history

- Uses the existing `app.list_audit_events` RPC; no duplicate audit storage or new migration was introduced.
- Adds Indonesian action labels, actor resolution, owner-facing invoice-field labels, and a printable-page-safe history panel on invoice detail.
- Keeps the claim limited to invoice history. A broader cross-entity audit viewer remains deferred.

### #41 — corrected server/RLS verification

- Corrected Engine 2's obsolete rule: the current Operro platform owner is intentionally allowed to inspect and repair the Admin checklist.
- The SQL test proves a real business owner can set/read the checklist, tenant Admin cannot set or read the access payload, and the Operro platform owner can set/read it.
- The same test provisions a real `Bantuan Operro` role, verifies it lacks `payroll.read` and `finance.read`, and proves payroll RLS returns no seeded payroll rows.
- Added a separate authenticated audit-RPC test proving each organization can read only its own invoice audit event and that entity-table filtering is enforced.

## Deferred work

- #34: no automatic or batch WhatsApp sending was added.
- #37: no reconciliation engine or automatic financial repair was added.
- #38: no "backup" claim was made without a restore drill.
- #39: no settings checkbox was added without first finding its authoritative persisted field and runtime consumer.
- #43: no per-tenant database-cost estimate was invented from whole-project metrics.
- #44: no monitoring dashboard was added without alert ownership, retention and recovery acceptance criteria.

The next smallest safe task is an authenticated browser QC pass using disposable data: export a filtered workbook and inspect its two sheets in Excel, then mutate a disposable invoice and verify the audit actor/action/field labels. This is validation, not a production invitation or invoice.

## Files changed by the Engine 2 integration

- `apps/web/src/app/finance/export/route.ts`
- `apps/web/src/app/finance/page.tsx`
- `apps/web/src/app/invoices/[invoiceId]/page.tsx`
- `apps/web/src/components/audit-history-panel.tsx`
- `apps/web/src/lib/audit-diff.ts`
- `apps/web/src/lib/audit-events.ts`
- `apps/web/src/lib/finance-export.ts`
- `apps/web/src/lib/finance-export-pagination.ts`
- `apps/web/src/lib/homepaw-export.ts`
- `apps/web/src/lib/spreadsheet-safe.ts`
- `apps/web/test/audit-diff.test.ts`
- `apps/web/test/finance-export.test.ts`
- `supabase/tests/20261021100000_test_business_admin_checklist_isolation.sql`
- `supabase/tests/20261021110000_test_audit_event_access.sql`
- `docs/HOMEPAW_PARITY_AUDIT_2026-10-01.md`
- `run_all_gates.sh`

## Validation

- Focused web tests: PASS, 30 tests, 0 failures.
- Root/web TypeScript typecheck: PASS, exit 0.
- Web ESLint with zero warnings allowed: PASS, exit 0.
- PostgreSQL 16 fresh replay: PASS, 74 forward migrations.
- #41 server/RLS test: PASS, nine assertions covering owner, tenant Admin, platform owner and `Bantuan Operro`.
- Audit RPC tenant-isolation test: PASS, four assertions.
- Gate shell syntax after normalizing Windows working-copy line endings: PASS.
- Production web build: PASS; 41 routes, including `/finance/export`.
- `git diff --check`: PASS; only Windows line-ending conversion warnings were emitted.

Browser-tested: **no**. No production Supabase, Vercel deployment, real invitation, real invoice, PR or remote branch was changed by this review.
