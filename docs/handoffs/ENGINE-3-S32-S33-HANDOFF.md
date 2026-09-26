# Engine 3 — Sections 32-33 Payroll & Payroll Exports — Handoff

Single entry point for this engine's work. Updated at every checkpoint.

## 1. Scope

- Section 32: payroll engine (cycles, components, tiers, attendance integration, lifecycle, retention, publication).
- Section 33: payroll exports (XLSX, CSV, payslip PDF).
- Explicitly OUT of scope: section 31 capital/cash, section 34 WhatsApp, bank-account settings, invoice PDFs (Engine 2), package renewal, new visit register.

## 2. Base / branch / worktree

- Main repo: `E:\Claude\operro-local-dev` (WSL: `/mnt/e/Claude/operro-local-dev`)
- Base commit verified: `f820b6b904cffd9d7a24af7e395b8effc327fc06` on `local/design-adoption` — "Integrate invoice workflow, size pricing and discounts"
- Worktree: `E:\Claude\operro-payroll-s32-s33` (WSL: `/mnt/e/Claude/operro-payroll-s32-s33`)
- Branch: `claude/sections-32-33-payroll-exports`
- Created: 2026-09-27
- GitHub: https://github.com/wbudiman1995-coder/Operro

Other engines (read-only, do not touch):
- Engine 1: `E:\Claude\operro-review-s23-s26`, branch `claude/sections-23-26-memberships` (sections 23-26)
- Engine 2: `E:\Claude\operro-sections-27-30`, branch `claude/sections-27-30-documents-payments-visits` (sections 27-30)

## 3. Status: IN PROGRESS — reconnaissance phase

Just created worktree. Next action: read HomePaw catalog + existing Operro payroll files (`payroll/page.tsx`, `pilot-data.ts`, `pilot-actions.ts`, payroll migrations, attendance) and build the parity matrix (Section 4 below) before writing any code.

## 4. Parity matrix (HomePaw function/location → Operro implementation → missing delta → UI entry point → test/evidence)

_To be filled in during reconnaissance — do not skip._

| # | HomePaw capability | HomePaw source anchor | Operro current state | Delta | UI entry point | Test/evidence |
|---|---|---|---|---|---|---|
| | | | | | | |

## 5. Calculation contract

_To be written after parity matrix, before money-path code. Must cover: period boundaries/timezone, effective-dated compensation, attendance/waivers, retroactive tiers, canonical service IDs, job/line attribution, transport split, package sale exclusion, single authoritative earning source, rounding, tenant/branch scoping._

## 6. Checkpoints

- [ ] Checkpoint 1: Cycle & calculation (spec, settings UI, cycle nav, calculation engine, fixtures)
- [ ] Checkpoint 2: Controls & snapshots (draft edits, compute/approve/pay/undo, immutable snapshots, retention, security/transaction tests)
- [ ] Checkpoint 3: Publication & exports (groomer access, publish/hide, XLSX/CSV/PDF)
- [ ] Checkpoint 4: Final acceptance (upgrade test, gates, browser E2E, consolidated evidence)

## 7. Dependencies / shared-file edit log

_List any edits to shared pilot-actions/pilot-data/navigation/report files here as they happen, with overlap risk vs Engine 1/2._

## 8. Known gaps / blockers

_None yet — reconnaissance not started._

## 9. Environment identity

- Node/Next: TBD (read `apps/web/AGENTS.md` and package.json)
- Local Supabase Postgres version used for tests: TBD
- Dev port: TBD (must not collide with 54321-54324, 54341-54344 or other engines' dev ports)

## 10. Final delivery (fill in at the end)

- Branch URL: TBD
- Final SHA: TBD
- Absolute handoff path: `E:\Claude\operro-payroll-s32-s33\docs\handoffs\ENGINE-3-S32-S33-HANDOFF.md`
- Section 32 status: TBD
- Section 33 status: TBD
- Material blockers: TBD
