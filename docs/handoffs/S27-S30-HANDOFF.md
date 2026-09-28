# Sections 27–30 handoff — HomePaw parity: invoice documents, grooming photos, payment control, visit management

**Status as of 2026-09-28: implementation closeout, with acceptance gaps listed in §11.** Engine 2 implemented the findings after the initial review, including the two evidence zones, cross-job photo history, internal/customer note review, ledger-backed package coverage, real keyset pagination, authenticated Storage authorization checks, and the invoice-number collision fix. The historical account in §1–§10 records the earlier state; §11 below is authoritative for the current branch. This branch is not merged or deployed.

**Latest verification:** on implementation HEAD `eca7bb3`, the fresh PostgreSQL 16 `run_all_gates.sh` passed GATE 1–8, including its concurrency gate; lint passed; `test:batch1a` passed 107/107 and `test:batch1b` passed 241/241. The separate `test:booking` run passed 11/12 with the same assertion already documented on the pinned base (§7); its failure is not hidden by the harness's exit 0. The real authenticated Storage HTTP suite passed 23/23. Raw logs: `docs/handoffs/logs/S27-S30/closeout/run_all_gates_full.log` and `s1_storage_auth_check.log`. **Still open:** actual PDF inspection with populated invoice lines/photos/terms (C5), true two-connection payment races, and the specific browser/organization acceptance checks in §11. Do not infer full production acceptance from the gate result.

## 1. Identity, paths, branch

- Product scope: Operro (Next.js + Supabase, multi-org/multi-branch grooming SaaS). HomePaw parity catalog sections 27–30.
- Repo root (Windows): `E:\Claude\operro-sections-27-30`
- Repo root (WSL): `/mnt/e/Claude/operro-sections-27-30`
- GitHub: https://github.com/wbudiman1995-coder/Operro
- Branch: `claude/sections-27-30-documents-payments-visits`
- Pinned base SHA: `f820b6b904cffd9d7a24af7e395b8effc327fc06` (on `local/design-adoption`)
- Latest commit SHA: see §8 for the full list; this revision of the handoff is committed alongside the final entry there.
- Working tree: clean at each checkpoint commit; nothing force-pushed.
- Branch comparison link: https://github.com/wbudiman1995-coder/Operro/compare/local/design-adoption...claude/sections-27-30-documents-payments-visits (populated once pushed)

**Isolation boundary respected:** a separate worktree (`E:\Claude\operro-review-s23-s26`, branch `claude/sections-23-26-memberships`) is fixing sections 23–26 in parallel. This branch does not read/write its containers, database, ports, or files, and does not merge its branch in. Overlap notes are in §9.

## 2. Local dev stack actually used (record real identity, not assumed)

Two SEPARATE database environments are used, and neither is the sections 23-26 worktree's or the pre-existing `operro-m13-local` stack (which occupies ports 54321–54324 on this machine and is untouched):

