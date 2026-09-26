# Sections 27–30 handoff — HomePaw parity: invoice documents, grooming photos, payment control, visit management

**Status as of this revision: IN PROGRESS. Do not treat any module as complete.** Backend review fixes are landing; frontend for all four sections is not started. This file is the single entry point; update it after every milestone commit rather than at the end.

## 1. Identity, paths, branch

- Product scope: Operro (Next.js + Supabase, multi-org/multi-branch grooming SaaS). HomePaw parity catalog sections 27–30.
- Repo root (Windows): `E:\Claude\operro-sections-27-30`
- Repo root (WSL): `/mnt/e/Claude/operro-sections-27-30`
- GitHub: https://github.com/wbudiman1995-coder/Operro
- Branch: `claude/sections-27-30-documents-payments-visits`
- Pinned base SHA: `f820b6b904cffd9d7a24af7e395b8effc327fc06` (on `local/design-adoption`)
- Latest commit SHA: *(updated after each milestone — see §8)*
- Working tree: clean at each checkpoint commit; nothing force-pushed; nothing pushed to remote yet as of this revision.
- Branch comparison link: https://github.com/wbudiman1995-coder/Operro/compare/local/design-adoption...claude/sections-27-30-documents-payments-visits (populated once pushed)

**Isolation boundary respected:** a separate worktree (`E:\Claude\operro-review-s23-s26`, branch `claude/sections-23-26-memberships`) is fixing sections 23–26 in parallel. This branch does not read/write its containers, database, ports, or files, and does not merge its branch in. Overlap notes are in §9.

## 2. Local dev stack actually used (record real identity, not assumed)

Two SEPARATE database environments are used, and neither is the sections 23-26 worktree's or the pre-existing `operro-m13-local` stack (which occupies ports 54321–54324 on this machine and is untouched):

| Environment | Purpose | project_id | Ports (API/DB/Studio/Mail) | Postgres version |
|---|---|---|---|---|
| Isolated Supabase CLI stack | Real Auth/Storage/PostgREST/RLS testing, app dev server target | `operro-s2730-local` | 54341 / 54342 / 54343 / 54344 | **17.6** (Supabase CLI managed) |
| Plain Postgres container for gates | `run_all_gates.sh` mandated lineage/concurrency gates | n/a | *(set up in Milestone work — see §7)* | **16** (gate script requirement) |

