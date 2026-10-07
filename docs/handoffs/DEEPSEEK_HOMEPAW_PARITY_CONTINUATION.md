# DeepSeek handoff — Operro / HomePaw parity continuation

## What to upload with this file

1. This file.
2. `docs/HOMEPAW_PARITY_AUDIT_2026-10-01.md`.
3. `C:\Users\DW_wi\Downloads\index (2).html` (the HomePaw reference), if the agent can accept it. Do not upload credentials, `.env` files, or Supabase service keys.
4. The Operro repository, or give the agent access to `https://github.com/wbudiman1995-coder/Operro.git`.

The repository is currently checked out at `C:\Users\DW_wi\Documents\ChatGPT\Operro`.

## Agent prompt

You are continuing Operro, a multi-tenant Indonesian pet-grooming operations platform. It is a Next.js 16 / React 19 application with Supabase Postgres, Auth, and Storage. Operro is being compared with the supplied HomePaw reference, but HomePaw is a reference rather than permission to replace working Operro subsystems.

Start from Git branch `feat/platform-org-access-qc`, commit `8bef156aa745aa958c329adeae66b2cba7cf0ccf`. Production currently runs code commit `8a4d94f` at `https://operro-web.vercel.app`; commit `8bef156` only clarifies the audit. Create one new isolated branch per coherent batch, prefixed `deepseek/`. Do not edit the base branch directly.

Read `apps/web/AGENTS.md`, this file, and `docs/HOMEPAW_PARITY_AUDIT_2026-10-01.md` before coding. Inspect existing routes, migrations, RPCs, tests, and bounded relevant excerpts of the HomePaw HTML before deciding that a feature is absent. Do not dump the entire HomePaw HTML into context.

Do not deploy Vercel, alter production Supabase, create real invitations or invoices, open a PR, or merge branches. Never use a service-role key in browser code. Never weaken tenant isolation, RLS, immutable invoice/ledger snapshots, or historical booking/package/payroll calculations.

Work one batch at a time. Before code, write a short gap table for only that batch: existing behavior, HomePaw behavior, proposed scope, data/migration impact, and acceptance tests. If an item needs a new cross-module architecture, write the implementation plan and stop; do not disguise a partial UI as a completed feature.

For every change:

- Reuse existing actions/RPCs/components where safe; extend rather than replace.
- New database changes must be forward-only migrations.
- Derive organization and branch access server-side; do not trust browser-provided organization IDs.
- Preserve historical price, duration, service, package, and payroll snapshots.
- Add focused regression tests. Any migration needs fresh and populated-upgrade PostgreSQL 16 testing, including role/RLS assertions when access changes.
- Run focused tests, web typecheck, lint, and one production build at the end of the batch. Record raw results.
- Write/update a handoff in `docs/handoffs/`, then commit only the isolated branch.

## Current, authoritative product state

The parity audit currently reports **28 implemented, 13 partial, and 3 missing**. “Implemented” means code and automated evidence exist; it does not mean every live owner workflow has passed QC.

Implemented domains already include scheduling, booking, recurring appointments, routing, availability, groomer workflows, attendance, payroll, complaints, customer/service invoices, discounts, packages, invoice documents, photos, payment control, visits, retention/renewal, and several exports. Do not rebuild them without finding a real gap.

The current platform owner (`wbudiman1995@gmail.com`) is intentionally a superuser: it can identify a business owner, enter a business workspace (including a suspended business), and inspect/change that business's Admin-permission checklist. A tenant Admin cannot manage the checklist. The `Bantuan Operro` support role remains restricted, including from payroll. This supersedes an older prompt that required the platform owner to be excluded from the checklist.

## Unfinished parity backlog

