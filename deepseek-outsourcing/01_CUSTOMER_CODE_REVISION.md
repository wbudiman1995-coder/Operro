# Assignment 01 revision — customer code

Revise the proposed customer-code patch in `reference/engine1-response.txt`. Return a complete replacement patch against Operro commit `8bef156aa745aa958c329adeae66b2cba7cf0ccf`; do not return a patch against your previous patch.

The persisted, tenant-scoped `CUST-NNN` design is accepted in principle, but the following corrections are mandatory:

1. **Caller-supplied codes must not bypass assignment.** Authenticated customer managers can reach customer inserts through existing paths. A caller must not be able to insert an arbitrary value, jump the sequence to `CUST-999999`, or race an automatically assigned value. For this pass, reject any non-null/nonblank caller-supplied `customer_code` and let the trigger own all assignment. Do not add an import escape hatch.
2. After deterministic backfill, enforce `customer_code NOT NULL` and a format constraint matching the chosen `CUST-[0-9]+` form. Backfill ordering must be exactly `(created_at, id)`; `created_at` is already non-null, so do not use `coalesce(created_at, now())`.
3. Preserve transaction-safe, per-organization monotonic allocation. Advisory locking is acceptable if the real two-session test proves it. Codes must never be reused after soft deletion and numbering in one tenant must not reveal another tenant's count.
4. Fix the proposed SQL test: it creates `CUST-001` in organization B and then incorrectly tries to insert `CUST-001` again into B while describing that as cross-organization reuse. Cross-tenant equality is already demonstrated when both organizations independently receive `CUST-001`. Replace the explicit-code tests with assertions that caller-supplied codes are rejected.
5. Add real role/RLS assertions using the supplied repository test patterns. Test an authorized customer manager, an unauthorized member, and cross-organization IDs. Superuser-only fixture inserts do not prove tenant isolation.
6. Add a genuine two-session concurrency test/harness: simultaneous inserts into the same organization must produce distinct consecutive codes; different organizations may both receive the same local code. A static regex assertion that `pg_advisory_xact_lock` exists is not concurrency evidence.
7. Complete every user-visible call site. Add the persisted code to `Customer360Header`. Replace all remaining UUID-derived `CUS-...` behavior in `invoice-workspace.ts` and update the invoice search placeholder. After the patch, a repository search for synthesized `CUS-` codes in application source must return none.
8. Ensure every affected query selects `customer_code`: CRM loader, Customer 360 loader, global search, both HomePaw exports, invoice customer rows, recent booking search, and manual-visit search. Reuse a customer-ID-to-code map rather than recomputing from UUIDs.
9. Keep codes out of pending onboarding submissions; assignment occurs only when an actual customer row is created. Do not modify historical booking, invoice, package, or payroll snapshots.
10. Update `run_all_gates.sh` and focused contract tests for the corrected behavior. Do not claim PostgreSQL, browser, typecheck, lint, or build results unless actually executed.

Migration version `20261022110000_customer_codes.sql` remains reserved for this feature. Do not use a different version and do not edit older migrations.

Return:

- Updated finding table.
- One complete unified Git patch relative to `operro/` containing every file, including new concurrency fixtures.
- Handoff with exact commands, raw results or explicit not-run status, security analysis, populated-upgrade expectations, and browser QC checklist.

Do not work on CRM bulk editing or customer/pet editing in this revision.