`supabase/config.toml` on this branch was edited in place (a necessary shared-file change) to point at the isolated project/ports instead of the original `operro-m13-local` values, and to enable Storage (was `enabled = false`, which cannot satisfy the brief's "test actual local Supabase Storage" requirement). This is intentionally committed on this branch only.

Start/stop commands (from WSL, repo root):

```bash
supabase start        # brings up the isolated stack on the ports above
supabase db reset     # fresh replay of ALL migrations + seeds against it
supabase stop         # when done
```

## 3. Requirements matrix

*(Populated per catalog bullet as each is actually implemented and verified — this section starts honest-empty per the resume brief's instruction not to claim completion prematurely. See §6 for current per-module status and §7 for the concrete remaining checklist.)*

| # | Catalog bullet | HomePaw/Operro source | Status | Evidence |
|---|---|---|---|---|
| 27 | (all bullets) | apps/web/src/lib/invoice-workspace.ts, invoice-studio.tsx, invoices/actions.ts | Not started (frontend); backend schema drafted, under review-fix | — |
| 28 | (all bullets) | apps/web/src/components/grooming-evidence-form.tsx, pilot-actions.ts | Not started (frontend); backend RLS/delete drafted | — |
| 29 | (all bullets) | apps/web/src/app/finance/page.tsx, pilot-data.ts | Not started (frontend); backend stage workflow drafted, under review-fix | — |
| 30 | (all bullets) | apps/web/src/app/operations/page.tsx | Not started (frontend); backend manual-visit/billing drafted | — |

## 4. What was reused vs. added

**Reused as-is (per the pre-work reconnaissance):** invoice pricing/discount engine (`app.issue_invoice_for_booking`, `app.create_package_invoice`, `invoice_lines.pricing_breakdown`), the `attachments`/`attachment_links` generic storage registry, `buildWhatsAppUrl()` in `customer-360.tsx`, the booking status state machine and `app.complete_booking`, the `organizations.settings` jsonb convention for org-wide config, and the `app.assert_tenant_authorized` / capability-loop RLS pattern.

**Added (draft, backend only so far):**
- `supabase/migrations/20260927100000_visit_register.sql` — `manual_visits`, `visit_manual_billing` tables + RPCs (section 30).
- `supabase/migrations/20260928100000_payment_control_workflow.sql` — payment stage columns + RPCs (section 29). **Under active review-fix — see §5.**
- `supabase/migrations/20260929100000_grooming_evidence_hardening.sql` — evidence RLS tightening, retention, delete RPC (section 28).
- `supabase/migrations/20260930100000_invoice_documents.sql` — branding, bank accounts, WhatsApp/membership-terms settings, customer-facing notes (section 27).

No existing migration was rewritten; no booking/invoice/package RPC was duplicated.

## 5. Backend review findings and fixes (this pass)

A review of the draft migrations (recorded 2026-09-26) found real gaps before the backend can be called ready. All seven are now fixed in `supabase/migrations/20260927100000_visit_register.sql` and `20260928100000_payment_control_workflow.sql`, each with a regression assertion in `supabase/tests/S27-S30/test_backend.sql` (35/35 passing — see `docs/handoffs/logs/S27-S30/test_backend_run.log` for a fresh replay and `test_backend_on_populated_upgrade.log` for the same suite run against a populated-upgrade database).

| # | Finding | Fix | Status |
|---|---|---|---|
| 1 | `record_payment` idempotency race: two concurrent identical requests can both pass the request_key pre-check before either locks the invoice | `pg_advisory_xact_lock(hashtext(org::text \|\| ':' \|\| request_key::text))` acquired before the existing-row check, in both `record_payment` and `record_package_purchase_payment`. Same class of fix applied to `app.create_invoice_from_manual_visit` (section 30) and `app.upsert_organization_bank_account`'s cap-of-2 count (section 27), which had the identical pattern. | **Fixed** |
| 2 | Idempotent-retry branch check happens before the existing-row return, so a revoked branch grant isn't re-verified on retry | `app.has_branch()` is now checked on the retry-return path too, not just the fresh-insert path. | **Fixed** |
| 3 | Proof-attachment linkage only checks org/deleted_at, not that the attachment actually belongs to this invoice/customer/purpose | `record_payment` now requires the attachment to be linked via `attachment_links(subject_type='invoice', subject_id=<this invoice>)`; a `bank_transfer` payment is rejected outright with no proof at all (`proof_required_for_bank_transfer`); a linked proof is additionally re-linked to the resulting payment row; `confirm_payment_screenshot` re-checks `proof_attachment_id is not null` as defense in depth. | **Fixed** |
| 4 | Old `recordPaymentAction`/`sellPackageAction` in `pilot-actions.ts` inserted into `payments` directly, bypassing the new RPC/stage/idempotency entirely | `revoke insert, update on public.payments from authenticated;` — direct client writes are now impossible regardless of RLS/permission (same column/table-privilege pattern as `bookings.status`, SECTION 610). App code updated in the same milestone — see §M2 below. | **Fixed (migration); app code updated in M2** |
| 5 | Migration defaulted every historical payment's `payment_stage` to `bank_validated`, asserting a bank check that was never performed | New stage vocabulary: `not_applicable` (method never needed review — the new default), `legacy_unreviewed` (pre-existing `bank_transfer` rows, explicitly relabeled), `awaiting_screenshot` / `screenshot_confirmed` / `bank_validated` (only reachable through the real RPC pipeline going forward). The UI can now render three honest states instead of one false one. | **Fixed** |
| 6 | `record_payment` marked the invoice `paid` then separately wrote `overpaid_amount`, and the second UPDATE hit `tg_invoices_freeze` because the first had already flipped `old.status` to `paid` | Collapsed into one UPDATE with `case` expressions for `status`/`paid_at`/`metadata` together. Regression case added: a single cash overpayment (150000 against a 100000 invoice) now marks paid AND records `overpaid_amount: 50000` in one statement. | **Fixed** |
| 7 | New-organization/new-role provisioning path for the new permissions not yet verified | Verified: this codebase's only real org-provisioning path is the seed's "grant every current permission to the Owner role" wildcard pattern (`homepaw_demo.sql:31-32`), which already picks up new permissions automatically — no code change needed there. A test fixture proves a narrow, hand-picked role (`booking.read/create/update` only, created fresh after this migration) does **not** gain `payment.validate`/`evidence.read_all`, so the existing-org backfill cannot broaden a groomer/receptionist role. | **Fixed / verified** |

**Discovered while fixing #5/#6 (populated-upgrade specific):** the historical-label backfill UPDATE must run *after* dropping the old blanket `trg_payments_block_update` trigger, not before — on an EMPTY database that UPDATE matches zero rows and the ordering bug is invisible; on the populated-upgrade database (with the seeded `bank_transfer` payment) it failed with `Updates blocked on payments (append-only/immutable)`. Fixed by moving the `drop trigger` line earlier. This is exactly the "passed on empty, failed on populated" trap flagged in this project's own review history — caught here by actually testing the populated-upgrade path per the mandated evidence, not skipped.

## 6. Milestone status

- [x] **M0 — Preserve + handoff**: checkpoint committed, handoff created, smoke fragments consolidated into `supabase/tests/S27-S30/test_backend.sql` (35 assertions, self-contained fixtures, rolls back — rerunnable from any baseline), all 7 backend review findings fixed and verified on both fresh and populated-upgrade replay.
- [ ] **M1 — Section 30 visits**: backend hardening done; frontend register/filter UI not started.
- [~] **M2 — Section 29 payments**: `recordPaymentAction`/`sellPackageAction` rewired to `app.record_payment`/`app.record_package_purchase_payment` with proof-screenshot upload+linkage for bank_transfer; `PaymentForm`/`PackageSaleForm` updated (stable per-mount `requestKey`, conditional required proof file input). Browser-verified live against the isolated stack (real login as `wbudiman1995@gmail.com`, real Postgres/PostgREST/RLS): a cash payment on DEMO-INV-002 recorded successfully end-to-end and the "Pembayaran tercatat" total updated correctly; selecting Transfer without a proof file is blocked client-side ("Please select a file.") before it ever reaches the server. Still missing: the actual bank_transfer-with-real-upload path (this session's browser tool cannot drive the native OS file picker — needs a follow-up pass with a tool that can, or a Playwright-driven check), and the whole stage-review UI (confirm-screenshot / validate-bank-account buttons, stage/service-month filters, clickable totals, WhatsApp shortcut).
- [ ] **M3 — Section 28 evidence**: backend RLS/delete/retention done; frontend multi-upload/paste/drop not started.
- [ ] **M4 — Section 27 documents**: backend branding/bank-account/notes done; frontend (settings UI, invoice preview/PDF, WhatsApp) not started.
- [ ] **Final verification**: full gate suite (PG16), browser flows, multi-role/concurrency evidence.

## 7. Concrete remaining checklist

- [x] Consolidate `.holdback/smoke*.sql` into `supabase/tests/S27-S30/test_backend.sql`; run start-to-finish with `ON_ERROR_STOP`, no skipped prefix, fresh AND populated-upgrade.
- [x] Fix backend items 1–7 in §5, each with a passing regression case.
- [ ] **Blocking for M2**: rewrite `recordPaymentAction`/`sellPackageAction` in `apps/web/src/app/pilot-actions.ts` to call `app.record_payment`/`app.record_package_purchase_payment` — the old direct-insert code is now broken by the `revoke insert, update` in §5 item 4, not just insecure.
- [ ] Stand up a plain PostgreSQL 16 container for `run_all_gates.sh` (distinct port from everything above); run it and record exit codes.
- [ ] `npm run typecheck` / `npm run lint` / `npm run build` on this branch; record exit codes.
- [ ] Frontend for all four sections (see Milestones).
- [ ] Real browser verification: document preview/download/WhatsApp draft, evidence upload, payment stage checks, visit workflow — screenshots + console/network logs under `docs/handoffs/logs/S27-S30/`.
- [ ] Multi-role tests as actual authenticated roles (owner, read-only member, assigned groomer, unassigned groomer, cross-org member) — SQL-level RLS/permission coverage exists in `test_backend.sql`; real Supabase Auth session coverage still needed via the browser.
- [ ] TRUE two-session concurrency test (background psql processes, not sequential SQL) for `app.record_payment` racing the same request_key and two independent payments competing for one invoice's remaining balance.
- [ ] Second/empty organization: honest empty states, no crash, no borrowed demo data.
- [ ] Design note carried to M4: `public.grooming_jobs.groomer_notes` (an existing column, `20260721000500_scheduling_core.sql:289`) already holds real operational notes per booking — decide during the section-27 frontend milestone whether the invoice "groomer notes page" should read from THIS field instead of (or alongside) the new `invoices.customer_notes` column added here, rather than asking staff to retype the same note twice.

## 8. Commits on this branch (append after each milestone)

| SHA | Summary |
|---|---|
| `d2c88e2` | WIP checkpoint: draft backend migrations preserved (unreviewed) |

## 9. Overlap / dependency notes with sections 23–26

No table or RPC added here is touched by the sections 23–26 branch's known review items (membership renewal/reconciliation). `payments`, `invoices`, `attachments` are shared surfaces — sections 23-26 does not alter their schemas per its own handoff. Combined-branch validation is still required before either branch is considered mergeable; neither branch is approved for integration yet.

## 10. Owner QC checklist

*(To be filled in once frontend exists — placeholder removed at that point.)*