| # | Area | Existing state | Required remaining outcome | Size / dependency |
|---|---|---|---|---|
| 1 | Dashboard analytics | Dashboard exists. | Add period comparison, configurable cards, and acquisition-source ROI only after locating HomePaw behavior/data sources. | Medium/Large; do not invent an analytics engine. |
| 2 | Customer CRM | Customer list, search/filter/sort, onboarding, eight-sheet XLSX export. | Bulk edit plus a persistent customer code; live permission/data QC for export. | Medium. |
| 3 | Customer 360 | Address, pets, history, invoices, packages. | Safe editing and any supported custom-field display. | Medium; coordinate with #40. |
| 4 | Pet database | Multi-pet intake and weight/size logic. | Standalone pet CRUD, coat profile, wash counter. | Medium; preserve invoice/booking snapshots. |
| 21 | Catalog / price | XS/S/M/L/XL boundaries, per-size price/duration, service categories, custom pet-type pricing. | Dynamic tenant-owned size bands: create/rename/archive/delete bands such as XXL safely. Migrate existing bands; use new keys in catalog pricing, booking, package eligibility, and payroll; retain historical snapshots; refuse deletion when live dependencies exist. | Large; foundational. Do not add a cosmetic add/delete control without changing authoritative calculations. |
| 31 | Financial operations | Payment register, expenses/refunds. | Capital/cash-on-hand workflow and complete finance export suite. A finance XLSX export was built but is isolated on `claude/parity-ops-quickwins`, not integrated. Review/cherry-pick only if it fits the current access model. | Medium/Large. |
| 34 | WhatsApp center | Invoice/follow-up `wa.me` drafts and templates. | Decide whether HomePaw actually has more than per-record drafts. If unified batch messaging/delivery logging is requested, scope it as a new product capability with consent, delivery state, rate limits, and audit trail. | Large; no automatic sending without explicit product decision. |
| 36 | Audit history | Timeline/audit data exists. | Complete labels and cross-entity review UI. Audit labels for invoice detail were built but are isolated on `claude/parity-ops-quickwins`, not integrated. | Medium. |
| 37 | Operational reconciliation | Package/session reconciliation only. | Unified read-only discrepancy view for completed visits without valid invoices, issued invoices with unmatched payments, and published payroll whose sources were voided/missing. Never auto-repair financial history. | Large; direct, tenant-scoped source queries; manual review first. |
| 38 | Export / ownership | CRM eight-sheet XLSX, payroll XLSX/CSV, complaints CSV. | Organization-wide backup including configuration and actual storage files, with a restore drill on an empty migrated project. | Large; do not claim backup until restore is proven. |
| 39 | Business configuration | Branding, banks, service areas, access controls. | Expose remaining validated settings such as dashboard-card visibility, notification duration, auto-log visit, and template configuration, based on actual existing data model. | Small/Medium per setting. |
| 40 | Custom fields | Metadata can store extensions. | Owner-configurable customer/pet field definitions and safe editor/display. | Large; schema/versioning/privacy/search/export decisions required. Do not build a generic framework in a quick pass. |
| 41 | Accounts / permissions | Invitations, business owner/Admin controls, groomer accounts, platform-owner workspace switching. | Complete live multi-organization invite/role QC. Preserve the current superuser rule above and ensure support never receives payroll/finance reporting/access-management capabilities. | QC + Medium if a real RLS gap is found. |
| 42 | Personal preferences | No preference surface. | Per-user landing page, calendar/dashboard defaults, and language preferences. | Medium; preference rows must be user- and tenant-safe. |
| 43 | Storage / maintenance | Per-org file meter; whole-project DB/file meter; cleanup and manual capacity requests. | Per-org database-byte accounting, scheduled cleanup, and billing automation. Clearly distinguish app estimates from provider billing. | Large; database bytes need a carefully secured server-side calculation. |
| 44 | Reliability / safeguards | RLS, audit, snapshots, migrations, test gates. | Monitoring/recovery UI and completed real-world workflow QC. | Medium/Large; define alerts, ownership, retention, recovery runbooks, and acceptance exercises before building UI. |

