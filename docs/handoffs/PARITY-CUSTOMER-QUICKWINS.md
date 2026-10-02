# Customer-facing HomePaw parity quick win

Date: 2 October 2026  
Branch/worktree base: `8bef156aa745aa958c329adeae66b2cba7cf0ccf`  
Scope reviewed: audit sections #1, #2, #3, #4, #40 and #42.

## Review status

| Section | Existing Operro behavior | Remaining HomePaw gap | Assessment |
|---|---|---|---|
| #1 Dashboard analytics | Dashboard route and current operating cards | Period comparison, richer cards and acquisition ROI | LARGE; requires metric definitions and authoritative data queries |
| #2 Customer CRM | Search/filter/sort, onboarding, Customer 360 and XLSX exports | Bulk edit | LARGE; needs selection UX, server-side authorization and per-row failure semantics |
| #3 Customer 360 | Address, pets, history, invoices, packages, and now the persisted customer code | Owner editing and configurable fields | LARGE; overlaps #40 and needs guarded mutations |
| #4 Pet database | Multi-pet intake, pet records and size logic | Standalone full CRUD, coat profile and wash counter | LARGE; schema, UI and historical semantics are not a quick win |
| #40 Custom fields | Metadata can carry extension data | Owner-defined field definitions, validation and editors | LARGE; a generic field framework was deliberately not started |
| #42 Personal preferences | No dedicated preference model | Per-user landing, calendar, dashboard and language preferences | LARGE; needs a preference contract and precedence rules |

## Completed change

Implemented one complete improvement for #2/#3: stable, tenant-scoped customer codes.

- Added `customers.customer_code`, deterministically backfilled per organization by `(created_at, id)`.
- Codes are generated as `CUST-NNN`, continue safely beyond `CUST-999`, are unique within an organization, and remain reserved for soft-deleted customers.
- A database trigger assigns codes under an organization-scoped transaction advisory lock. Callers cannot choose a nonblank code, and assigned codes are immutable.
- Replaced UUID-derived `CUS-...` labels in the customer list, Customer 360, global search, invoice creation search, and both CRM exports.
- Added real PostgreSQL tests for allocation, immutability, soft-delete reservation, the `999 -> 1000` boundary, authenticated RLS isolation, and concurrent inserts.
- Added a populated-upgrade regression with three organizations and representative booking, invoice, package-ledger and payroll history. The test verifies a combined pre/post JSON row hash.
- Updated the full gate script and parity audit to track the migration and focused regressions.

## Deliberately deferred

No dashboard analytics engine, CRM bulk mutation flow, generic custom-field framework, standalone pet-management rewrite, or preferences subsystem was started. Each would cross several schema, authorization, UI and migration boundaries and cannot be completed safely as a second quick edit.

The next smallest useful task is a guarded Customer 360 edit flow for the existing customer fields (name, phone, email, source and notes), reusing current organization capability checks and audit conventions. Keep custom fields out of that first slice.

## Files changed

- `supabase/migrations/20261022110000_customer_codes.sql`
- `supabase/tests/20261022110000_test_customer_code.sql`
- `supabase/tests/customer_code/*`
- `integration/customer_code_populated_upgrade.sh`
- `apps/web/src/lib/pilot-data.ts`
- `apps/web/src/lib/customer-360.ts`
- `apps/web/src/lib/search.ts`
- `apps/web/src/lib/homepaw-export.ts`
- `apps/web/src/lib/invoice-workspace.ts`
- `apps/web/src/components/customer-database.tsx`
- `apps/web/src/components/customer-360.tsx`
- `apps/web/src/components/invoice-studio.tsx`
- `apps/web/test/customer-code-contract.test.ts`
- `apps/web/test/search-and-profile.test.ts`
- `run_all_gates.sh`
- `docs/HOMEPAW_PARITY_AUDIT_2026-10-01.md`

## Validation results

- Focused web tests: PASS, 22 tests, 0 failures.
- Web/root TypeScript typecheck: PASS, exit 0.
- Web ESLint with zero warnings allowed: PASS, exit 0.
- Shell syntax for the new upgrade/concurrency scripts and full gate: PASS, exit 0.
- PostgreSQL 16 fresh migration replay through `20261022110000`: PASS.
- PostgreSQL customer-code contract SQL: PASS (`CUSTOMER CODE CONTRACT PASS`).
- Authenticated RLS test: PASS (`CUSTOMER CODE RLS PASS`). It covers an authorized manager, a read-only member, cross-organization invisibility/write denial, and fixture-owner verification that the rejected write changed nothing.
- PostgreSQL concurrency test: PASS (`CUSTOMER CODE CONCURRENCY PASS`) for same-organization serialization and independent organizations.
- PostgreSQL populated upgrade: PASS (`CUSTOMER CODE POPULATED UPGRADE PASS`), history hash `9f74c0d586b9973c536afd860d6e47cb` unchanged.
- Web production build: PASS, all 40 static/dynamic routes compiled.
- `git diff --check`: PASS; Git emitted only the repository's Windows line-ending conversion warnings.

## Browser verification

Not browser-tested. Owner-facing propagation is covered by loader/component contract tests, TypeScript, lint and the production build, but live Customer list, Customer 360, global search, invoice picker and XLSX downloads still need one authenticated browser QC pass against disposable data before claiming live workflow completion.