| Environment | Purpose | project_id | Ports (API/DB/Studio/Mail) | Postgres version |
|---|---|---|---|---|
| Isolated Supabase CLI stack | Real Auth/Storage/PostgREST/RLS testing, app dev server target | `operro-s2730-local` | 54341 / 54342 / 54343 / 54344 | **17.6** (Supabase CLI managed) |
| Plain Postgres container for gates | GATE 4/5/6 lineage/regression checks (run directly — see §7 for what's left of the full `run_all_gates.sh` wrapper) | n/a | `operro-gate-pg16`, host port 55432 | **16.15** (confirmed via `select version()`) |

`supabase/config.toml` on this branch was edited in place (a necessary shared-file change) to point at the isolated project/ports instead of the original `operro-m13-local` values, and to enable Storage (was `enabled = false`, which cannot satisfy the brief's "test actual local Supabase Storage" requirement). This is intentionally committed on this branch only.

Start/stop commands (from WSL, repo root):

```bash
supabase start        # brings up the isolated stack on the ports above
supabase db reset     # fresh replay of ALL migrations + seeds against it
supabase stop         # when done
```

## 3. Requirements matrix

Status key: **Done** = implemented + backend-tested; **Done, browser-verified** = also clicked through live against the isolated stack; **Partial** = implemented but a real gap remains (explained); **Not tested** = implemented, not yet exercised; **Not started**.

### Section 27 — invoice documents and customer communication

| Catalog bullet | Status | Evidence |
|---|---|---|
| Live invoice preview | Done, browser-verified | `/invoices/[invoiceId]`; live-rendered DEMO-INV-003 |
| Branded business name, logo, tagline | Done | Real upload/replace/remove (`updateInvoiceLogoAction`, JPG/PNG/WebP <=1MB, replace never leaves the org logo-less on failure) + rendered on the invoice document header; typecheck/lint clean, not yet browser-clicked this pass (see §11 C1) |
| Customer contact and address | Done, browser-verified | Full address incl. kecamatan/kabupaten rendered live for a real customer |
| Pet details / Groomer name | Done | `lib/invoice-document.ts` (pets via grooming_job_pets; groomer via existing `groomer_name_snapshot`) |
| Service / discount / additional-charge itemization | Done | Reuses `invoice_lines` snapshot as-is; no seeded invoice with lines to browser-verify visually (seed data limitation, confirmed via SQL, not a bug) |
| Subscription and token balances | Done | Package balance section reads `customer_packages`/ledger via `metadata->>source_invoice_id` |
| Payment instructions / up to two bank accounts | Done, browser-verified | Shown only while a balance is due; live-verified with a real BCA account |
| Due-date display | Done, browser-verified | |
| Paid-via-subscription service reports | Done | `document_type='service_report'` branch excludes bank instructions |
| Membership terms page | Partial | Renders org-wide terms text on package-sale invoices; not a separate "page" (print `break-before-page`), not browser-verified against a real package invoice (none in seed) |
| Groomer-notes page | Partial | Uses new `invoices.customer_notes`, not the pre-existing `grooming_jobs.groomer_notes` — reconciliation left open, see §7 |
| Before/after and operational photo page | Done | Excluded for package-sale invoices; not browser-verified against a real photographed booking (none in seed) |
| Printable/downloadable PDF | Done, browser-verified | Native browser print-to-PDF, no new dependency |
| Customer-friendly PDF filename | Done | `sanitizeFilename()` sets `document.title` before print |
| One-click WhatsApp handoff | Done, browser-verified | Real `wa.me` href inspected and matched the expected interpolated message |
| Editable WhatsApp templates (3 scenarios) | Done, browser-verified | Saved via Settings, confirmed reflected in the generated link |
| Groomer notes inserted into customer communication | Partial | Shown on the document; not yet inserted into the WhatsApp message text itself |

### Section 28 — grooming photo documentation

| Catalog bullet | Status | Evidence |
|---|---|---|
| Before/after zones, multiple images, browse/paste/drag-drop | Done, browser-verified | One zone + category select (not two separate always-visible zones — see M3 note); drag-and-drop verified live end-to-end with a real upload |
| Image compression | Done | Pre-existing `compressPhoto()`, unchanged, reused per queued file |
| Photos from linked appointments, all categories | Done | Categories were already complete pre-existing; multi-upload is new |
| Upload-time display | Done, browser-verified | Caption shows category + date |
| Photo history inside groomer reports | Not started | No dedicated cross-job history page; still inline per-job on `/my-schedule` |
| Photos in applicable invoice/service-report documents | Done | `/invoices/[invoiceId]` pulls booking-linked photos, batched signed URLs |
| Package-sale invoices exclude irrelevant photos | Done | Explicit `billing_mode !== 'package_sale'` guard in the loader |

### Section 29 — payment-control workflow

| Catalog bullet | Status | Evidence |
|---|---|---|
| 3-stage process (awaiting screenshot / confirmed / bank-validated) | Done, browser-verified (SQL); UI stage transitions not live-clicked | `supabase/tests/S27-S30/test_backend.sql`; register renders stage chips live |
| Timestamp each check | Done | `screenshot_confirmed_at`/`bank_validated_at`, immutable once set |
| Filter by stage / service month | Done, browser-verified | Service month uses the booking's real visit date, not `paid_at` |
| Search by invoice or customer | Done, browser-verified | |
| Clickable totals per stage | Done, browser-verified | Stage chips double as filters, correct totals rendered live |
| Separate "Payment Successful" / "Validated" states | Done | `status='succeeded'` vs `payment_stage='bank_validated'`, documented design choice in the migration |
| Hide editing/deletion after validation | Done, browser-verified | Privilege revoke + freeze trigger, both independently verified |
| Customer WhatsApp shortcut from the financial list | Done, browser-verified | |
| Distinguish after-visit vs package invoices | Done | Existing `billing_mode`, surfaced as a badge |
| Admin-controlled, no bank API | Done | By construction — no external integration added |

### Section 30 — visit management

| Catalog bullet | Status | Evidence |
|---|---|---|
| Automatic visit history from past appointments | Done, browser-verified | Read projection over completed bookings, no new state |
| Optional automatic logging setting | Done | Now actually enforced: off suppresses the booking-derived projection (manual visits unaffected). `loadVisitRegister({ autoLogEnabled })`; not browser-clicked this pass |
| Manually add visits | Done, browser-verified | Live-created, appeared immediately |
| Filter by search/customer/pet/invoiced-status, sort newest/oldest | Done | Pet filter now compares pet IDs, not names (name collision was a real bug), and has a reachable dropdown in the UI (previously the type supported it but no control existed); not live-clicked this pass |
| Link visits to invoices | Done | `app.link_manual_visit_invoice`, SQL-tested |
| Create an invoice from a visit | Partial | RPC + button built and SQL-tested (idempotency case); booking-row `invoiceId`/`invoicedStatus` now resolve a real non-void invoice instead of order-existence (was always null/wrong — see §11 C7); not live-clicked in the browser this session |
| Mark manually billed (amount + note) | Done, browser-verified | |
| Undo manual billing | Done, browser-verified | |
| Delete orphaned/incorrect visits | Done, browser-verified | Soft-delete with linked-invoice/active-billing guard |
| Session-source badges | Done, browser-verified | "Dari booking" / "Manual" |
| Manually billed revenue in dashboard reporting | Done, browser-verified | New stat card in `/reports`, plus `/dashboard`'s `revenueToday` |

## 4. What was reused vs. added

**Reused as-is (per the pre-work reconnaissance):** invoice pricing/discount engine (`app.issue_invoice_for_booking`, `app.create_package_invoice`, `invoice_lines.pricing_breakdown`), the `attachments`/`attachment_links` generic storage registry, `buildWhatsAppUrl()` in `customer-360.tsx`, the booking status state machine and `app.complete_booking`, the `organizations.settings` jsonb convention for org-wide config, and the `app.assert_tenant_authorized` / capability-loop RLS pattern.

**Added — backend (migrations, all four verified on fresh + populated-upgrade + PG16, see §5):**
- `supabase/migrations/20260927100000_visit_register.sql` — `manual_visits`, `visit_manual_billing` tables + RPCs (section 30).
- `supabase/migrations/20260928100000_payment_control_workflow.sql` — payment stage columns + RPCs (section 29).
- `supabase/migrations/20260929100000_grooming_evidence_hardening.sql` — evidence RLS tightening, retention, delete RPC (section 28).
- `supabase/migrations/20260930100000_invoice_documents.sql` — branding, bank accounts, WhatsApp/membership-terms settings, customer-facing notes (section 27).

**Added — frontend:**
- Section 30: `lib/visit-register.ts`, `app/visit-actions.ts`, `components/visit-register.tsx`, `app/visits/page.tsx`.
- Section 29: `lib/payment-register.ts`, `app/payment-actions.ts`, `components/payment-register.tsx`; `pilot-actions.ts`'s `recordPaymentAction`/`sellPackageAction` rewired to the new RPCs; `pilot-forms.tsx`'s `PaymentForm`/`PackageSaleForm` updated.
- Section 28: `components/grooming-evidence-form.tsx` rewritten (multi-upload/drag-drop/paste/delete); `pilot-actions.ts`'s `deleteGroomingEvidenceAction` added.
- Section 27: `app/document-settings-actions.ts`, `components/document-settings-form.tsx`, `app/settings/documents/page.tsx`; `lib/invoice-document.ts`, `components/invoice-document-actions.tsx`, `components/invoice-customer-notes-editor.tsx`, `app/invoices/[invoiceId]/page.tsx`.
- Shared: `components/workspace-shell.tsx` (nav links), `lib/authorization.ts` (added `settings.manage` to the pre-resolved capability list — a real `next build` typecheck failure, fixed), `lib/pilot-data.ts` (manually-billed revenue folded into dashboard/report totals).

No existing migration was rewritten; no booking/invoice/package RPC was duplicated.

## 5. Backend review findings and fixes

A review of the draft migrations (recorded 2026-09-26) found 7 real gaps; running the actual PostgreSQL 16 gate engine later found 2 more real, PG16-specific gaps missed entirely by the Supabase-managed PG17 dev stack. All 9 are fixed, each with a regression assertion in `supabase/tests/S27-S30/test_backend.sql` (35/35 passing on all three tested configurations — fresh PG17 replay, populated-PG17-upgrade replay, and fresh PG16 replay; see `docs/handoffs/logs/S27-S30/test_backend_run.log`, `test_backend_on_populated_upgrade.log`, and `test_backend_on_pg16.log`).

| # | Finding | Fix | Status |
|---|---|---|---|
| 1 | `record_payment` idempotency race: two concurrent identical requests can both pass the request_key pre-check before either locks the invoice | `pg_advisory_xact_lock(hashtext(org::text \|\| ':' \|\| request_key::text))` acquired before the existing-row check, in both `record_payment` and `record_package_purchase_payment`. Same class of fix applied to `app.create_invoice_from_manual_visit` (section 30) and `app.upsert_organization_bank_account`'s cap-of-2 count (section 27), which had the identical pattern. | **Fixed** |
| 2 | Idempotent-retry branch check happens before the existing-row return, so a revoked branch grant isn't re-verified on retry | `app.has_branch()` is now checked on the retry-return path too, not just the fresh-insert path. | **Fixed** |
| 3 | Proof-attachment linkage only checks org/deleted_at, not that the attachment actually belongs to this invoice/customer/purpose | `record_payment` now requires the attachment to be linked via `attachment_links(subject_type='invoice', subject_id=<this invoice>)`; a `bank_transfer` payment is rejected outright with no proof at all (`proof_required_for_bank_transfer`); a linked proof is additionally re-linked to the resulting payment row; `confirm_payment_screenshot` re-checks `proof_attachment_id is not null` as defense in depth. | **Fixed** |
| 4 | Old `recordPaymentAction`/`sellPackageAction` in `pilot-actions.ts` inserted into `payments` directly, bypassing the new RPC/stage/idempotency entirely | `revoke insert, update on public.payments from authenticated;` — direct client writes are now impossible regardless of RLS/permission (same column/table-privilege pattern as `bookings.status`, SECTION 610). App code updated in the same milestone — see §M2 below. | **Fixed (migration); app code updated in M2** |
| 5 | Migration defaulted every historical payment's `payment_stage` to `bank_validated`, asserting a bank check that was never performed | New stage vocabulary: `not_applicable` (method never needed review — the new default), `legacy_unreviewed` (pre-existing `bank_transfer` rows, explicitly relabeled), `awaiting_screenshot` / `screenshot_confirmed` / `bank_validated` (only reachable through the real RPC pipeline going forward). The UI can now render three honest states instead of one false one. | **Fixed** |
| 6 | `record_payment` marked the invoice `paid` then separately wrote `overpaid_amount`, and the second UPDATE hit `tg_invoices_freeze` because the first had already flipped `old.status` to `paid` | Collapsed into one UPDATE with `case` expressions for `status`/`paid_at`/`metadata` together. Regression case added: a single cash overpayment (150000 against a 100000 invoice) now marks paid AND records `overpaid_amount: 50000` in one statement. | **Fixed** |
| 7 | New-organization/new-role provisioning path for the new permissions not yet verified | Verified: this codebase's only real org-provisioning path is the seed's "grant every current permission to the Owner role" wildcard pattern (`homepaw_demo.sql:31-32`), which already picks up new permissions automatically — no code change needed there. A test fixture proves a narrow, hand-picked role (`booking.read/create/update` only, created fresh after this migration) does **not** gain `payment.validate`/`evidence.read_all`, so the existing-org backfill cannot broaden a groomer/receptionist role. | **Fixed / verified** |
| 8 (found by PG16 gate) | `manual_visits`, `visit_manual_billing`, `organization_bank_accounts` had no explicit `grant ... to authenticated` — masked entirely on the Supabase-managed dev stack, which auto-applies platform-level default privileges to new tables; a bare Postgres has no such safety net | Added the same explicit table grant every prior migration's own new table already has (convention: `20260917100000_customer_addresses.sql:62`). | **Fixed** |
| 9 (found by PG16 gate) | The shared gate bootstrap's `auth.uid()` stub returns NULL (fine for every pre-existing gate test); this branch's `chk_visit_manual_billing_undo` is the first constraint to actually require a non-null actor from it | Fixed inside `test_backend.sql` only — a transactional, self-reverting `auth.uid()` override reading the same JWT-claims GUC the test already sets. The shared `integration/gate_bootstrap_extensions.sql` and every product migration are untouched. | **Fixed** |

**Discovered while fixing #5/#6 (populated-upgrade specific):** the historical-label backfill UPDATE must run *after* dropping the old blanket `trg_payments_block_update` trigger, not before — on an EMPTY database that UPDATE matches zero rows and the ordering bug is invisible; on the populated-upgrade database (with the seeded `bank_transfer` payment) it failed with `Updates blocked on payments (append-only/immutable)`. Fixed by moving the `drop trigger` line earlier. This is exactly the "passed on empty, failed on populated" trap flagged in this project's own review history — caught here by actually testing the populated-upgrade path per the mandated evidence, not skipped.

**Discovered while running the real PG16 gate (#8/#9):** both were invisible on the Supabase-managed dev stack used for every browser-verification pass earlier in this handoff. This is the concrete reason the brief mandates the bare-engine gate suite instead of accepting the managed dev stack as sufficient evidence — see `docs/handoffs/logs/S27-S30/pg16_gate_evidence.md` for the full run.

## 6. Milestone status

- [x] **M0 — Preserve + handoff**: checkpoint committed, handoff created, smoke fragments consolidated into `supabase/tests/S27-S30/test_backend.sql` (35 assertions, self-contained fixtures, rolls back — rerunnable from any baseline), all 7 backend review findings fixed and verified on both fresh and populated-upgrade replay.
- [x] **M1 — Section 30 visits**: new `lib/visit-register.ts` (unions completed bookings + manual_visits, no new booking-side state), `app/visit-actions.ts` (create/delete manual visit, mark/undo manual billing, create invoice from visit, auto-log toggle), `components/visit-register.tsx` + `app/visits/page.tsx`, nav link added. **Browser-verified live end-to-end** against the isolated stack: created a manual visit (appeared immediately with "Manual"/"Belum tertagih" badges and Tandai/Buat invoice/Hapus actions) → marked a booking-sourced visit manually billed (Rp 175.000, badge flipped to "Tertagih manual") → undid it (badge flipped back, button reverted) → deleted the manual visit (soft-deleted, disappeared from the list). All four core workflows work through the real RPCs via a real browser session, not just SQL.
  - Not yet verified live: "Buat invoice" (create_invoice_from_manual_visit) and the auto-log toggle's actual effect (there is no automatic-logging *writer* yet — see gap below).
  - **Gap found while building this milestone:** the brief's "optional automatic logging setting" bullet needs something that actually creates visit rows automatically as bookings complete; today the register is a live projection (a completed booking always appears, unconditionally) and the toggle only stores a preference with no reader/writer honoring it yet. Decide in a follow-up whether "automatic" should mean (a) the projection is inherently automatic and the setting instead controls something else (e.g. whether manual staff must additionally confirm a visit before dashboard reporting counts it), or (b) a real job/trigger should materialize a row only when the setting is on. Left as an explicit open question rather than a guessed implementation.
- [x] **M2 — Section 29 payments**: `recordPaymentAction`/`sellPackageAction` rewired to `app.record_payment`/`app.record_package_purchase_payment` with proof-screenshot upload+linkage for bank_transfer; `PaymentForm`/`PackageSaleForm` updated (stable per-mount `requestKey`, conditional required proof file input). New `apps/web/src/lib/payment-register.ts` (data) + `apps/web/src/app/payment-actions.ts` (confirm/validate actions) + `apps/web/src/components/payment-register.tsx` (UI): stage/service-month/search filters, clickable stage totals, per-row confirm-screenshot/validate-bank-account buttons gated by stage, WhatsApp shortcut. Wired into `/finance`. Browser-verified live against the isolated stack (real login as `wbudiman1995@gmail.com`, real Postgres/PostgREST/RLS): a cash payment on DEMO-INV-002 recorded end-to-end, the stat totals updated, the register rendered its stage chips with correct totals (`Rp 325.001` under "Tidak perlu review", `Rp 0` elsewhere) and the new row with a WhatsApp button; selecting Transfer without a proof file is blocked client-side ("Please select a file.") before it reaches the server.
  - **Environment note:** during this verification pass, `loadPaymentRegister` intermittently threw `TypeError: fetch failed` from the Next.js dev server to the isolated Supabase stack, then succeeded consistently seconds later with no code change. This matches the WSL2-mirrored-networking warning `supabase start` prints on this machine and the periodic container health-check restarts observed throughout this session (`docs/handoffs/logs/S27-S30/` gate logs), not a bug in the query — but it means **any single failed page load during manual/browser testing on this machine should be retried before being treated as a real regression**, and real CI/gate runs should not share this host's flaky Docker networking.
  - Still missing: the actual bank_transfer-with-real-upload path (this session's browser tool cannot drive the native OS file picker — needs a follow-up pass with a tool that can, or a Playwright-driven check), and confirm/validate button clicks have not yet been exercised live (only their absence/presence and gating logic were verified).
- [x] **M3 — Section 28 evidence**: `grooming-evidence-form.tsx` rewritten — a single drop zone now accepts click-to-browse (multi-select), drag-and-drop, and clipboard paste, queues files client-side, compresses and uploads them ONE AT A TIME through the existing, unchanged `uploadGroomingEvidenceAction` (server-side assignment/validation logic untouched — only client-side file collection is new), with per-file progress and a partial-failure summary. Added `deleteGroomingEvidenceAction` (wraps `app.delete_grooming_evidence`) and a delete button on each gallery thumbnail, guarded by `window.confirm`.
  - **Browser-verified live end-to-end** as the real assigned groomer (`groomer@homepaw.local`): simulated a drag-and-drop of a real JPEG onto the zone (native OS file-picker dialogs aren't automatable from this session's browser tool, so drag-and-drop was exercised via a real `DragEvent`/`DataTransfer`, which is the same code path a real drop uses) → file queued ("1 foto siap diunggah") → uploaded → gallery updated with the real thumbnail via a real signed URL, "Before · 26/9/2026" caption, category badge. Confirmed via SQL that the attachment row exists and is not soft-deleted. Clicking the delete (✕) button correctly did nothing without confirming the native dialog (this session's tooling cannot accept a `window.confirm`), which is the safe default, not a bug — the delete action itself was separately verified via the section-27/29 test suite's RPC-authorization coverage, not live-clicked here.
  - Not yet built: distinct "before zone" / "after zone" as two separate always-visible upload areas (current UI is one zone + a category dropdown, which covers the same requirement functionally but not visually as two zones); a dedicated "groomer report history" page browsing evidence across jobs/dates (today evidence is still only visible inline per-job on `/my-schedule`).
- [x] **M4 — Section 27 documents**: `/settings/documents` (branding tagline, membership terms, 3 WhatsApp templates, up-to-2 bank accounts — new `document-settings-actions.ts` + `document-settings-form.tsx`) and `/invoices/[invoiceId]` (the printable/downloadable document — new `lib/invoice-document.ts`, `invoice-document-actions.tsx`, `invoice-customer-notes-editor.tsx`). The document reuses persisted snapshots only (`invoice_lines`, `groomer_name_snapshot`) — nothing is recomputed from today's catalog. Package-sale invoices exclude photos and show the package/session balance instead; after-visit invoices show customer/pet/groomer, line items, bank instructions (only while a balance is due), and any customer-facing groomer note. WhatsApp button picks the paid/outstanding/subscription template automatically from the invoice's actual balance and billing mode, interpolates `{customer}/{number}/{total}`, and opens a real `wa.me` draft — never sends automatically. "Cetak / Unduh PDF" uses the browser's native print-to-PDF (no new PDF dependency) with a sanitized suggested filename.
  - **Browser-verified live, mostly end-to-end:** saved real branding/terms/WhatsApp-template text and a bank account in Settings → reloaded `/invoices/d0000...1103` and saw the actual saved tagline, the bank account under "Instruksi pembayaran", and the customer's real name/phone/full address (kecamatan/kabupaten join confirmed working) → the WhatsApp button's `href` was inspected directly and matched exactly: `https://wa.me/6281210000304?text=...masih%20belum%20lunas%20ya%20kak.` (my custom outstanding template, correctly chosen because the invoice has a balance, with `{customer}/{number}/{total}` all substituted correctly).
  - **Not completed live: saving a customer-facing note via `/invoices/[id]`.** This host's Docker/WSL stack degraded severely during this pass — containers were observed cycling ("Up 10 seconds") repeatedly under visible CPU pressure (`docker stats` showed `pg-meta`/`analytics` at 100%+ CPU), and every attempt (7 total, across ~20 minutes, including after explicit multi-minute stability waits confirmed by 3 consecutive successful `psql` probes) failed with the IDENTICAL error, always in the SAME pre-existing, untouched function: `organization_resolution_failed:TypeError: fetch failed` at `src/lib/organizations.ts:141`, inside `loadAuthContext` — i.e. the failure is in session/org resolution common to every page on this app, not in anything built for section 27. Every other write path exercised in this same session (payments, visit billing, bank accounts, branding settings, evidence upload) succeeded live, several on the first attempt — this one specific click simply kept landing in an unlucky window. The RPC itself (`app.update_invoice_customer_notes`) is exercised by `supabase/tests/S27-S30/test_backend.sql` (its lock/reject path: "customer-notes edit correctly rejected once invoice is paid"); its success path uses the exact same revision-checked update pattern already verified live for `app.upsert_organization_bank_account` and `app.update_invoice_document_settings`. Re-run this one click on a quieter host to close the loop; do not re-attempt by adding retry/timeout logic to the app code, since the fault is the local Docker host, not the request.
  - Also fixed in this pass: `lib/invoice-document.ts`'s photo loader used a per-photo signed-URL call (the same N+1 shape flagged elsewhere in this codebase); batched into one `createSignedUrls` call.
  - Not yet built: logo image upload (branding text/terms/templates only), a real membership-terms page distinct from the inline section shown, and a dedicated groomer-notes source reconciliation — see the `grooming_jobs.groomer_notes` note in §7.
- [x] **Final verification (partial — see checklist below for what's left)**: PG16 gate suite run directly (found + fixed 2 real bugs, §5 items 8-9); `npm run build`/`typecheck`/`lint` all clean; pre-existing regression suites `test:batch1a` (107/107) and `test:batch1b` (241/241) clean, `test:booking` has exactly one pre-existing failing assertion confirmed present in the pinned base commit before this branch touched anything (unrelated to sections 27-30 — see checklist). True two-session concurrency and a second/empty-organization pass are not done.

## 7. Original delivery checklist (historical; current status in §11)

This was written before the later closeout commits. Refer to §11 for the current completion and verification status.

- [ ] **The one browser click not completed live**: saving a customer note on `/invoices/[id]` (M4) — code is correct (SQL-tested, identical pattern verified live elsewhere), just never got a clean window on this host. Retry on a quieter machine.
- [x] Run the FULL `run_all_gates.sh` wrapper itself against PostgreSQL 16. GATE 1–8 passed on 2026-09-28; raw log is `docs/handoffs/logs/S27-S30/closeout/run_all_gates_full.log`.
- [ ] TRUE two-session concurrency test (two real concurrent connections, not sequential SQL in one transaction) for `app.record_payment` racing the same `request_key`, and two independent payments competing for one invoice's remaining balance. The advisory-lock fix (§5 item 1) is reasoned to be correct but has not been proven under genuine concurrent load.
- [ ] Multi-role browser sessions beyond owner + one assigned groomer (both used this session): a read-only member, an unassigned groomer attempting a denied action, and a cross-organization member. SQL-level RLS/permission coverage for these roles exists in `test_backend.sql`; real Supabase Auth sessions for them are not yet exercised.
- [ ] Second/empty organization: honest empty states for all four new UI surfaces (`/visits`, `/settings/documents`, the payment register, the invoice document), no crash, no borrowed demo data.
- [ ] A real bank_transfer payment recorded through the actual UI with a real uploaded proof file (this session's browser tool cannot drive the native OS file picker; the requirement was proven via drag-and-drop for evidence photos instead, and via direct RPC calls in the SQL suite for the proof-linkage logic itself).
- [ ] `apps/web/test/booking-wizard-contract.test.ts`'s "invoice pricing honors package coverage and snapshotted category discounts" assertion fails — **confirmed pre-existing**: `git show f820b6b:apps/web/src/app/pilot-actions.ts | grep list_booking_package_coverage` finds nothing in the pinned base commit either, before this branch changed anything. It expects an `app.list_booking_package_coverage` RPC call that was apparently never wired into `pilot-actions.ts` even though its migration (`20260922100000_booking_package_coverage.sql`) exists — a section-23 ("Coverage detection") gap per `docs/HOMEPAW_PARITY_PLAN.md`, not a sections-27-30 regression. Left unfixed as out of scope; flagging here so it is not later mistaken for something this branch broke.
- [x] Distinguish internal `grooming_jobs.groomer_notes` from customer-facing invoice notes and provide explicit review/copy before sharing; see C4 in §11.
- [x] Distinct visual "Sebelum" and "Sesudah" upload zones; see C2 in §11.
- [x] Cross-job evidence history in the existing groomer performance workflow; see C3 in §11.
- [x] Brand logo upload; see C1 in §11.
- [x] Define the automatic-visit setting as controlling the booking-derived visit projection; see C6 in §11.
- [ ] Verify the final WhatsApp/customer-note content against a real populated invoice; see C4/C5 in §11.

## 8. Commits on this branch

| SHA | Summary |
|---|---|
| `d2c88e2` | WIP checkpoint: draft backend migrations preserved (unreviewed) |
| `4a8c3ce` | Add S27-S30 consolidated handoff skeleton |
| `f1f8cc0` | M0: fix 7 backend review findings, consolidate test suite |
| `73dc486` | M2 (partial): wire payment forms to the new RPCs |
| `7cdbe5b` | M2: payment-control register UI (stages, filters, WhatsApp) |
| `5b8575d` | M1: section 30 visit register frontend, verified live |
| `871fa20` | M3: multi-upload/drag-drop/paste grooming evidence, verified live |
| `09133e4` | M4: invoice document (branding/bank/WhatsApp/PDF), verified live |
| `7acdf25` | Fix: add settings.manage to the pre-resolved capability list |
| `c7e5270` | Fix 2 real bugs found by the mandated PostgreSQL 16 gate harness |
| `acf5268` | Finalize S27-S30 handoff: full requirements matrix, QC checklist (external review point) |
| `18ea1e0` | Closeout: fix gate lineage, mark handoff in-closeout |
| `34da306` | Closeout P1/P3: fix payment idempotency at the app boundary, retire obsolete package-sale engine |
| `01a4d89` | Closeout: fix gate lineage (the 5th migration), payment-register P2/P4, add brand-logo upload (C1) |
| `3431ec3` | Closeout C6/C7: enforce the auto-visit setting, fix visit invoicing correctness |
| `772cb08` | Implement C2 two evidence zones, C3 cross-job history, C4 note review, and C8 ledger-backed package coverage |
| `2cdd13e` | Implement real server-side keyset pagination for payment and visit registers |
| `a78d935` | Harden Storage authorization and prove 23/23 real authenticated HTTP checks |
| `eca7bb3` | Fix invoice-number random suffix with forward migration and regression check |

## 9. Overlap / dependency notes with sections 23–26

No table or RPC added here is touched by the sections 23–26 branch's known review items (membership renewal/reconciliation). `payments`, `invoices`, `attachments` are shared surfaces — sections 23-26 does not alter their schemas per its own handoff. Combined-branch validation is still required before either branch is considered mergeable; neither branch is approved for integration yet.

## 10. Owner QC checklist

Use the demo login (`wbudiman1995@gmail.com` / `operro-local-qa`, org "HomePaw Demo") against the isolated dev stack (`supabase start` from this branch, then `npm run dev --workspace web`).

1. **Kunjungan** (left nav, under "Operasional") → fill "Catat kunjungan manual" (pick a cabang/pelanggan, isi layanan, tanggal) → klik "Catat kunjungan manual". *Expected:* baris baru muncul dengan badge ungu "Manual" dan "Belum tertagih".
2. On that same new row, klik "Tandai tertagih manual" → isi jumlah → "Simpan". *Expected:* badge berubah jadi "Tertagih manual" kuning, jumlah tampil. Klik "Batalkan penagihan" untuk membatalkan — badge kembali ke "Belum tertagih".
3. Klik "Hapus" pada kunjungan manual (tanpa invoice/tagihan aktif). *Expected:* baris hilang dari daftar.
4. **Keuangan** → "Catat pembayaran": pilih invoice belum lunas, metode "Transfer". *Expected:* muncul field "Bukti transfer (wajib)"; coba submit tanpa foto → browser menolak ("Please select a file"). Ganti metode ke "Tunai", isi jumlah kelipatan yang valid (hindari angka bulat ribuan persis, bug lama pada field ini), submit. *Expected:* "Pembayaran berhasil dicatat.", invoice terkunci, total di "Kontrol pembayaran" naik.
5. Di "Kontrol pembayaran", klik salah satu kartu tahap (mis. "Tidak perlu review"). *Expected:* daftar di bawah ikut terfilter, hanya baris tahap itu yang tampil.
6. **Pengaturan dokumen** (bawah nav) → isi tagline, satu template WhatsApp, tambah 1 rekening bank → simpan. *Expected:* pesan sukses hijau; coba tambah rekening ke-3 → ditolak dengan pesan "maksimum 2 rekening bank".
7. Buka invoice apa pun dari daftar di **Keuangan** (klik nomor invoice biru). *Expected:* halaman dokumen menampilkan nama bisnis + tagline, alamat lengkap pelanggan, rekening bank (jika belum lunas), dan tombol WhatsApp/Cetak. Klik tombol WhatsApp → tab baru wa.me terbuka dengan pesan yang sudah terisi (tidak otomatis terkirim).
8. **Jadwal saya** (login sebagai `groomer@homepaw.local` / sandi sama) → pada pekerjaan yang belum selesai, coba unggah beberapa foto sekaligus ke "Dokumentasi layanan" (drag beberapa file, atau klik untuk pilih banyak). *Expected:* semua foto masuk galeri dengan label kategori dan tanggal; tombol ✕ pada setiap foto meminta konfirmasi sebelum menghapus.

Any deviation from the "Expected" column is a real regression, not a flaky test — investigate before dismissing it (this handoff's own history has two examples of exactly that: §5 items 8-9).

## 11. Closeout pass (Codex review of `acf5268`)

Status per finding. Evidence lands under `docs/handoffs/logs/S27-S30/closeout/`.

| # | Finding | Files | Status |
|---|---|---|---|
| Gate | `run_all_gates.sh` `EXPECTED_MIGRATIONS` never listed the 4 sections-27-30 migrations, then never listed the 5th (this closeout's own migration) either — hard `Migration lineage mismatch` before Gate 1, twice | `run_all_gates.sh` | **Fixed, verified** — full `run_all_gates.sh` (GATE 1-8, incl. PG16 concurrency) passes end to end |
| P1 | Payment idempotency breaks at the app boundary: fresh `external_ref`/proof attachment on every submit defeats `record_payment`'s changed-input check; `PaymentForm`'s request key never advances after success; amount `step=1000` rejected valid amounts | `apps/web/src/app/pilot-actions.ts`, `apps/web/src/components/pilot-forms.tsx`, `20261001100000_payment_workflow_closeout.sql` | **Fixed, gate-verified** — deterministic `ensurePaymentProof`/`callRecordPayment` helpers (see commit `34da306`). **Not verified**: the acceptance suite's real two-connection concurrency cases (simultaneous same-key sessions, competing payments, lost-response recovery) — designed for but not exercised live this pass |
| P2 | Payment register never shows the proof being confirmed, no actor/time, confirm/validate buttons not capability-gated | `apps/web/src/components/payment-register.tsx`, `apps/web/src/lib/payment-register.ts` | **Fixed, typecheck/lint-verified.** Proof viewer/register rendering and filters were exercised against real data during closeout; the complete confirm→validate click path remains unverified. |
| P3 | New package payments mislabeled `legacy_unreviewed`; obsolete package-sale-outside-invoice path duplicated the already-existing `app.create_package_invoice` | `apps/web/src/app/pilot-actions.ts`, migration | **Fixed, gate-verified** — `sellPackageAction` now calls `app.create_package_invoice` + the same P1 proof/payment pipeline; `app.record_package_purchase_payment` dropped in the migration and its RPC call site removed. Not browser-clicked this pass |
| P4 | Register hard-limits 200 rows before filtering; totals don't match the search/month scope | `20261002100000_payment_visit_register_pagination.sql`, `apps/web/src/lib/payment-register.ts`, `apps/web/src/components/payment-register.tsx` | **Implemented and gate/typecheck/lint-verified** — server-side search/month/stage filters and keyset pagination replace the former raised cap (`2cdd13e`). Register filtering rendered against real data. A >200-row, multi-month browser fixture remains unverified. |
| S1 | Storage UPDATE/DELETE for grooming evidence still open to any `booking.update` holder org-wide; evidence-delete RPC doesn't verify the attachment is actually grooming evidence before deleting; payment-proof isolation not guaranteed | `20261003100000_storage_authorization_review.sql`, `apps/web/scripts/s1-storage-auth-check.mjs` | **Fixed and independently HTTP-verified** — real authenticated Storage suite 23/23 passed, including path forgery, cross-branch and payment-proof separation; raw `s1_storage_auth_check.log` (`a78d935`). |
| C1 | Brand logo: text-only, no real upload | `document-settings-actions.ts`, `document-settings-form.tsx`, `settings/documents/page.tsx`, `invoice-document.ts`, invoice document page | **Fixed, typecheck/lint-verified** — real upload/replace/remove (`updateInvoiceLogoAction`; replace uploads-then-switches-then-cleans-up so a failure never leaves the org logo-less or with two live copies), rendered on both the settings page and the invoice document header. Also fixed a real latent bug found while building this: `updateInvoiceDocumentSettingsAction` hardcoded `p_logo_attachment: null` on every tagline/template save, which would have silently wiped any logo the moment it existed. Not browser-clicked this pass |
| C2 | Before/after: one zone + dropdown, not two labeled zones | `apps/web/src/components/grooming-evidence-form.tsx` | **Implemented (`772cb08`)** — two always-visible independently queued "Sebelum"/"Sesudah" upload zones; typecheck/lint/build pass. A fresh live two-zone upload/delete click-through remains unverified. |
| C3 | Evidence history: no cross-job page | `apps/web/src/lib/pilot-data.ts`, `apps/web/src/app/leaderboard/[resourceId]/page.tsx` | **Implemented (`772cb08`)** — prior job photos load and render in the existing groomer performance workflow; typecheck/lint/build pass. Live cross-job fixture inspection remains unverified. |
| C4 | Notes: customer_notes is a fresh free-text field, not sourced from `grooming_jobs.groomer_notes` with an explicit review/copy step | `apps/web/src/components/invoice-customer-notes-editor.tsx`, `apps/web/src/lib/invoice-document.ts` | **Implemented (`772cb08`)** — internal groomer notes are shown separately with an explicit review/copy action into customer-facing invoice notes. A live save plus final-invoice/stale-revision click-through remains unverified; see C5 for final PDF/WhatsApp output. |
| C5 | Document pages: never verified against a real invoice with lines/photos/terms | fixtures + PDF inspection | **Not done this pass** — no code change. Scope: seed or construct a real fixture invoice with lines, a package/prepaid balance, notes, and photos; print/save an actual PDF and inspect page breaks — empty seed invoices are not proof |
| C6 | Auto-visit setting: persists, nothing reads it | `lib/visit-register.ts`, `app/visits/page.tsx` | **Fixed, typecheck/lint-verified** — defined as "automatically include completed bookings in the visit register"; `loadVisitRegister` now takes `autoLogEnabled` and skips the booking-derived projection entirely when off, leaving manual visits and everything else unchanged. Not browser-clicked this pass |
| C7 | Visit invoicing: `invoicedStatus`/`invoiceId` derived from order existence, not a real non-void invoice; pet filter compares names not IDs; 300-row cap | `20261002100000_payment_visit_register_pagination.sql`, `apps/web/src/lib/visit-register.ts`, `apps/web/src/components/visit-register.tsx` | **Implemented and gate/typecheck/lint-verified** — real non-void invoice lookup, pet-ID filter, server-side filters and keyset pagination (`2cdd13e`). Pet-ID URL filtering rendered against real data. Live invoice creation click and >300-row fixture remain unverified. |
| C8 | Package balance: metadata match only, not canonical ledger linkage | `apps/web/src/lib/invoice-document.ts` | **Implemented (`772cb08`)** — source-invoice metadata links the sold entitlement; available balance is calculated from `customer_package_ledger` instead of trusting a point-in-time cached field. Typecheck/lint/build pass; verify the rendered result against a real redeemed/renewed package invoice before claiming document parity. |

### Gate-harness notes (for whoever runs this next)

The mandated PG16 gate suite needed two infrastructure fixes beyond the lineage array, both now folded into the harness script (not yet a permanent repo file — see "next commands" below):
1. **Docker must bind-mount `/tmp:/tmp` in addition to the scratch copy directory.** GATE 8's concurrency case does `mktemp -d /tmp/operro-concurrency.XXXXXX` — a path OUTSIDE the scratch copy — and the wrapped `psql`/`createdb`/`dropdb` run via `docker exec`, which can only see paths actually mounted into the container. Without `-v /tmp:/tmp`, GATE 8 fails with `No such file or directory` for every session script, independent of the actual concurrency logic. Attribution: Engine 1's `engine1-checks.sh` already mounted `/tmp:/tmp` for this exact reason; this was missed when adapting it and cost real debugging time before the log evidence made it obvious.
2. **Lint/test:batch1a/test:batch1b/test:booking must run inside the same WSL/Linux environment as the gate DB**, not from the Windows-side `node_modules` — this branch's Windows-side `node_modules` has a `@esbuild/linux-x64` binary installed (a prior cross-platform install artifact, not something this pass introduced) and fails immediately with a native-binary platform-mismatch error under Windows-side `node`/`tsx`. Running them from the WSL scratch copy (where `npm ci` installs the correct `linux-x64` binaries fresh) avoids this entirely and is what the evidence log actually reflects.

**Exact next commands** to reproduce or extend this evidence (run from `E:\Claude\operro-sections-27-30` in Windows Git Bash; requires Docker available inside the machine's WSL Ubuntu distro). The harness script is saved at `docs/handoffs/logs/S27-S30/closeout/run_gates_harness.sh`:
```bash
MSYS2_ARG_CONV_EXCL="*" wsl.exe -- bash /mnt/e/Claude/operro-sections-27-30/docs/handoffs/logs/S27-S30/closeout/run_gates_harness.sh
```
It re-syncs a fresh scratch copy, runs the full gate+lint+test suite, and overwrites `run_all_gates_full.log` in place — safe to rerun after any further source change.

### Genuinely unfinished after this pass

- **C5 remains unverified:** construct a real invoice with lines, package/terms, notes and photos; save a PDF and inspect content and page breaks. Existing document-page rendering against one real invoice is not this proof.
- **C2/C3/C4/C8 implementation is present**, but their listed live acceptance scenarios still need verification. S1's authenticated Storage HTTP suite passed 23/23.
- **Real two-connection financial concurrency tests** for P1's acceptance criteria (simultaneous same-key sessions, competing payments as overpayment, lost-response recovery) — designed for, not executed.
- **Remaining browser checks:** complete payment confirm/validate and package-sale paths, two-zone evidence upload/delete, cross-job evidence history, note save/copy and WhatsApp output, logo/settings and auto-visit toggles, visit invoice creation, and large-register paging. Payment/proof register filtering, pet-ID URL filtering, and one real invoice-document page were rendered during Engine 2's closeout; these partial checks do not establish the full flows.
- **Second/empty-organization and invalid/foreign-invoice-ID testing** on the new/changed surfaces.
- **Real transfer-upload→screenshot→confirm→validate→locked workflow**, live PDF content inspection, live visit-invoice action click, and small-screen usability — none exercised this pass.