## Non-backlog acceptance/QC that must not be forgotten

Before representing Operro as full HomePaw parity, perform or prepare documented manual checks for:

1. Fresh owner invitation claimed by an independent email; wrong email cannot claim it; accepted membership persists until suspended.
2. Platform owner can identify an owner, switch workspace, and manage the Admin checklist; tenant Admin cannot. Support cannot access payroll.
3. Custom pet type and service category persist through public registration, approval, Customer 360, booking, invoice pricing, and duration.
4. Both CRM exports contain only active-organization data; formula-like values beginning `=`, `+`, `-`, or `@` stay literal text.
5. Platform billing: create period/amount/due date, issue invoice, PDF, owner view, paid lock, and suspended-business behavior.
6. Service invoices: unbilled manual visits can be searched by owner/customer and invoiced. Current manual-visit billing is one description and amount; a flexible multi-line editor is still a known parity limitation.
7. Existing payment confirmation/validation, proof uploads, grooming evidence upload/delete, document notes/WhatsApp output, visit invoices, and large payment-register paging need real browser click-through evidence where not already verified.

## Suggested execution order

1. **Reconnaissance and branch hygiene:** verify the base branch, compare `claude/parity-ops-quickwins` against it, and decide whether finance export/audit labels can be safely integrated. Do not merge merely because code exists.
2. **Customer batch:** #2–#4 only, beginning with persistent customer code and the smallest safe Customer 360/pet editing improvements. Write the #40 architecture plan rather than building it unless the schema decision is explicitly approved.
3. **Configuration/preferences batch:** #39 and #42, only after confirming which settings already have authoritative persisted fields.
4. **Dynamic size-band design batch:** #21 design, migration plan, dependency inventory, and compatibility tests before implementation. This affects financial calculations and should not be bundled with unrelated work.
5. **Operational batch:** #31, #36, and #37, starting with safe exports/audit surfaces, then a read-only reconciliation design.
6. **Platform resilience batch:** #38, #41, #43, #44. Begin with recovery/backup design and runnable QC; do not ship claims of provider-cost accuracy or recoverability without proof.
7. **Dashboard and messaging:** #1 and #34 after product decisions on ROI definitions and communications policy.

## Existing evidence to read before modifying related areas

- `docs/HOMEPAW_PARITY_AUDIT_2026-10-01.md` — current 44-section status.
- `docs/handoffs/PARITY-OPS-QUICKWINS.md` on branch `claude/parity-ops-quickwins` — finance export/audit label implementation and its limitations.
- `docs/handoffs/S23-S26-HANDOFF.md` — packages/memberships/reconciliation invariants.
- `docs/handoffs/S27-S30-HANDOFF.md` — invoice documents, payments, visits, evidence, and remaining browser checks.
- `docs/handoffs/ENGINE-3-S32-S33-HANDOFF.md` — payroll immutable snapshot and export constraints.
- `docs/handoffs/S35-HANDOFF.md` — retention/renewal authorization and tenant isolation constraints.
- `docs/handoffs/PLATFORM-ACCESS-QC-HANDOFF.md` — historical platform access design. Treat it as superseded where it conflicts with the current superuser rule above.

## Required end-of-batch handoff format

For each batch create `docs/handoffs/DEEPSEEK-<BATCH>-HANDOFF.md` containing:

- Base commit and branch name.
- Exact audit sections reviewed and their honest statuses.
- Existing behavior verified before changes.
- Changes made, migrations/RPCs/actions/components touched, and why existing systems were reused.
- Deferred work, with dependencies, effort/risk, data sources, and concrete acceptance tests.
- Raw test/typecheck/lint/build/database results.
- Browser-tested versus not tested.
- Security and multi-organization checks performed.
- The next smallest safe task.

Do not say “complete” because a route renders, compiles, or a static test passes. Commit and push only the isolated branch after the handoff is written.
