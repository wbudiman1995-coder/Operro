# Claude handoff: the remaining nine parity tasks (E1.2 – E3.4)

Date: 9 October 2026 (Asia/Jakarta). **Local work only.** Nothing was committed, pushed, deployed, merged or applied to any Supabase/Vercel project; no credentials were read; no real account, invitation, invoice, e-mail or WhatsApp message was created or sent. The patch is the working tree; this file is the handoff.

## 1. Base, preserved state, baseline

- Branch `codex/parity-orchestration`, HEAD `45fc289 feat(dashboard): add configurable card visibility` (on top of `25f150e` organization export and `a2c5fe6` dynamic size-band payroll). All three baseline commits are intact.
- Baseline captured **before any edit**: [baseline-git-status.txt](logs/REMAINING-NINE/baseline-git-status.txt) (status, log, `--stat`) and [baseline-git-diff.txt](logs/REMAINING-NINE/baseline-git-diff.txt) (the seven dirty tracked files, reconstructed with difflib from HEAD and the tree as found, so line counts can differ slightly from git's own `--stat`).
- Required reading done first: `apps/web/AGENTS.md`, `docs/HOMEPAW_PARITY_AUDIT_2026-10-01.md`, `docs/handoffs/CLAUDE-CONTROL-PLANE-BATCH-HANDOFF.md`, and the three `deepseek-outsourcing/2026-10-09/ENGINE-*.md` queues. HomePaw reference facts (coat options, preferences, retention, WhatsApp templates) were read from `Downloads/index.html`.

### Pre-existing dirty files and how they were treated

| File | State at start | This session |
|---|---|---|
| `apps/web/test/authorization.test.ts` | modified (Customer 360 `history` capability) | untouched |
| `apps/web/test/org-export-contract.test.ts` | modified | untouched |
| `integration/retention_renewal_followups_smoke.sql` | modified (`reset role` fixture fix; GATE 7d now passes, see §6) | untouched |
| `supabase/migrations/20261027100000_size_band_payroll.sql`, `20261028100000_org_export_foundation.sql` | modified, never applied remotely | untouched |
| `run_all_gates.sh` | modified (export gates) | **additive hunks only**: 8 migrations, 8 TS test files, 9 SQL tests, GATE 8b |
| `integration/run_populated_upgrade_rehearsal.sh` | modified (export probe) | **additive block only**: calls `integration/remaining_nine_upgrade_probe.sql` |
| `apps/web/test/control-plane-ui.test.tsx`, `supabase/tests/20261028100000_test_org_export.sql`, `docs/handoffs/CLAUDE-CONTROL-PLANE-BATCH-HANDOFF.md`, `docs/handoffs/logs/CONTROL-PLANE/`, `docs/handoffs/logs/INTEGRATION/sb06-populated-upgrade.log`, `docs/agent-work/CLAUDE-*.md`, `agent-bundles/*.zip`, `deepseek-outsourcing/2026-10-09/`, `scripts/build-deepseek-chat-packets.ps1` | untracked | untouched |

Existing tracked files **this session edited** (listed per task below): `apps/web/test/customer-pet-edit.test.ts` (new fields), `apps/web/src/lib/customer-pet-edit.ts`, `customer-360.ts`, `finance-export.ts`, `app/customers/[customerId]/{actions,page}.tsx`, `app/customers/onboarding/actions.ts`, `app/finance/{page.tsx,export/route.ts}`, `app/page.tsx`, `app/settings/storage/{actions,page}.ts(x)`, `components/{customer-pet-editor,organization-switcher,workspace-shell}.tsx`.

## 2. Verification (exact commands and results)

Environment: Windows 11, Node v24.19.0, PostgreSQL **16.15** (`postgres:16`, WSL Ubuntu docker, container `operro-cp-pg16`, `template1` given Supabase-style default grants). Raw logs: [logs/REMAINING-NINE/](logs/REMAINING-NINE/).

| Check | Command | Result |
|---|---|---|
| Whole web suite | `npx tsx --test test/*.test.ts test/*.test.tsx` (in `apps/web`) | `ℹ tests 615 / pass 615 / fail 0 / cancelled 0 / skipped 0` ([log](logs/REMAINING-NINE/web-all-tests.log)). Previous handoff: 553; +62 new tests |
| Web typecheck | `npm run typecheck` | `exit=0` |
| Root typecheck | `npx tsc -p tsconfig.typecheck.json --noEmit` | `exit=0` |
| Lint | `npm run lint -- --max-warnings=0` | `exit=0` (one React-compiler error "JSX inside try/catch" in the health page was found and fixed on the way) |
| Production build | `npm run build` | `✓ Compiled successfully`, `exit=0`; new routes listed: `/audit /reconciliation /settings/custom-fields /settings/health /settings/preferences /start /whatsapp` |
| Whitespace | `git diff --check` + trailing-whitespace scan of untracked sources | `exit=0` (only the LF/CRLF notices of the tree's `autocrlf`); the scan found trailing spaces only in two generated log files |
| **Fresh PG16, whole repository gate** | `run_all_gates.sh` GATE 4 → GATE 8b, run in the container (GATE 1-3 need Node and were run on the host, rows above) | `ALL GATES PASSED`, `GATES_EXIT=0` ([db-gates.log](logs/REMAINING-NINE/db-gates.log)). Includes the existing 4b-8 gates, GATE 7d (now passes), and the new **GATE 8b two-session cleanup race**: `STORAGE CLEANUP CONCURRENCY PASS` |
| New SQL suites, run one by one on a fresh full-lineage DB | `psql -v ON_ERROR_STOP=1 -f supabase/tests/<file>` | 9 files, **329 `PASS:` notices, 0 failures** ([new-sql-tests.log](logs/REMAINING-NINE/new-sql-tests.log)): custom_fields 54, pet_coat_profile 16, settings_and_preferences 23, finance_cash_position 15, whatsapp_drafts 48, audit_reconciliation 28, access_policy_regression 66, storage_cleanup 47, health_recovery 32 |
| Populated-upgrade rehearsal | `integration/run_populated_upgrade_rehearsal.sh` (run from WSL, log redirected to `logs/REMAINING-NINE/populated-upgrade.log` so the committed `INTEGRATION/populated-upgrade.log` is not overwritten) | `POPULATED UPGRADE PASS`, `exit=0`, plus `REMAINING NINE POPULATED PROBE PASS` ([log](logs/REMAINING-NINE/populated-upgrade.log)) |
| Test sensitivity | ten deliberate breakages of one control each in a throwaway clone, matching SQL test re-run | **10/10 detected** ([mutation-checks.log](logs/REMAINING-NINE/mutation-checks.log)). Two initially missed (a no-op mutation I wrote badly; a vacuous "no rows" assertion made before any row existed in the E3.4 test) – the second was a real test weakness and is fixed |
| Grant / migration review | catalog queries on the migrated DB | [grant-review.txt](logs/REMAINING-NINE/grant-review.txt): see §5 |

Evidence-quality notes:
- **Database/RLS evidence is real** (real `authenticated`/`anon` roles, `set local role`, JWT claims, fixtures in rolled-back transactions; the cleanup race uses two real sessions). TypeScript contract tests that assert source patterns are labelled as such and are **not** presented as equivalent to database or browser verification.
- `db-gates.log` is stdout/stderr interleaved by `docker exec`: the `NOTICE:  PASS` lines of the earlier test files are not all present in it. The per-file `PASS:` counts therefore come from [new-sql-tests.log](logs/REMAINING-NINE/new-sql-tests.log); the gate script itself runs with `set -e` + `ON_ERROR_STOP`, and its `ALL GATES PASSED` marker is the gate evidence.
- The Next.js agent rule was respected: `apps/web/AGENTS.md` says this is not the Next.js of training data. Only patterns already present in the repo (server actions with `useActionState`, `searchParams: Promise<…>`, `force-dynamic`, route handlers) were used; the build compiled all pages.

## 3. Migration order and forward-only notes

Existing lineage unchanged, then (all new, none applied anywhere, all forward-only, none edits an earlier migration):

1. `20261029100000_custom_fields.sql` – E1.2
2. `20261029110000_pet_coat_profile.sql` – E1.3
3. `20261029120000_settings_and_preferences.sql` – E1.4
4. `20261029130000_finance_cash_position.sql` – E2.2
5. `20261029140000_whatsapp_drafts.sql` – E2.3
6. `20261029150000_audit_reconciliation.sql` – E2.4
7. `20261029160000_storage_cleanup_foundation.sql` – E3.3
8. `20261029170000_health_recovery.sql` – E3.4 (also defines `app.schema_version()`)

E3.2 adds **no migration** (tests only). All eight are registered in `EXPECTED_MIGRATIONS` of `run_all_gates.sh`. Each ends with `notify pgrst, 'reload schema';`.

- **Undo before release:** drop the unreleased migrations and recreate the disposable database. **After release:** only a new forward migration (drop the new tables/functions, restore the 13-argument `update_customer_pet` body from `20261026100000`). Nothing here rewrites tenant data: the only change to existing rows' shape is two nullable columns on `pets` (E1.3); every other change adds tables/functions.
- E1.3 `create or replace`s the existing 13-argument `app.update_customer_pet` as a thin wrapper that **preserves** the stored coat profile and delegates to the new 15-argument function, so existing callers (`customer_pet_edit_smoke.sql`, GATE 7l) keep working unchanged.
- Every new migration depends only on objects that exist before it; the populated-upgrade rehearsal applies them (before the size-band set) on the HomePaw demo data and the "Upgrade X" fixture.
- **Maintenance rule introduced:** `app.schema_version()` returns the newest migration id and `apps/web/src/lib/health.ts` `EXPECTED_SCHEMA_VERSION` must equal it; `test/health-recovery.test.ts` fails if the newest migration file and either constant disagree, so a future migration must bump both.

## 4. Tasks

Conventions common to all tasks: the organization, user, capability and role come from `app.fn_active_organization()` / `auth.uid()` / `app.has_permission` inside the database; the browser never supplies a tenant, user or phone. All new `security definer` functions have `set search_path = ''`, validated inputs, explicit `revoke … from public, anon, authenticated` then a narrow `grant … to authenticated`. Client roles get `SELECT` only on new tables (RLS on); writes are RPC-only.

### E1.2 – Customer 360 custom fields (#3, #40)

- **Built:** `custom_field_definitions` (stable uuid id, entity scope `customer|pet`, label, type `text|number|date|boolean|select`, server-keyed options, sort order, `active|archived`) and typed `custom_field_values` (no JSON column). RPCs `save_custom_field_definition` (`settings.manage`, optimistic version, type/scope immutable, ≤20 active per scope, options 1–12 with never-reused keys), `set_custom_field_archived`, `set_custom_field_values` (`customer.manage`, per-type validation, blank clears, idempotent, atomic batch). Archiving hides and refuses writes but keeps values; unarchive restores them. Formula-like text (leading `= + - @`) and control characters are refused outright.
- **Files:** migration above; `src/lib/custom-fields.ts`; `app/settings/custom-fields/{page,actions}`; `app/customers/[customerId]/custom-field-actions.ts`; `components/{custom-field-editor,custom-field-definition-manager,custom-field-values}.tsx`; customer page wiring (customer + each pet); nav link; tests `test/custom-fields.test.ts`, `supabase/tests/20261029100000_test_custom_fields.sql`, UI cases in `test/remaining-nine-ui.test.tsx`.
- **Reused:** `app.tg_write_audit`, `app.tg_set_updated_at`, `crm` module gate, existing Customer 360 page/editors, the legacy read-only `pets.metadata` display (kept as is, shown separately).
- **Checks proven (SQL):** every type; both scopes; archived definition (write refused, value kept, unarchive restores); changed options (surviving label keeps key, removed key refused for new writes, keys never reused, old value shown as "tidak lagi tersedia"); invalid/formula-like/overlong/exponent/impossible-date/non-string values; old records without values; duplicate label/option; stale version; direct DML denied; role without `customer.read` sees nothing; tenant B cannot read/write/archive/edit tenant A's definitions or customers; forged active-org refused; audit rows written.
- **Not done by design:** public onboarding, formulas, arbitrary JSON, search, export.

### E1.3 – Pet coat profile and derived wash count (#4)

- **Built:** from the HomePaw dog form only: `pets.coat_type` (`short|long|curly|double_coat`) and `pets.skin_history` (≤1000). Coat colour is the existing `pets.color`; "prefs" is the existing temperament/notes. The **visit count is never stored**: `app.pet_visit_stats(uuid[])` (definer, `customer.read`, ≤100 pets, tenant-scoped) derives `completed_jobs` (distinct `completed`, non-deleted bookings whose pet job line is neither deleted nor `skipped`), `manual_visits` (non-deleted off-books visits, reported separately, never double counted) and `last_visit_at`. Customer 360 shows coat, skin history, "Kunjungan selesai (+N manual)" and "Terakhir dikunjungi", all read-only; a caller without `customer.read` gets *unavailable*, not 0; a failing RPC no longer breaks the profile page.
- **Files:** migration; `lib/customer-pet-edit.ts` (new fields + `PET_COAT_*`), `lib/customer-360.ts` (select + stats), pet editor component, page, action; updated `test/customer-pet-edit.test.ts`; `supabase/tests/20261029110000_test_pet_coat_profile.sql`.
- **Reused:** `update_customer_pet` (optimistic concurrency, weight-derived sizing, size-layout lock), existing bookings/job lines/manual visits as the authoritative source.
- **Proven (SQL):** repeats counted once each; cancelled, no-show, draft, confirmed(future), in-progress, skipped line, soft-deleted line and soft-deleted booking excluded; archived pet keeps history; empty history is 0/null; org-B pet invisible; ≤100 ids; stale/invalid input rejected; legacy 13-arg caller cannot wipe the profile; booking/job-line rows byte-identical; no stored counter column; grants.

### E1.4 – Business setting and personal default (#39, #42)

- **Organization-owned (owner-only):** `organizations.settings.evidence_retention_days` – already read by `app.tg_apply_evidence_retention` but with no safe write path. `app.set_evidence_retention_days(int 30..1825)` requires `app.is_business_owner_member` (business owner or platform owner; a `settings.manage` manager is refused), preserves sibling settings, repairs a malformed scalar `settings`. UI on `/settings/storage`; says it affects only **new** evidence. *Mapping to the reference:* HomePaw exposes a photo-retention threshold ("Foto styling ref kedaluwarsa N hari"); Operro's authoritative equivalent for grooming evidence is this key.
- **User-owned:** one default only, the **landing page**: `public.user_preferences.landing_page ∈ {dashboard, schedule, customers, finance}`. `set_my_landing_page` refuses a page the caller cannot open now; `my_landing_page()` re-validates **live** (membership, capability, organization state) so revoked access, a suspended membership, or another business silently falls back to `/dashboard`. Applied through a new `/start` route (`/` and the organization switcher go there). Page `/settings/preferences` ("Preferensi saya"); no translation.
- **Files:** migration; `lib/preferences.ts`; `app/start`, `app/settings/preferences/*`, `app/settings/storage/{actions,page}`; `components/{landing-preference-form,evidence-retention-form}.tsx`; `app/page.tsx`, `organization-switcher.tsx`, nav; `test/preferences.test.ts`; `supabase/tests/20261029120000_test_settings_and_preferences.sql`.
- **Proven (SQL):** owner-only writes; 29/1826/null/non-integer rejected; arbitrary route, external URL, empty string rejected; user/user isolation; the same person in a business lacking the capability falls back; revoked capability and suspended membership fall back immediately; direct DML denied; a malformed value cannot be stored.

### E2.2 – Finance XLSX export and cash position (#31)

- **Built:** `app.finance_cash_position(from, to, tz)` – **read-only, `security invoker`** (so the existing RLS incl. branch isolation decides visibility), explicit `finance.read` check (error instead of an RLS-emptied zero), ≤366-day period, validated time zone, one row per (month in that zone, currency); payments `succeeded` by `paid_at`, refunds `succeeded` by `refunded_at` joined through their payment (so a refund of an invisible branch's payment never leaks, currency taken from the payment), expenses non-deleted by `incurred_at`; pending/failed payments only *counted*. No ledger, no writes. `/finance` gets a "Posisi kas (laporan baca-saja)" panel (period form, per-currency cards, table, empty/error states, "bukan buku besar akuntansi"). The existing export gains **"Pengembalian Dana - Semua"** (with invoice number and per-refund currency), **"Posisi Kas"** and **"Catatan Kas"** sheets (`?from&to`, default current month in the business zone); payments/expenses sheets, `collectExportPages` pagination and `spreadsheetSafeCell` formula neutralisation are reused unchanged.
- **Files:** migration; `lib/cash-position.ts`; `lib/finance-export.ts`; `app/finance/{page,export/route}`; `components/cash-position-panel.tsx`; `test/finance-cash.test.ts` (8), `supabase/tests/20261029130000_test_finance_cash_position.sql`.
- **Proven:** mixed currency kept on separate rows; refunds (failed and other-month excluded); Jakarta/UTC boundary instants; multi-month grouping; empty period → no rows; invalid/reversed/>366-day/out-of-range/unknown-zone rejected; North-only user sees only North payments/expenses and no refund of a South payment; no-`finance.read` role refused; tenant B sees only B; forged org refused; function is `STABLE`, invoker, not callable by anon. TS: pagination across >1 register page (450 rows, no duplicates) and >500 refunds; filters reach the RPC; other-tenant refund/expense rows never appear; `=`, `+`, `-`, `@` cell prefixes neutralised in all text columns; no organization argument is sent.
- **Pre-existing, not changed:** the top stat card "Pembayaran tercatat" on `/finance` still sums all currencies of the 50 most recent payments; the new panel is the currency-correct view.

### E2.3 – WhatsApp draft center (#34)

- **Built:** `public.whatsapp_drafts` (source `invoice|followup|renewal|onboarding`, recipient phone **derived from the customer row**, message ≤1500, status `draft|opened|marked_sent|failed|canceled`, note, who/when) plus `whatsapp_contact_preferences` (opt-out). RPCs: `create_whatsapp_draft` (per-source capability: invoice `finance.read`, follow-up `customer.read`, renewal `membership.read`, onboarding `customer.manage`; idempotent per live source via a partial unique index and advisory lock; refuses void invoices, archived customers, opted-out, missing/implausible phone, unresolved `{placeholders}`, control characters, a stored one-time `/join/<token>` link), `set_whatsapp_draft_status` (transition table below; same-status is a no-op; open/mark-sent blocked for opted-out or archived recipients), `set_whatsapp_opt_out` (cancels live drafts). Every change is an UPDATE → existing `app.audit_log` (with actor); the opt-out table has its own PK-aware audit writer.
  - Transitions: `draft → opened | marked_sent | failed | canceled`; `opened → marked_sent | failed | canceled`; `failed → draft (retry) | canceled`; `marked_sent`, `canceled` terminal. No provider-style status (`delivered`, `read`, …) exists.
- **Server-built messages:** the action loads the stored org templates and data (`loadInvoiceDocument`, `buildFollowupMessage`, `buildRenewalMessage`, `preview_package_renewal`) and refuses unknown template variables instead of sending them. The page `/whatsapp` ("Pusat WhatsApp") lists drafts with status/source filters and keyset paging, "Tambah ke antrean" candidates (issued invoices, follow-ups, renewals), a `wa.me` link built from the stored digits with the text percent-encoded, and states in plain words that Operro **never sends**, that "dibuka" is not "terkirim", and that "ditandai terkirim" is a user report. Onboarding invitations are logged automatically when a link is created, **without the secret link** (marker text; the center offers lifecycle only, because the single-use token exists only at creation – accepted limitation).
- **Files:** migration; `lib/whatsapp-drafts.ts`, `lib/whatsapp-draft-data.ts`; `app/whatsapp/{page,actions}`; `components/whatsapp-draft-center.tsx`; `app/customers/onboarding/actions.ts` (best-effort draft record); nav; `test/whatsapp-drafts.test.ts`, UI cases, `supabase/tests/20261029140000_test_whatsapp_drafts.sql`.
- **Never done:** auto-send, scraping WhatsApp Web, unofficial API, delivery receipts – the migration contains no network call and a test asserts none of these strings appear.
- **Proven (SQL):** phone normalisation from the DB (`0812-…` and `+62 …`); idempotent create; refusals above; lifecycle incl. retry and terminal states; opt-out cancels/blocks/reverses; archived-after-drafting only cancel; per-source visibility (finance-only user sees invoice drafts only, CRM reader follow-ups only); direct DML denied; cross-tenant create/update/opt-out refused; forged org refused; audit entries incl. actor.

### E2.4 – Cross-entity audit viewer and read-only reconciliation (#36, #37)

- **Audit viewer** `/audit`: `app.search_audit_events` (definer, `reports.view` **and** the capability that already shows each table – finance for invoices/payments, payroll for payroll, `roles.manage` for access tables, `settings.manage` for configuration; unmapped tables owner-only), org-scoped, **branch-limited** using the branch id in the diff, UPDATE events return only the changed fields (metadata removed), secret-looking keys (`token|secret|password|hash|external_ref|…`) removed, strings truncated, actor resolved (`full_name` → e-mail → "Sistem"), filters (table, action, actor, business-zone date range), keyset pagination ≤100. UI: Indonesian entity/field labels (reusing `audit-diff.ts`), before/after lines, "buka" links, actor drill-down.
- **Reconciliation** `/reconciliation` – three independent, read-only checks, each shown only with its capabilities, never repairing anything:
  1. completed visits (bookings and off-books) with no non-void invoice and no active manual billing – a thin **invoker** wrapper (`reconcile_unbilled_visits`) over the existing `search_visit_register(… 'unbilled' …)`; it requires `booking.read`, `finance.read` **and `order.read`** because the register reaches invoices through orders and would otherwise report every visit as unbilled (a finding worth knowing: see §7);
  2. `reconcile_invoice_payments` (invoker, RLS incl. branch): `paid_in_full_not_closed`, `closed_without_full_payment`, `void_with_payments`, `currency_mismatch`; valid = succeeded payments minus succeeded refunds in the invoice's currency;
  3. `reconcile_payroll_sources` (definer, `payroll.read`, branch-checked): for published items of approved/paid runs, re-computes live source counts with the existing engine function and compares with the frozen snapshot's `breakdown.meta` counts → `source_reduced` (invoice voided / work removed after payout), `source_unavailable`, `snapshot_without_counts` (legacy snapshot reported, never guessed); bounded scan (≤100 per call) with continuation. Live > snapshot is deliberately not reported (new unpaid work, not a broken source).
- **Files:** migration; `lib/audit-viewer.ts`, `lib/reconciliation.ts`; `app/audit/page.tsx`, `app/reconciliation/page.tsx`; nav; `test/audit-reconciliation.test.ts`, `supabase/tests/20261029150000_test_audit_reconciliation.sql`.
- **Proven (SQL):** actor resolution; changed-field-only diffs; token hash redaction; filters; pagination covers every row; branch-restricted reader sees one of two branches' bookings and none of the access-management/payroll audit rows; groomer and no-`reports.view` refused; tenant B sees none of A's rows; clean vs broken fixtures for all four invoice kinds incl. refund netting, mixed currency, void-with-payment, failed payment ignored, South-branch invoice hidden from a North-only user; void-invoice visit is still "unbilled"; payroll: clean item quiet, unpublished item out of scope, deleted job line and voided invoice both → `source_reduced`, legacy snapshot reported, continuation across scans; payroll rows byte-identical afterwards; grants.
- **Known limitation:** `public.payments` has no audit trigger (immutable ledger), so payment *creation* is not in the audit viewer; invoices/bookings/customers/refunds-adjacent tables that are audited are.

### E3.2 – Access-policy regression suite (#41)

- **Built:** `supabase/tests/20261029155000_test_access_policy_regression.sql` (66 assertions, no migration). Workspaces are provisioned through the real `app.prepare_operro_organization`, users are synthetic (`auth.users` rows inside a rolled-back transaction – no real invitation/account/e-mail), everything runs as the real `authenticated` role under RLS.
- **Proves:** the platform owner switches into a **suspended** workspace, sees its payroll/finance rows (JWT superuser policy), reads and changes its tenant-Admin checklist (never `roles.manage`/`users.manage`, unknown keys rejected), and keeps it across token refresh while the suspended business's own owner does not and a forged `is_platform_admin` claim is overwritten by the profile; a tenant Admin cannot read/change the checklist, promote themselves, demote the owner, invite, write permissions/memberships/organization status directly, or suspend a workspace; the suspended workspace's Admin and owner (stale tokens) get nothing and cannot even read the access payload or switch in; owner A cannot touch business B; **Bantuan Operro** lacks `payroll.*`, `finance.read`, `reports.view`, `roles.manage`, `users.manage`, sees no payroll/finance rows (while keeping operational access and branch access, so the denial is capability-driven), and is refused the payroll export/recompute RPCs, cash position, both reconciliations, the audit viewer, the payment register, access listing, checklist, role changes, invitations and direct permission edits; the superuser policy is exactly the JWT claim; suspended membership, deactivated profile, a revoked single capability and an organization suspended under a live token take effect immediately; anon/PUBLIC reach none of the access functions.
- **Platform-owner superuser policy preserved:** nothing in any migration touches `app.is_platform_admin`, `is_operro_owner`, `is_business_owner_member` or the token hook.

### E3.3 – Safe scheduled storage-cleanup foundation (#43)

- **Built:** `storage_cleanup_runs` / `storage_cleanup_items` and RPCs `storage_cleanup_preview` (**dry run**, `settings.manage`), `storage_cleanup_begin` (business owner; needs a completed preview < 24 h old; one running apply per organization via a partial unique index + 15-minute lease; a lapsed lease is abandoned and its leftovers retried; **re-verifies each previewed item and tombstones `attachments.deleted_at` first** – metadata before objects – then returns the objects to remove, including leftovers from earlier runs), `storage_cleanup_record` (per object `deleted | missing | failed`, idempotent, settled items never flip, 5 failed attempts → `abandoned`), `storage_cleanup_finish` (`completed` or `partial`). Eligibility (`storage_cleanup_candidates`, internal): in a managed bucket, path under the organization's own prefix, `styling_reference` or evidence (`metadata ? 'category'`), parsed `expires_at` older than **now − 1 day**, not linked to invoice/payment/refund/order/complaint/payroll/commission/expense/package/membership, not a payment proof or attendance photo, not already deleted. Audit: runs, items and the tombstoned attachments go through `tg_write_audit`.
- **Runner** (`lib/storage-cleanup.ts`, user's own client, server actions in `cleanup-actions.ts`, panel on `/settings/storage`): presence is decided by listing the folder; **"missing" only when listing succeeded and the name is absent**; a listing error or a removal that did not really remove the object (policy denial returns success with nothing removed) is **failed and retried**; ≤50 objects per batch, ≤200 per call, results recorded after each batch, the run is always finished (lease released) even if recording fails. UI: explicit "pratinjau tidak menghapus apa pun", confirmation checkbox, last-run history, counts only – no bytes, database size or prices anywhere (asserted).
- **Scheduling:** this is the *foundation*. No unattended trigger exists or was added (the repo has no service-role client, cron route or scheduler); a scheduler can call exactly these functions per organization. See §7.
- **Proven:** SQL (47 assertions): the exact eligible set, grace boundary (23 h not, 1 d 2 min yes), foreign prefix, malformed expiry, unmanaged bucket, other tenant, complaint/invoice/proof protection, items that become protected or deleted between preview and apply are skipped, metadata tombstoned before removal is reported, dry run changes nothing, limit clamped, stale preview, other tenant's preview, owner-only apply, lease refusal and takeover, partial failure → partial, retry hands failed objects back, missing, idempotent record, abandonment after 5 attempts, repeat cycle no-op, audit, grants. **Two real sessions** (`supabase/tests/storage_cleanup/*`, GATE 8b): session B blocks on A's open transaction for ~3 s and is then refused (`55P03`); exactly one running run, each object tombstoned once. TS (8): order of operations, missing vs list-error, denial, Storage error, batching, record failure, begin refusal, no cost/size strings.

### E3.4 – Health and recovery readiness (#44)

- **Built:** `/settings/health` ("Kesehatan & pemulihan"), business owner or platform owner. `app.health_summary()` (definer, owner-gated, counts/timestamps only): schema version, failed (30 d) and stale-running (>2 h) organization exports, last completed export, storage-cleanup problem runs (failed/partial/abandoned in 30 d), lapsed-lease runs and pending objects, pending/stale (>14 d) capacity requests; platform owners additionally get platform-wide **counts**. `app.recovery_status()` and append-only `public.recovery_drills` (written only by `app.record_recovery_drill`, platform owner, rejects future dates, `production` as target, and text that looks like a credential/token/connection string; update/delete blocked even for the table owner). Business owners see only the date/outcome of the last drill; notes, evidence reference, RPO/RTO and target are platform-owner-only. Unresolved reconciliation counts (visits, invoice/payment, payroll scan; capped at 100, shown as `100+`, and shown as *unavailable* – never 0 – when a permission is missing or a call fails). App version = package version + 7-hex commit id; **no provider API is called or simulated**, the page says Supabase/Vercel status, backups and billing are not visible and links to the provider procedures.
- **Honesty rules (tested):** with no drill → "Pemulihan belum terbukti"; last drill failed/partial → says so; last pass > 90 days → "kedaluwarsa"; a recent pass is "lulus pada <date>… bukan jaminan"; export archives are described as *not* restorable backups; no billing/size estimates.
- **Runbook:** `docs/runbooks/RECOVERY_READINESS.md` – what Operro can/cannot show, a numbered **manual recovery exercise** into a disposable project (RPO/RTO measurement, data and RLS checks, Storage checked separately, record the drill), application rollback vs data recovery, first actions per attention item, limits.
- **Files:** migration; `lib/health.ts`; `app/settings/health/{page,actions}`; `components/{health-panel,recovery-drill-form}.tsx`; runbook; nav; `test/health-recovery.test.ts`, UI cases, `supabase/tests/20261029170000_test_health_recovery.sql`.
- **Proven (SQL, 32):** counts per tenant, stale/failed/lapsed-lease surfaced, no platform section for a business owner, no raw failure text/other-tenant/path/token/billing fields, non-owner manager refused (even with `settings.manage` + `reports.view`), forged org refused, tenant B sees only B, drill validation and credential-text refusal, drill history unreadable by a business owner even when drills exist, append-only, platform counts, grants.

## 5. Security and tenancy review

[grant-review.txt](logs/REMAINING-NINE/grant-review.txt) (catalog query on the fully migrated DB):
- 36 functions inspected (incl. both `update_customer_pet` signatures). **Every function has `search_path=""`; every `security definer` function has it (query "definers without an empty search_path" returns 0 rows).** `anon` and `PUBLIC` have **no** EXECUTE on any of them.
- `authenticated` can execute only the intended RPCs plus `whatsapp_source_permitted` (needed because the RLS policy expression runs as the caller), `schema_version`, and the invoker report functions. Internals (`audit_redact`, `audit_table_permission`, `audit_table_visible`, `landing_page_allowed`, `storage_cleanup_candidates/authorized`, `try_timestamptz`, `whatsapp_normalize_phone`, both trigger functions) are not executable by clients. (The review found one needless grant on `audit_table_visible`; it was removed.)
- Eight new tables: RLS on, one SELECT policy each, `authenticated` has **SELECT only**, `anon` nothing.
- Cross-cutting checks present in SQL tests for every task: forged `active_org_id` refusal, cross-tenant read/write refusal, restricted-capability refusal, suspended/revoked state refusal, anon/PUBLIC grant absence.

## 6. Reuse, not duplication

Audit: `app.audit_log`/`tg_write_audit`, `audit-diff.ts`. Authorization: `app.has_permission`, `is_business_owner_member`, branch RLS, the module gates. Finance: `loadPaymentRegister`, `collectExportPages`, `spreadsheetSafeCell`, `sheet()`. Visits: `search_visit_register`. Payroll: `compute_payroll_item`, snapshots in `payroll_items.breakdown.meta`. Retention: the `metadata.expires_at` convention and `evidence_retention_days`. Messaging: `followup-messages.ts`, `loadInvoiceDocument`, org templates, `preview_package_renewal`. Pets: `update_customer_pet`. No second authorization, accounting, audit or cleanup system was introduced.

GATE 7d (`retention_renewal_followups_smoke.sql`) failed on vanilla PG16 in the previous handoff; the working copy already contains the user's `reset role` fix and the gate **passes** in the run above.

## 7. Limitations, deferrals, blockers

Browser-tested vs not:
- **Not browser-tested at all.** No Supabase/Vercel environment, no dev server, no credentials (the brief excludes them). Covered instead: database/RLS behavior with real roles (§2), `renderToStaticMarkup` contract tests of every new client component (editor, definition manager, landing form, retention form, pet editor, cash panel, draft rows, cleanup panel, health panel, drill form), pure-function and fake-client tests of every loader/action, and a production build that compiled every new route. **Manual QC still needed:** custom-field create/edit/archive flow; pet coat edit; `/start` landing redirect for a role that loses a capability; finance export workbook opened in Excel (formula cells); WhatsApp link opening on a phone and the status buttons; audit filters; reconciliation with real data; cleanup preview → apply against **real Supabase Storage** (list/remove semantics, Storage RLS on `remove`); health page as owner and as platform owner.
- Real Supabase Storage was never exercised; the cleanup runner is tested against a fake that models the failure modes (denial, listing error, 500), and the database half against PG16.

Deferred / consciously not built:
- **No unattended cleanup scheduler** (foundation only; needs a service identity + cron decision).
- **Onboarding WhatsApp drafts cannot be reopened** from the center (the one-time link is intentionally never stored).
- **No provider integrations** (Supabase/Vercel status, backups, billing) and **no restore drill performed** – the system states recovery is not proven; a human must run the runbook and record it.
- Opt-out is a customer-level flag in the WhatsApp feature only; it is not surfaced on Customer 360 or honoured by features outside the draft center.
- Payroll reconciliation scans published items of approved/paid runs only (not unpublished paid runs) and compares counts, not amounts; it needs `payroll.read`.
- The payments table is not audited by trigger, so the audit viewer shows no payment creation events.
- `docs/HOMEPAW_PARITY_AUDIT_2026-10-01.md` was **not** updated (rows #3/#4/#31/#34/#36/#37/#39–#44 are further along but not claimed as full parity).

Observations worth a decision (not changed):
- `search_visit_register` joins invoices through `orders`, which require `order.read`; a role with `booking.read` + `finance.read` but not `order.read` sees every visit as "unbilled" in the existing Visits UI. The new reconciliation refuses in that case rather than repeating the false positive.
- `GET /api/health/supabase` (pre-existing) returns the raw database error message on failure.
- `payroll_eligible_pets` / `payroll_transport_shares` still have `search_path = app, public` (internal only, noted in the previous handoff).

No blocker remained in the original handoff review. Nothing was committed, pushed or deployed.

## 8. Post-handoff reviewer correction — 10 October 2026

Codex review found that the first version of `app.audit_redact` only removed
secret-looking **top-level** keys. Audit events are full JSON serializations of
source rows, and existing tables contain nested JSON fields such as `metadata`
and `receipt`; a nested `token` or `api_key` could therefore have appeared in
the audit viewer.

The uncommitted `20261029150000_audit_reconciliation.sql` now recursively
redacts matching keys in objects and arrays while retaining safe sibling data
(`app.audit_redact_value`, called by `app.audit_redact`).
`20261029150000_test_audit_reconciliation.sql` now exercises real audit
trigger output containing nested `metadata.integrations.api_key` and an array
item `token`, confirming both are absent and safe sibling values remain. The
internal helpers are revoked from every client role.

### 8.1 Review and re-verification of the correction (10 October 2026, Claude)

**Review result:** the recursive design is correct and PostgreSQL-16 compatible (object → key filter + recursion; array → recursion;
long strings truncated; scalars/nulls untouched; `immutable`, empty `search_path`, plpgsql recursion). One concrete defect was
found and fixed narrowly: `jsonb_agg(…)` over `jsonb_array_elements(…)` had **no explicit ordering**, so array element order was
not guaranteed. It now uses `with ordinality` and `order by e.ord`. The regression test gained: array order/depth/scalar/null shape
(`[{"s":"1"},{"api_key":"K1"},{"s":"3"}]` → `[{"s":"1"},{},{"s":"3"}]`, nested `Password`/`TOKEN` keys case-insensitively removed,
`list`/`n`/`num` preserved) and explicit `anon`/`PUBLIC`/`authenticated` EXECUTE denial for both `audit_redact_value` and `audit_redact`.
Codex's own regression (nested `metadata.integrations.api_key` absent, array `token` absent, `safe_label` retained) is unchanged and passes.

**Environment note:** another session was running `./db-gates.sh` in the shared `operro-cp-pg16` container at the same time (it dropped
`operro_gate` under my first attempt, which therefore failed with `database "operro_gate" does not exist`). All final runs below used a
**private container** `operro-rf-pg16` (`postgres:16`, PostgreSQL 16.15, repository mounted read-only) so they cannot collide with anyone.
That first attempt is not counted as a result.

Final commands and results (raw logs in `docs/handoffs/logs/REMAINING-NINE-REVIEW-FIX/`):

| Check | Command | Result |
|---|---|---|
| Whole repository DB gate, fresh PG16, full migration lineage | `run_all_gates.sh` GATE 4 → 8b in the container (GATE 1-3 on the host, rows below) | `ALL GATES PASSED`, `GATES_EXIT=0`, `STORAGE CLEANUP CONCURRENCY PASS` ([db-gates.log](logs/REMAINING-NINE-REVIEW-FIX/db-gates.log)) |
| New SQL suites, each on a fresh full-lineage DB | `psql -v ON_ERROR_STOP=1 -f supabase/tests/<file>` | 9 files, **331 `PASS:` notices, 0 failures** (audit_reconciliation now 30, was 28): custom_fields 54, pet_coat_profile 16, settings_and_preferences 23, finance_cash_position 15, whatsapp_drafts 48, audit_reconciliation 30, access_policy_regression 66, storage_cleanup 47, health_recovery 32 ([new-sql-tests.log](logs/REMAINING-NINE-REVIEW-FIX/new-sql-tests.log)) |
| Redaction test sensitivity | (1) restore top-level-only redaction; (2) make arrays come back reordered | both **detected** by the E2.4 test ([redaction-mutation-checks.log](logs/REMAINING-NINE-REVIEW-FIX/redaction-mutation-checks.log)) |
| Web tests | `npx tsx --test test/*.test.ts test/*.test.tsx` (in `apps/web`) | `ℹ tests 615 / pass 615 / fail 0 / cancelled 0 / skipped 0` |
| Web typecheck | `npm run typecheck` | `exit=0` |
| Root typecheck | `npx tsc -p tsconfig.typecheck.json --noEmit` | `exit=0` |
| Lint | `npm run lint -- --max-warnings=0` | `exit=0` |
| Production build | `npm run build` | `✓ Compiled successfully`, `exit=0` |
| Populated-upgrade rehearsal | `integration/run_populated_upgrade_rehearsal.sh` (WSL, log redirected so the committed INTEGRATION log is untouched) | `POPULATED UPGRADE PASS`, `REMAINING NINE POPULATED PROBE PASS`, `exit=0` ([populated-upgrade.log](logs/REMAINING-NINE-REVIEW-FIX/populated-upgrade.log)) |
| Whitespace | `git diff --check` + trailing-whitespace scan of untracked sources | `exit=0`; scan clean |
| Grants / RLS / search_path | catalog review ([grant-review.txt](logs/REMAINING-NINE-REVIEW-FIX/grant-review.txt)) | 37 functions (now incl. `audit_redact_value`): `anon`/`PUBLIC` EXECUTE on none; `audit_redact_value`, `audit_redact`, `audit_table_permission`, `audit_table_visible` not executable by `authenticated`; 0 definers without `search_path=""`; 8 new tables RLS on, SELECT-only for clients |

Specific confirmations (all asserted in `20261029150000_test_audit_reconciliation.sql`, run above against real audit-trigger output):
- nested `metadata.integrations.api_key` is **absent** from `search_audit_events` results;
- the `token` key inside a JSON **array** element is absent, and the element keeps its position;
- safe siblings stay visible (`metadata.integrations.safe_label = "retained"`, `array[0].safe`);
- `audit_redact_value` and `audit_redact` are not executable by PUBLIC, anon or authenticated;
- no cross-tenant or capability regression: tenant-isolation, forged-organization, branch-scope, and capability-filter assertions of the same file and of the E3.2 suite still pass.

**Remaining blocker:** none for this correction. Standing limitations are unchanged from §7 (no browser testing, no real Supabase Storage, no unattended cleanup scheduler, no restore drill).
