# HomePaw to Operro parity audit: proposal after the final closeout (12 October 2026)

This is a **proposal for the owner and Codex to review**, not an accepted status. It supersedes nothing until it is accepted. Evidence is local only (PostgreSQL 16 gates, a populated-upgrade rehearsal, the web suite and a private local Supabase stack); no hosted staging, real Storage, provider or mail test took place. Definitions are those of [HOMEPAW_PARITY_AUDIT_2026-10-01.md](HOMEPAW_PARITY_AUDIT_2026-10-01.md): **Implemented** means a real route/RPC and tests exist and does not mean the owner's live workflow passed QC; **Partial** means working pieces exist but an important HomePaw behavior is absent; **Missing** means no usable surface.

## Count

- **In scope of this program (8 rows: #1, #31, #34, #38, #39, #41, #43, #44):** proposed **0 Implemented, 8 Partial, 0 Missing**. Every one moved forward; none is proposed as Implemented on local evidence alone.
- **Owner-acceptance candidates (2):** #39 and #41, each only after the named action in its rationale below.
- **The other 36 rows** are carried from the accepted baseline at `33fcad3`, which the brief states already contains dynamic size bands, organization export verification, custom fields, coat profiles, finance cash position, WhatsApp drafts, audit and reconciliation, storage cleanup and health, and the performance dashboard, and which names exactly these eight rows as the ones still Partial. I did not re-audit them and I did not touch their status: **36 Implemented** as accepted by the owner's map. The 1 October count (29 / 12 / 3) is stale and should not be reused.
- **Proposed overall: 36 Implemented, 8 Partial, 0 Missing**, which is not full parity.

## Rows in scope

| # | Capability | Proposed | What changed | Why not Implemented (and what would change that) |
|---|---|---|---|---|
| 1 | Dashboard analytics | Partial | Five bounded operational alerts (unbilled completed visits, overdue invoices per currency, packages expiring in 7 days, open bookings older than 24 h, owner-only maintenance problems), each with its measure stated and one authorized link; optional card key; denied alerts issue no query. | Source ROI is absent by design: no tenant-owned marketing-spend model exists and attribution would be a guess. Owner decision: who records spend, per source, period and branch. Without it ROI must stay "unavailable". |
| 31 | Financial operations | Partial | Cash-control register: accounts and immutable declared movements, reversal-only correction, per-account per-currency position, reference links, audited permissions; finance export now includes the register. Bounded, formula-safe export. | It is not a ledger: payments, refunds, expenses and payroll do not post to it. HomePaw's "Kas tersedia" needs owner decisions on payment-to-account mapping, payroll payout recording and bank reconciliation. |
| 34 | WhatsApp center | Partial | Manual batch workflow over drafts (preview, eligibility, dedupe, 25 per batch, cancel), append-only event log of user-reported outcomes, batch history. | No delivered/read status exists and none is claimed. It needs an official provider with credentials, customer consent, a webhook and staging. |
| 38 | Export / ownership | Partial | Deterministic reviewed scope (59 tables, configuration, Storage metadata; 38 other tenant tables listed with reasons), retention and purge, recorded verification, offline dry-run restore-readiness planner, drill runbook and evidence template. | Still an archive, not a backup: no object bodies, no Auth data. No importer and no restore drill has been performed or recorded. Owner decision: whether to build an importer and who runs the disposable drill. |
| 39 | Business configuration | Partial (candidate for Implemented) | Every HomePaw configuration key mapped to its Operro home or marked unmapped on screen; new typed, concurrency-safe, audited write path for branch calendar hours. No generic editor. | Three HomePaw settings are not adopted: `sourceLabels`, `dueDayDefault`, organization currency (the last is deliberately immutable). Accept as Implemented if the owner declines the first two as features. |
| 41 | Accounts / permissions | Partial (candidate for Implemented) | 57-assertion role test of the invitation claim and refusals; truthful error messages; local browser check of wrong-user refusal, recipient claim and tenant Admin denial; staging QC script. | A real invitation and multi-organization flow on hosted staging has not run. Accept after `docs/runbooks/STAGING_ACCESS_QC.md` is executed and recorded by the owner. |
| 43 | Storage / maintenance | Partial | Disabled, owner-controlled, audited consent record for unattended cleanup; operator runbook. | No scheduler or service identity exists in the repository, so no unattended run exists. Owner decision: which scheduler, and how a runner authenticates and is bound to an opted-in organization. Meters remain provider-agnostic, not billing facts. |
| 44 | Reliability / safeguards | Partial | Health signals backed by real records (archive freshness, verification, purge candidates, cleanup consent) with named owner actions; restore-drill checklist and evidence format; schema version contract kept honest. | No provider backup status is read, and no restore drill has been recorded. Needs a hosted staging or disposable-project drill with evidence filed. |

## Rows carried from the accepted baseline (not re-audited)

Rows #2 to #30, #32, #33, #35 to #37, #40 and #42 are carried as **Implemented** per the owner's accepted map at `33fcad3` (the 1 October table, plus the later work the brief lists). #3, #4, #21, #36, #37, #40 and #42 were Partial or Missing on 1 October and are treated as accepted-Implemented only because the brief names the work that closed them. Their live-workflow QC items from the 1 October "owner QC priorities" are unchanged and still apply.

## What must not be said

- Do not say "full parity" or "backup and restore". The export is an archive and no restore occurred.
- Do not say WhatsApp messages were delivered or read; the statuses are user reports.
- Do not call the cash register profit, accounting or cash on hand.
- Do not describe unattended cleanup as scheduled; consent can be recorded but nothing runs.
