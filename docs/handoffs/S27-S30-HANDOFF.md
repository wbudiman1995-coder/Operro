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

A review of the draft migrations (recorded 2026-09-26) found real gaps before the backend can be called ready. Tracked here with fix status; each is fixed with its own test before being marked done.

| # | Finding | Fix status |
|---|---|---|
| 1 | `record_payment` idempotency race: two concurrent identical requests can both pass the request_key pre-check before either locks the invoice | **Open** |
| 2 | Idempotent-retry branch check happens before the existing-row return, so a revoked branch grant isn't re-verified on retry | **Open** |
| 3 | Proof-attachment linkage only checks org/deleted_at, not that the attachment actually belongs to this invoice/customer/purpose | **Open** |
| 4 | Old `recordPaymentAction` in `pilot-actions.ts` still inserts into `payments` directly, bypassing the new RPC/stage/idempotency entirely | **Open** |
| 5 | Migration defaults every historical payment's `payment_stage` to `bank_validated`, which asserts a bank check that was never actually performed | **Open** |
| 6 | `record_payment` marks the invoice `paid` and then writes `overpaid_amount` into `invoices.metadata` in the same flow that must survive `tg_invoices_freeze` — needs a checked scenario, not an assumption | **Open** |
| 7 | New-organization/new-role provisioning path for the new permissions (`payment.validate`, `evidence.read_all`) not yet verified — only the populated-upgrade backfill was tested | **Open** |

## 6. Milestone status

- [ ] **M0 — Preserve + handoff** (this commit): checkpoint committed, handoff created, smoke fragments consolidated into a permanent test.
- [ ] **M1 — Section 30 visits**: backend hardening + frontend register/filter UI.
- [ ] **M2 — Section 29 payments**: backend fixes (§5) + frontend stage UI, forms wired to RPC.
- [ ] **M3 — Section 28 evidence**: frontend multi-upload/paste/drop + verified Storage/RLS.
- [ ] **M4 — Section 27 documents**: frontend branding/bank-account settings, invoice preview/PDF/WhatsApp.
- [ ] **Final verification**: full gate suite (PG16), browser flows, multi-role/concurrency evidence.

## 7. Concrete remaining checklist

- [ ] Consolidate `.holdback/smoke*.sql` into `supabase/tests/S27-S30/` as one reproducible integration test with documented fixture prerequisites; run start-to-finish with `ON_ERROR_STOP` and no skipped prefix.
- [ ] Fix backend items 1–7 in §5, each with a passing regression case.
- [ ] Stand up a plain PostgreSQL 16 container for `run_all_gates.sh` (distinct port from everything above); run it and record exit codes.
- [ ] `npm run typecheck` / `npm run lint` / `npm run build` on this branch; record exit codes.
- [ ] Frontend for all four sections (see Milestones).
- [ ] Real browser verification: document preview/download/WhatsApp draft, evidence upload, payment stage checks, visit workflow — screenshots + console/network logs under `docs/handoffs/logs/S27-S30/`.
- [ ] Multi-role tests as actual authenticated roles (owner, read-only member, assigned groomer, unassigned groomer, cross-org member).
- [ ] Concurrency tests: two simultaneous payment sessions, retry-after-catalog-change, stale revision, permission revoked before retry.
- [ ] Second/empty organization: honest empty states, no crash, no borrowed demo data.

## 8. Commits on this branch (append after each milestone)

| SHA | Summary |
|---|---|
| `d2c88e2` | WIP checkpoint: draft backend migrations preserved (unreviewed) |

## 9. Overlap / dependency notes with sections 23–26

No table or RPC added here is touched by the sections 23–26 branch's known review items (membership renewal/reconciliation). `payments`, `invoices`, `attachments` are shared surfaces — sections 23-26 does not alter their schemas per its own handoff. Combined-branch validation is still required before either branch is considered mergeable; neither branch is approved for integration yet.

## 10. Owner QC checklist

*(To be filled in once frontend exists — placeholder removed at that point.)*
