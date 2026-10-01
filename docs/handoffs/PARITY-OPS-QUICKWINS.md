# Operro ↔ HomePaw parity — operational/platform quick-wins

Branch `claude/parity-ops-quickwins`, from `b69f8a2` in an isolated worktree. Assigned sections: #31 finance, #34 WhatsApp center, #36 audit history, #37 operational reconciliation, #38 export/ownership, #39 business configuration, #41 accounts/permissions, #43 storage/maintenance, #44 reliability.

## Method

Read `apps/web/AGENTS.md` (boilerplate, no action), `docs/HOMEPAW_PARITY_AUDIT_2026-10-01.md` (the gap table), the relevant Operro routes/RPCs for each section, and bounded excerpts of `C:\Users\DW_wi\Downloads\index (2).html` (HomePaw reference) by grepping for each feature (capital/kas, blast/broadcast, audit_log, rekonsiliasi, backup/export, konfigurasi, admin access, storage/database size) and reading only the matching regions. No full-file read of either side.

## Nine-row gap table

| # | Section | Existing Operro behavior | HomePaw comparison (from index(2).html) | Risk | Estimate |
|---|---|---|---|---|---|
| 31 | Finance | `/finance`: paginated payment register (`app.search_payment_register`) + expenses; **now has an XLSX export** of the same filtered register + expenses | HomePaw has no capital/cash-on-hand dashboard either (no match for "capital/modal/kas"). Its gap was narrower than the audit implied: no export existed at all for finance. Closed for payment register + expenses this pass. | Low | **SMALL — done** |
| 34 | WhatsApp center | Invoice/follow-up/reminder `wa.me` deep links with editable templates in Settings | HomePaw has the identical architecture: every WA send is a per-record `wa.me`/`api.whatsapp.com` link built from an editable template (`cfg-wa-done`, `cfg-wa-invoice`, `cfg-wa-followup`, `cfg-wa-renewal`, `cfg-wa-onboarding`). No `blast`/`broadcast` code anywhere, no delivery log, no batch send — confirmed by grep, zero matches. A "unified batch messaging center" would exceed HomePaw itself, not match it. | Low | **LARGE if ever pursued — explicitly not attempted; see "Deferred work"** |
| 36 | Audit history | `public.timeline_events` (narrative) for Customer 360; `app.list_audit_events` RPC existed since `20260910120000_audit_log_read_api.sql` with **zero call sites** anywhere in `apps/web/src` | HomePaw's own audit view is a flat admin-only table dump of `audit_log` rows with raw JSON diff and a manual "delete audit rows older than N months" control — no per-action labels, no actor resolution shown in that list. **Now wired** into the invoice detail page: translated action labels (Dibuat/Diperbarui/Dihapus), resolved actor name, and a list of just the fields that actually changed. | Low | **SMALL — done** |
| 37 | Operational reconciliation | Package/session reconciliation only (`openSubsReconcile`, review-then-apply, never auto-writes) | HomePaw has the exact same narrow scope — only subscription/session reconciliation, no visit/invoice/payroll cross-check. A real unified reconciliation engine is net-new for **both** products, not a parity gap. | Medium if built wrong (financial correctness) | **LARGE — not attempted.** Acceptance test if pursued later: for a fixed org + month, a reconciliation view must list every `visits` row with `status='completed'` lacking a matching non-void `invoices` row, every `invoices` row with `status='issued'` and no matching `payments` summing to its `total`, and every published `payroll_items` row whose source `bookings`/`manual_visits` row no longer exists or was voided after publish — sourced directly from those four tables, not recomputed derived figures. |
| 38 | Export/ownership | 8-sheet CRM XLSX (`homepaw-export.ts`), payroll XLSX/CSV, complaint CSV, **now finance XLSX** | HomePaw's "Export Semua" (`exportAllSheets`) is also just a flat all-tables-to-XLSX dump — no Storage files, no `business_settings`/config, no bucket contents. A true organization-wide backup (files + configuration) is new ground for both products. | Medium (data-loss exposure if promised but not delivered) | **LARGE — not attempted.** Acceptance test if pursued: a backup job must produce one archive containing (a) every `*_export*`-style table dump already covered by existing exporters, (b) every object under the org's Storage buckets (`grooming-photos`, `attachments`, style refs) by real key listing, not an estimate, and (c) a serialized `business_settings`/`organizations` config row — restorable by re-running the forward migrations against an empty project and replaying the archive, proven once end-to-end on a disposable Supabase project. |
| 39 | Business configuration | Branding, banks, service areas, access controls (confirmed existing) | HomePaw's single Settings screen additionally exposes: dashboard-card visibility toggles, toast-notification duration, an auto-log-visit checkbox, and five directly-editable WA templates (done/invoice/followup/renewal/onboarding) with token legends shown inline. Operro's equivalents are scattered or partially present; not all are in one exposed settings surface. | Low per item | **SMALL per item, but bundling is a separate pass — not attempted this round** (budget was two improvements; #31 and #36 were chosen as higher-value). |
| 41 | Accounts/permissions | Owner-settable, granular Admin permission checklist (`app.set_business_admin_permissions` / `app.list_organization_access`), gated by `app.is_business_owner_member` which explicitly excludes the Operro platform owner (`20261020100000_legacy_org_access_roles.sql`, superseding the broader `is_business_owner` gate in `20261019100000_platform_org_access.sql`) | HomePaw has only a **binary** `owner`/`admin` role — no granular per-permission checklist exists there at all (`setRole`, "Jadikan OWNER (akses penuh)" vs plain "admin"). Operro already exceeds HomePaw here; this was a verification task, not a feature gap. | Low | **SMALL — server-layer behavior confirmed by code tracing + a new SQL test (see Validation below); the test was NOT executed in this environment — disclosed, not claimed as passing.** |
| 43 | Storage/maintenance | Org file meter, platform-wide `pg_database_size` meter, cleanup + manual capacity requests (confirmed existing) | HomePaw's own DB/storage "meter" is a **cruder, single-tenant** heuristic (~2KB/appointment, ~3KB/invoice, etc., counted against the one Supabase project HomePaw owns) — it has no multi-tenant concept at all, because HomePaw is deployed one-business-per-project. Real per-org database-byte accounting has no HomePaw equivalent to copy against; it's a new multi-tenant capability for Operro specifically. | Medium (billing/cost accuracy if ever exposed to tenants) | **LARGE — not attempted.** Data source if pursued: `pg_total_relation_size` summed per table scoped by `organization_id` via a `SECURITY DEFINER` RPC (no existing per-tenant byte accounting exists to reuse), since `pg_database_size` is necessarily whole-project. |
| 44 | Reliability/safeguards | RLS, audit trail, financial snapshots, migration/test gates (confirmed existing, per prior engines' handoffs) | No code gap found in this pass; the audit doc's remaining item is live QC of real-world workflows and monitoring UI, not a missing capability. No change made. | Low | **N/A — reviewed only, no HomePaw comparison gap identified.** |

## Implemented this pass (exactly two)

### 1. Finance export (#31)
- [finance-export.ts](../../apps/web/src/lib/finance-export.ts): `buildFinanceExport` — loops the **existing** `loadPaymentRegister` (same RPC-backed loader the on-screen register uses) across pages until exhausted, plus `getAll(..., "expenses", ...)` reused from `homepaw-export.ts`. Two sheets: *Pembayaran*, *Pengeluaran*.
- [homepaw-export.ts](../../apps/web/src/lib/homepaw-export.ts): exported `getAll` and `sheet` (were module-private) so `finance-export.ts` could reuse them instead of duplicating the ExcelJS/formula-injection-guard pattern a third time.
- [finance/export/route.ts](../../apps/web/src/app/finance/export/route.ts): `GET` route, `?stage&month&q` mirror the on-screen filters, gated by `workspace.capabilities["finance.read"]` (server-side — this is the real check; the UI link is just a convenience).
- [finance/page.tsx](../../apps/web/src/app/finance/page.tsx): added an "Export Excel" link next to "Kontrol pembayaran" carrying the current `stage`/`month`/`q` as query params, shown only when `finance.read` is true.

No new table, no new RPC, no new migration — reuses the exact data path already on screen.

### 2. Audit history labels (#36)
- [audit-diff.ts](../../apps/web/src/lib/audit-diff.ts): pure `computeChangedFields(action, old, new)` — isolated (no `"server-only"`) so it's directly unit-testable.
- [audit-events.ts](../../apps/web/src/lib/audit-events.ts): `loadAuditEvents` calls the **existing, previously-unused** `app.list_audit_events` RPC, resolves actor names via one bulk `public.users` query, and maps `INSERT/UPDATE/DELETE` to Indonesian labels.
- [audit-history-panel.tsx](../../apps/web/src/components/audit-history-panel.tsx): small presentational list, `print:hidden` so it never appears on the printed/PDF invoice.
- [invoices/[invoiceId]/page.tsx](../../apps/web/src/app/invoices/%5BinvoiceId%5D/page.tsx): wired in, scoped to `entity_table='invoices'` for that one invoice. The RPC enforces its own org/membership scoping (`app.has_membership()` + `app.fn_active_organization()`); no extra permission check was added beyond `requireActiveWorkspace`, matching how Customer 360's existing history is gated.

No new table, no new RPC, no new migration — this surfaces an RPC that was already fully built and granted, just never called.

## Section #41 verification (no code change — confirmed already correct)

Traced the full current (latest-migration) authorization chain:
- `app.is_business_owner(p_org)` (broad: owner-or-platform) still correctly gates only genuinely platform-appropriate things: member list visibility inside `list_organization_access`, and `set_organization_member_role` (role/status management, where platform provisioning access is intentional — it explicitly branches on `is_operro_owner()` for granting `Pemilik`/`Bantuan Operro`).
- `app.is_business_owner_member(p_org)` (narrow: **excludes** the platform owner, added in `20261020100000_legacy_org_access_roles.sql`) correctly gates `set_business_admin_permissions` (raises `not_business_owner`/`42501` otherwise) and redacts `admin_keys`/`options` to `[]` inside `list_organization_access` for anyone who isn't the real owner-member — including the platform owner even when they also hold a legacy `Owner` membership.
- "Platform support must not see tenant payroll" is enforced at the **role-grant** level: the `Bantuan Operro` role's `role_permissions` explicitly exclude `payroll.%`, `finance.read`, `reports.view`, `roles.manage`, `users.manage` (`20261020100000_legacy_org_access_roles.sql`, lines 37–44). The separate `app.is_platform_admin()` RLS-bypass is a different, pre-existing, frozen architectural concept (scoped to the one real platform-owner account) used throughout the schema as a universal superuser escape hatch — not the tenant-scoped "platform support" role the task's constraint is about.

**An initial read of only the first migration (`20261019100000_platform_org_access.sql`) looked like a confirmed bug** (both RPCs gated by the broad `is_business_owner`). Re-checking for later `create or replace` definitions of the same function names found `20261020100000_legacy_org_access_roles.sql` (applied after it) fully supersedes both with the narrow gate. No fix was needed or made.

Wrote [supabase/tests/20261021100000_test_business_admin_checklist_isolation.sql](../../supabase/tests/20261021100000_test_business_admin_checklist_isolation.sql): real role/RLS assertions (not UI) via `pg_temp.act_as` JWT-claim impersonation, matching this repo's existing test house style (`pg_temp.ok`/`pg_temp.act_as` from `supabase/tests/20261001100000_test_payroll_engine.sql`). It asserts, against real RPC calls in one fixture org with an owner member, an Admin member, and a simulated platform-owner identity (`wbudiman1995@gmail.com` + `is_platform_admin`):
1. The owner can call `set_business_admin_permissions` and then see the real `admin_keys` it just set.
2. An org Admin gets `42501` calling `set_business_admin_permissions`, and sees `admin_keys: []` (redacted) from `list_organization_access`.
3. The simulated platform owner also gets `42501` on `set_business_admin_permissions` and `admin_keys: []` on read — but still sees the member list (the legitimate provisioning use), proving the redaction is specific to the checklist, not a blanket lockout.

No real production invitations or invoices were created or needed — the test is entirely self-contained, transactional (`begin; ... rollback;`), and creates its own disposable org/users/memberships.

## Validation — raw results

```
$ npm ci                                   # apps/web deps were not installed in this fresh worktree
added 489 packages, and audited 494 packages in 47s
2 moderate severity vulnerabilities (pre-existing, unrelated to this change — not investigated)

$ npm run typecheck   (apps/web)
> tsc --noEmit
(no output — clean)

$ npm run lint        (apps/web)
> eslint
(no output — clean)

$ npx tsx --test test/audit-diff.test.ts
✔ UPDATE reports only the fields whose value actually changed (5.6ms)
✔ UPDATE ignores updated_at even when it changed (0.4ms)
✔ INSERT and DELETE report no changed fields (0.4ms)
tests 3, pass 3, fail 0

$ npm run build       (apps/web, run once, at the end)
✓ Compiled successfully in 17.5s
✓ TypeScript finished in 19.9s
✓ Generating static pages (41/41)
Route list includes ƒ /finance/export (new) and all previously-existing routes; no route lost, no error.
```

**SQL test #41 — written, NOT executed.** This sandbox has no local `psql`, no Docker, and no PostgreSQL installed inside its WSL distro, and installing one would require interactive `sudo` (blocked — no password prompt available in this environment). I did not fabricate a passing run. The server-side authorization logic was verified by full code tracing (above) across every `create or replace` of the relevant functions, cross-checked against the live call sites in `platform/page.tsx`, `platform/actions.ts`, `settings/access/page.tsx`, and `access-management.tsx`. The test file matches this repo's established `pg_temp.ok`/`pg_temp.act_as` house style exactly and is ready to run with:
```bash
psql <fresh_pg16_db> -v ON_ERROR_STOP=1 -f <each file in supabase/migrations, in order>
psql <fresh_pg16_db> -v ON_ERROR_STOP=1 -f supabase/tests/20261021100000_test_business_admin_checklist_isolation.sql
```
**This is the next smallest useful task for whoever has a PG16 instance available** (see below) — run this one file and report PASS/FAIL per line; it needs no other setup.

**No migration was added or changed** — #41 required no schema/RPC change (already correct), and #31/#36 reused existing RPCs and tables, so the "fresh + populated-upgrade PG16 migration test" requirement does not apply to this pass; nothing new was added to `supabase/migrations/`.

**Browser-tested: NO.** Nothing in this pass was opened in a browser or clicked through. The finance export route and the audit panel are verified by typecheck + lint + a successful production build only — which proves the code compiles and the route exists, **not** that clicking "Export Excel" produces a correct `.xlsx` file a spreadsheet app opens cleanly, or that the audit panel renders real rows against a database with actual audit history. Do not treat either as QC'd from this pass alone.

## Deferred work (documented, not built — per instructions)

| Item | Why deferred | Exact data source if pursued | Acceptance test if pursued |
|---|---|---|---|
| Unified WhatsApp delivery platform (#34) | Explicitly out of scope; HomePaw itself has no equivalent (see table) | N/A — would be new for both products | N/A — not recommended without a separate scoping pass |
| Full organization backup incl. files/config (#38) | Explicitly out of scope; HomePaw's own export is table-data-only | `public.*` tables already covered by existing exporters + real Storage bucket listings (`grooming-photos`, `attachments`, style-ref bucket) + `business_settings`/`organizations` config rows | Restore the archive into an empty, freshly-migrated project and diff row-for-row and file-for-file against the source org |
| Unified operational reconciliation engine (#37) | Explicitly out of scope; HomePaw itself only reconciles subscription sessions | `visits`, `invoices`, `payments`, `payroll_items`/`bookings`/`manual_visits` — direct table reads, not derived aggregates | See acceptance test in the gap table row above |
| Per-org database-byte accounting (#43) | Explicitly out of scope; no HomePaw equivalent exists (HomePaw is single-tenant) | `pg_total_relation_size` per table filtered by `organization_id`, via a new `SECURITY DEFINER` RPC | A seeded org's reported bytes must track a manually-computed `SELECT pg_total_relation_size(...)` sum within a documented tolerance |
| Business-configuration consolidation (#39) | Small per item, but bundling (dashboard-card toggles, toast duration, auto-log toggle, all 5+ WA templates in one screen) is its own pass, not a single quick win | Existing `business_settings`/organization config tables; mostly UI exposure of settings that likely already have a column, needs per-field confirmation | Each toggle changes real behavior observed on the dashboard/relevant screen, not just a settings-page checkbox |

## Files changed

```
 M apps/web/src/app/finance/page.tsx
 M apps/web/src/app/invoices/[invoiceId]/page.tsx
 M apps/web/src/lib/homepaw-export.ts
?? apps/web/src/app/finance/export/route.ts
?? apps/web/src/components/audit-history-panel.tsx
?? apps/web/src/lib/audit-diff.ts
?? apps/web/src/lib/audit-events.ts
?? apps/web/src/lib/finance-export.ts
?? apps/web/test/audit-diff.test.ts
?? supabase/tests/20261021100000_test_business_admin_checklist_isolation.sql
?? docs/handoffs/PARITY-OPS-QUICKWINS.md
```

## Next smallest useful task

Run `supabase/tests/20261021100000_test_business_admin_checklist_isolation.sql` against a real fresh PostgreSQL 16 instance with this repo's full migration lineage applied, and report the three `pg_temp.ok` PASS/FAIL lines back into this doc. That closes the one piece of this pass that was written but not executed, with no further code changes expected if the trace above is correct.
